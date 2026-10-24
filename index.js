
"use strict";

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder
} = require("discord.js");

/* =========================================================
   CONFIGURATION
========================================================= */

const REQUIRED = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "SESSION_SECRET",
  "DATABASE_URL"
];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

if (process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 10000);
const OWNER_ID = process.env.OWNER_DISCORD_ID || "";
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable"
    ? false
    : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

pool.on("error", error => {
  console.error("PostgreSQL pool error:", error.message);
});

const app = express();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let shuttingDown = false;

/* =========================================================
   EXPRESS SECURITY
========================================================= */

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: [
        "'self'",
        "https://cdn.discordapp.com",
        "https://media.discordapp.net",
        "data:"
      ],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

app.use(express.json({ limit: "32kb" }));

app.use(session({
  name: "nexusguard.sid",
  secret: process.env.SESSION_SECRET,
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use("/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS audit_guild_time
      ON audit_log (guild_id, created_at DESC);
  `);

  console.log("PostgreSQL connected; database tables ready.");
}

function defaultSettings() {
  return {
    welcomeEnabled: false,
    logsEnabled: true,
    automodEnabled: false,
    welcomeChannel: "",
    logChannel: "",
    moderatorRole: ""
  };
}

async function getSettings(guildId) {
  const result = await pool.query(
    "SELECT settings FROM guild_settings WHERE guild_id = $1",
    [guildId]
  );

  return {
    ...defaultSettings(),
    ...(result.rows[0]?.settings || {})
  };
}

async function saveSettings(guildId, settings) {
  await pool.query(`
    INSERT INTO guild_settings
      (guild_id, settings, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET
      settings = EXCLUDED.settings,
      updated_at = NOW()
  `, [guildId, JSON.stringify(settings)]);
}

async function audit(
  guildId,
  actorId,
  action,
  targetId = null,
  details = {}
) {
  if (!guildId || !actorId) return;

  await pool.query(`
    INSERT INTO audit_log
      (guild_id, actor_id, action, target_id, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [
    guildId,
    actorId,
    action,
    targetId,
    JSON.stringify(details)
  ]);
}

/* =========================================================
   SLASH COMMAND DEFINITIONS
========================================================= */

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check NexusGuard's response time"),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View information about this server"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View a member's public information")
    .addUserOption(option =>
      option
        .setName("member")
        .setDescription("Member to inspect")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Record a moderation warning")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    )
    .addUserOption(option =>
      option
        .setName("member")
        .setDescription("Member to warn")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("reason")
        .setDescription("Reason for the warning")
        .setRequired(true)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Temporarily timeout a member")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    )
    .addUserOption(option =>
      option
        .setName("member")
        .setDescription("Member to timeout")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("minutes")
        .setDescription("Duration in minutes")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(40320)
    )
    .addStringOption(option =>
      option
        .setName("reason")
        .setDescription("Reason for timeout")
        .setRequired(false)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("View this server's NexusGuard settings")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
].map(command => command.toJSON());

/* =========================================================
   COMMAND REGISTRATION
========================================================= */

async function registerCommands() {
  const rest = new REST({ version: "10" })
    .setToken(BOT_TOKEN);

  console.log("Registering NexusGuard slash commands...");

  const result = await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );

  console.log(
    `Successfully registered ${result.length} global slash commands.`
  );

  console.log(
    "Global commands may take a little while to appear in Discord."
  );
}

/* =========================================================
   DISCORD BOT EVENTS
========================================================= */

client.once("ready", () => {
  console.log(`Discord bot connected as ${client.user.tag}`);
  console.log(`Connected to ${client.guilds.cache.size} server(s).`);

  client.user.setActivity("protecting your communities");
});

client.on("guildCreate", async guild => {
  console.log(`Joined server: ${guild.name} (${guild.id})`);

  try {
    await saveSettings(guild.id, await getSettings(guild.id));
  } catch (error) {
    console.error("Guild setup failed:", error.message);
  }
});

client.on("guildDelete", guild => {
  console.log(`Removed from server: ${guild.name} (${guild.id})`);
});

/* =========================================================
   COMMAND PERMISSION HELPERS
========================================================= */

async function checkModerator(interaction) {
  if (!interaction.inGuild()) return false;

  const member = await interaction.guild.members.fetch(
    interaction.user.id
  );

  return member.permissions.has(
    PermissionFlagsBits.ModerateMembers
  );
}

async function replyError(interaction, message) {
  const response = {
    content: message,
    ephemeral: true
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(response).catch(() => {});
  } else {
    await interaction.reply(response).catch(() => {});
  }
}

/* =========================================================
   COMMAND HANDLERS
========================================================= */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const command = interaction.commandName;

    if (command === "ping") {
      return interaction.reply({
        content:
          `🏓 Pong! WebSocket latency: ${client.ws.ping}ms`,
        ephemeral: true
      });
    }

    if (command === "serverinfo") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "Use this command inside a server.",
          ephemeral: true
        });
      }

      const guild = interaction.guild;

      const embed = new EmbedBuilder()
        .setColor(0x9d70ff)
        .setTitle(guild.name)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
          {
            name: "Server ID",
            value: guild.id,
            inline: true
          },
          {
            name: "Members",
            value: String(guild.memberCount ?? "Unknown"),
            inline: true
          },
          {
            name: "Created",
            value: `<t:${Math.floor(
              guild.createdTimestamp / 1000
            )}:D>`
          }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (command === "userinfo") {
      const user =
        interaction.options.getUser("member") ||
        interaction.user;

      const embed = new EmbedBuilder()
        .setColor(0x51e1e5)
        .setTitle(user.username)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          {
            name: "User ID",
            value: user.id
          },
          {
            name: "Account created",
            value: `<t:${Math.floor(
              user.createdTimestamp / 1000
            )}:F>`
          }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (command === "warn") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "Use this command inside a server.",
          ephemeral: true
        });
      }

      if (!(await checkModerator(interaction))) {
        return interaction.reply({
          content: "You need the Moderate Members permission.",
          ephemeral: true
        });
      }

      const user = interaction.options.getUser("member", true);
      const reason = interaction.options.getString("reason", true);

      await audit(
        interaction.guildId,
        interaction.user.id,
        "member.warned",
        user.id,
        { reason }
      );

      return interaction.reply({
        content: `⚠️ ${user.username} has been warned.\nReason: ${reason}`,
        allowedMentions: { parse: [] }
      });
    }

    if (command === "timeout") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "Use this command inside a server.",
          ephemeral: true
        });
      }

      if (!(await checkModerator(interaction))) {
        return interaction.reply({
          content: "You need the Moderate Members permission.",
          ephemeral: true
        });
      }

      const user = interaction.options.getUser("member", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const reason =
        interaction.options.getString("reason") ||
        "No reason supplied";

      const target = await interaction.guild.members.fetch(user.id);
      const botMember = await interaction.guild.members.fetchMe();

      if (!botMember.permissions.has(
        PermissionFlagsBits.ModerateMembers
      )) {
        return interaction.reply({
          content: "NexusGuard needs the Moderate Members permission.",
          ephemeral: true
        });
      }

      if (!target.moderatable) {
        return interaction.reply({
          content:
            "I cannot timeout this member. Check role hierarchy and permissions.",
          ephemeral: true
        });
      }

      await target.timeout(minutes * 60 * 1000, reason);

      await audit(
        interaction.guildId,
        interaction.user.id,
        "member.timed_out",
        user.id,
        { minutes, reason }
      );

      return interaction.reply({
        content:
          `⏱️ ${user.username} was timed out for ${minutes} minute(s).`,
        allowedMentions: { parse: [] }
      });
    }

    if (command === "settings") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "Use this command inside a server.",
          ephemeral: true
        });
      }

      const settings = await getSettings(interaction.guildId);

      return interaction.reply({
        content:
          "```json\n" +
          JSON.stringify(settings, null, 2) +
          "\n```",
        ephemeral: true
      });
    }
  } catch (error) {
    console.error(
      `Command ${interaction.commandName} failed:`,
      error
    );

    await replyError(
      interaction,
      "The command failed. Check the Render logs for details."
    );
  }
});

/* =========================================================
   AUTHENTICATION HELPERS
========================================================= */

function isOwner(userId) {
  return Boolean(OWNER_ID) && userId === OWNER_ID;
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please sign in with Discord first."
    });
  }

  next();
}

function discordGuildPermissions(guild) {
  const permissions = BigInt(guild.permissions || "0");

  const administrator =
    (permissions & PermissionFlagsBits.Administrator) !== 0n;

  const manageGuild =
    (permissions & PermissionFlagsBits.ManageGuild) !== 0n;

  return administrator || manageGuild || guild.owner === true;
}

async function getManageableGuilds(user) {
  const response = await fetch(
    "https://discord.com/api/v10/users/@me/guilds",
    {
      headers: {
        Authorization: `Bearer ${user.accessToken}`
      }
    }
  );

  if (response.status === 401) {
    throw new Error("Your Discord login expired. Sign in again.");
  }

  if (!response.ok) {
    throw new Error("Unable to retrieve your Discord servers.");
  }

  const guilds = await response.json();

  const manageable = guilds.filter(guild =>
    discordGuildPermissions(guild) || isOwner(user.id)
  );

  return manageable.filter(guild =>
    client.guilds.cache.has(guild.id)
  );
}

async function requireGuildAccess(req, res, next) {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        error: "Please sign in first."
      });
    }

    const guildId = req.params.guildId;
    const guilds = await getManageableGuilds(req.session.user);

    if (!guilds.some(guild => guild.id === guildId)) {
      return res.status(403).json({
        error:
          "You cannot manage this server, or NexusGuard is not installed there."
      });
    }

    req.guildId = guildId;
    next();
  } catch (error) {
    next(error);
  }
}

function safeError(res, error) {
  console.error("Request error:", error);

  if (res.headersSent) return;

  res.status(500).json({
    error: "An internal error occurred. Check the service logs."
  });
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      botReady: client.isReady(),
      connectedGuilds: client.guilds.cache.size,
      database: "connected",
      uptimeSeconds: Math.floor(process.uptime())
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      status: "unhealthy",
      botReady: client.isReady(),
      database: "unavailable"
    });
  }
});

/* =========================================================
   DISCORD OAUTH LOGIN
========================================================= */

app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(32).toString("hex");

  req.session.oauthState = state;

  req.session.save(error => {
    if (error) return safeError(res, error);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "identify guilds",
      state
    });

    res.redirect(
      `https://discord.com/oauth2/authorize?${params.toString()}`
    );
  });
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect("/?login=cancelled");
    }

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !req.session.oauthState ||
      state !== req.session.oauthState
    ) {
      return res.status(400).send(
        "Invalid sign-in state. Please return to NexusGuard and try again."
      );
    }

    delete req.session.oauthState;

    const tokenResponse = await fetch(
      "https://discord.com/api/v10/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error("Discord rejected the OAuth token exchange.");
    }

    const profileResponse = await fetch(
      "https://discord.com/api/v10/users/@me",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const profile = await profileResponse.json();

    if (!profileResponse.ok || !profile.id) {
      throw new Error("Unable to retrieve Discord profile.");
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    req.session.user = {
      id: profile.id,
      username: profile.username,
      globalName: profile.global_name || profile.username,
      avatar: profile.avatar || null,
      accessToken: tokenData.access_token
    };

    await new Promise((resolve, reject) => {
      req.session.save(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    res.redirect("/");
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res.redirect("/?login=failed");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) return safeError(res, error);

    res.clearCookie("nexusguard.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    res.json({ ok: true });
  });
});

/* =========================================================
   DASHBOARD API
========================================================= */

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.json({ authenticated: false });
  }

  const {
    id,
    username,
    globalName,
    avatar
  } = req.session.user;

  res.json({
    authenticated: true,
    user: { id, username, globalName, avatar },
    owner: isOwner(id)
  });
});

app.get("/api/guilds", requireLogin, async (req, res, next) => {
  try {
    const guilds = await getManageableGuilds(req.session.user);

    res.json(guilds.map(guild => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      botInstalled: true
    })));
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/guild/:guildId",
  requireLogin,
  requireGuildAccess,
  async (req, res, next) => {
    try {
      const guild = client.guilds.cache.get(req.guildId);

      if (!guild) {
        return res.status(404).json({
          error: "NexusGuard is no longer in this server."
        });
      }

      const settings = await getSettings(req.guildId);

      res.json({
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount ?? null,
        settings
      });
    } catch (error) {
      next(error);
    }
  }
);

app.put(
  "/api/guild/:guildId/settings",
  requireLogin,
  requireGuildAccess,
  async (req, res, next) => {
    try {
      const current = await getSettings(req.guildId);
      const body = req.body || {};

      const allowedKeys = [
        "welcomeEnabled",
        "logsEnabled",
        "automodEnabled",
        "welcomeChannel",
        "logChannel",
        "moderatorRole"
      ];

      const changedKeys = [];

      for (const key of allowedKeys) {
        if (!(key in body)) continue;

        if ([
          "welcomeEnabled",
          "logsEnabled",
          "automodEnabled"
        ].includes(key)) {
          if (typeof body[key] !== "boolean") {
            return res.status(400).json({
              error: `${key} must be true or false.`
            });
          }
        } else if (
          typeof body[key] !== "string" ||
          body[key].length > 30
        ) {
          return res.status(400).json({
            error: `${key} must be a short string.`
          });
        }

        current[key] = body[key];
        changedKeys.push(key);
      }

      await saveSettings(req.guildId, current);

      await audit(
        req.guildId,
        req.session.user.id,
        "settings.updated",
        null,
        { changedKeys }
      );

      res.json({ ok: true, settings: current });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/guild/:guildId/logs",
  requireLogin,
  requireGuildAccess,
  async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, actor_id, action, target_id, details, created_at
        FROM audit_log
        WHERE guild_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `, [req.guildId]);

      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  }
);

app.get("/api/owner/stats", requireLogin, async (req, res, next) => {
  try {
    if (!isOwner(req.session.user.id)) {
      return res.status(403).json({
        error: "Owner access required."
      });
    }

    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM guild_settings) AS configured_servers,
        (SELECT COUNT(*) FROM audit_log) AS audit_events
    `);

    res.json({
      botReady: client.isReady(),
      connectedGuilds: client.guilds.cache.size,
      ...result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   WEBSITE
========================================================= */

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#100d1b">
<title>NexusGuard — Control Center</title>
<style>
:root {
  color-scheme: dark;
  --bg: #100d1b;
  --panel: #1b1629;
  --line: #342847;
  --text: #f8f5ff;
  --muted: #aaa0bc;
  --purple: #9d70ff;
  --cyan: #51e1e5;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px system-ui, -apple-system, sans-serif;
}
header {
  padding: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--line);
}
.brand { font-weight: 900; letter-spacing: 1px; }
.brand span { color: var(--purple); }
main { max-width: 1000px; margin: auto; padding: 24px 16px; }
h1 { font-size: clamp(27px, 6vw, 42px); margin-bottom: 8px; }
p { color: var(--muted); line-height: 1.6; }
button, a.button {
  border: 0;
  border-radius: 12px;
  padding: 12px 16px;
  background: var(--purple);
  color: white;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  display: inline-block;
}
.secondary {
  background: var(--panel);
  border: 1px solid var(--line);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
  gap: 14px;
  margin-top: 22px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 18px;
  margin-top: 14px;
}
select, input:not([type=checkbox]) {
  width: 100%;
  padding: 12px;
  margin: 8px 0;
  background: var(--bg);
  color: white;
  border: 1px solid var(--line);
  border-radius: 10px;
}
label { display: block; margin-top: 14px; color: var(--muted); }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.hidden { display: none !important; }
.status { color: var(--cyan); }
.small { font-size: 13px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
@media(max-width:480px) {
  header { padding: 15px; }
  main { padding: 20px 12px; }
  .row button { flex: 1; }
}
</style>
</head>
<body>
<header>
  <div class="brand">🛡️ NEXUS<span>GUARD</span></div>
  <span class="small">CONTROL CENTER</span>
</header>

<main>
  <section id="welcome">
    <p class="status">● COMMUNITY MANAGEMENT PLATFORM</p>
    <h1>Your server. Your control.</h1>
    <p>Manage your Discord communities with NexusGuard moderation tools and security settings.</p>
    <a class="button" href="/auth/login">Sign in with Discord</a>
    <p id="loginError" class="small"></p>
  </section>

  <section id="dashboard" class="hidden">
    <h1 id="greeting">Dashboard</h1>
    <p>Select a server to manage its NexusGuard configuration.</p>

    <div class="card">
      <label for="guilds">Your manageable servers</label>
      <select id="guilds">
        <option value="">Loading servers…</option>
      </select>
      <div class="row">
        <button id="load">Open server</button>
        <button id="logout" class="secondary">Sign out</button>
      </div>
      <p class="small">Only servers you can manage and where NexusGuard is installed are shown.</p>
    </div>

    <div id="serverPanel" class="hidden">
      <div class="grid">
        <div class="card">
          <h3>Server overview</h3>
          <p id="overview"></p>
        </div>
        <div class="card">
          <h3>Protection settings</h3>
          <p>Configure the settings stored for this server.</p>
        </div>
      </div>

      <div class="card">
        <label><input type="checkbox" id="welcomeEnabled"> Enable welcome messages</label>
        <label><input type="checkbox" id="logsEnabled"> Enable audit logging</label>
        <label><input type="checkbox" id="automodEnabled"> Enable AutoMod setting</label>

        <label for="welcomeChannel">Welcome channel ID</label>
        <input id="welcomeChannel" maxlength="30" placeholder="Discord channel ID">

        <label for="logChannel">Log channel ID</label>
        <input id="logChannel" maxlength="30" placeholder="Discord channel ID">

        <label for="moderatorRole">Moderator role ID</label>
        <input id="moderatorRole" maxlength="30" placeholder="Discord role ID">

        <div class="row">
          <button id="save">Save settings</button>
        </div>
        <p id="message" role="status"></p>
      </div>

      <div class="card">
        <h3>Recent audit events</h3>
        <button id="logs" class="secondary">Load audit log</button>
        <pre id="logOutput"></pre>
      </div>
    </div>

    <div id="ownerPanel" class="card hidden">
      <h3>Owner controls</h3>
      <p>Global platform statistics for the configured owner account.</p>
      <button id="ownerStats" class="secondary">Load global statistics</button>
      <pre id="stats"></pre>
    </div>
  </section>
</main>

<script>
const $ = id => document.getElementById(id);
let selected = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed (" + response.status + ")");
  }

  return data;
}

async function start() {
  const params = new URLSearchParams(location.search);

  if (params.has("login")) {
    $("loginError").textContent =
      params.get("login") === "failed"
        ? "Sign-in failed. Check your OAuth settings and Render logs."
        : "Sign-in was cancelled. You can try again.";

    history.replaceState({}, "", "/");
  }

  try {
    const me = await api("/api/me");

    if (!me.authenticated) return;

    $("welcome").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
    $("greeting").textContent = "Welcome, " + me.user.globalName;

    if (me.owner) {
      $("ownerPanel").classList.remove("hidden");
    }

    const guilds = await api("/api/guilds");
    $("guilds").replaceChildren();

    if (!guilds.length) {
      $("guilds").add(
        new Option("No manageable servers with NexusGuard installed", "")
      );
    }

    for (const guild of guilds) {
      $("guilds").add(new Option(guild.name, guild.id));
    }
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

$("load").onclick = async () => {
  selected = $("guilds").value;
  if (!selected) return;

  try {
    const data = await api("/api/guild/" + selected);

    $("serverPanel").classList.remove("hidden");
    $("overview").textContent =
      data.name + " · " + (data.memberCount ?? "Unknown") + " members";

    for (const key of [
      "welcomeEnabled",
      "logsEnabled",
      "automodEnabled"
    ]) {
      $(key).checked = Boolean(data.settings[key]);
    }

    for (const key of [
      "welcomeChannel",
      "logChannel",
      "moderatorRole"
    ]) {
      $(key).value = data.settings[key] || "";
    }

    $("message").textContent = "";
    $("logOutput").textContent = "";
  } catch (error) {
    alert(error.message);
  }
};

$("save").onclick = async () => {
  if (!selected) return;

  try {
    const settings = {};

    for (const key of [
      "welcomeEnabled",
      "logsEnabled",
      "automodEnabled"
    ]) {
      settings[key] = $(key).checked;
    }

    for (const key of [
      "welcomeChannel",
      "logChannel",
      "moderatorRole"
    ]) {
      settings[key] = $(key).value.trim();
    }

    await api("/api/guild/" + selected + "/settings", {
      method: "PUT",
      body: JSON.stringify(settings)
    });

    $("message").textContent = "Settings saved successfully.";
  } catch (error) {
    $("message").textContent = error.message;
  }
};

$("logs").onclick = async () => {
  if (!selected) return;

  try {
    const logs = await api("/api/guild/" + selected + "/logs");
    $("logOutput").textContent = JSON.stringify(logs, null, 2);
  } catch (error) {
    $("logOutput").textContent = error.message;
  }
};

$("ownerStats").onclick = async () => {
  try {
    $("stats").textContent = JSON.stringify(
      await api("/api/owner/stats"),
      null,
      2
    );
  } catch (error) {
    $("stats").textContent = error.message;
  }
};

$("logout").onclick = async () => {
  try {
    await api("/auth/logout", { method: "POST" });
    location.href = "/";
  } catch (error) {
    alert(error.message);
  }
};

start();
</script>
</body>
</html>`);
});

/* =========================================================
   ERROR HANDLING
========================================================= */

app.use((error, _req, res, _next) => {
  safeError(res, error);
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

/* =========================================================
   STARTUP
========================================================= */

async function start() {
  await initDatabase();

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`NexusGuard website listening on ${PORT}`);
  });

  server.on("error", error => {
    console.error("Web server error:", error);
  });

  try {
    await client.login(BOT_TOKEN);
  } catch (error) {
    console.error("Discord bot login failed:", error.message);
    console.error(
      "Check DISCORD_TOKEN in Render. The website may remain online, but bot commands will not work."
    );
    return;
  }

  console.log("Discord login requested successfully.");

  /*
   * Register commands automatically.
   * Registration failure is logged without taking down the website.
   */
  try {
    await registerCommands();
  } catch (error) {
    console.error("Slash command registration failed:", error.message);
    console.error(
      "Check DISCORD_CLIENT_ID, DISCORD_TOKEN, and the Discord application."
    );
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("Shutting down NexusGuard...");

  client.destroy();

  try {
    await pool.end();
  } catch (error) {
    console.error("Database shutdown error:", error.message);
  }

  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

start().catch(error => {
  console.error("NexusGuard startup failed:", error);
  process.exit(1);
});
