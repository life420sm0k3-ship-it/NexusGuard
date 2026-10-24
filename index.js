
"use strict";

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder
} = require("discord.js");
const crypto = require("node:crypto");

const required = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "SESSION_SECRET",
  "DATABASE_URL"
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

if (process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 10000);
const OWNER_ID = process.env.OWNER_DISCORD_ID || "";
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable"
    ? false
    : { rejectUnauthorized: false }
});

const app = express();
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https://cdn.discordapp.com", "data:"],
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
    maxAge: 1000 * 60 * 60 * 24 * 7
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

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check NexusGuard's response time"),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View information about this server"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View a member's public Discord information")
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member to inspect")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Record a moderation warning")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member to warn")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason for the warning")
        .setRequired(true)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Temporarily timeout a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member to timeout")
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("minutes")
        .setDescription("Timeout duration, in minutes")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(40320)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
        .setRequired(false)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("View this server's NexusGuard settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());

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
}

async function getSettings(guildId) {
  const result = await pool.query(
    "SELECT settings FROM guild_settings WHERE guild_id = $1",
    [guildId]
  );

  return result.rows[0]?.settings || {
    welcomeEnabled: false,
    logsEnabled: true,
    automodEnabled: false,
    welcomeChannel: "",
    logChannel: "",
    moderatorRole: ""
  };
}

async function saveSettings(guildId, settings) {
  await pool.query(`
    INSERT INTO guild_settings (guild_id, settings, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (guild_id) DO UPDATE
    SET settings = EXCLUDED.settings, updated_at = NOW()
  `, [guildId, JSON.stringify(settings)]);
}

async function audit(guildId, actorId, action, targetId, details = {}) {
  await pool.query(`
    INSERT INTO audit_log
      (guild_id, actor_id, action, target_id, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [
    guildId,
    actorId,
    action,
    targetId || null,
    JSON.stringify(details)
  ]);
}

function isOwner(userId) {
  return Boolean(OWNER_ID) && userId === OWNER_ID;
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Sign in first." });
  }
  next();
}

function discordGuildPermissions(guild) {
  const bits = BigInt(guild.permissions || "0");
  const admin = (bits & 8n) === 8n;
  const manage = (bits & 32n) === 32n;
  return admin || manage || guild.owner === true;
}

async function getManageableGuilds(user) {
  const response = await fetch(
    "https://discord.com/api/v10/users/@me/guilds",
    { headers: { Authorization: `Bearer ${user.accessToken}` } }
  );

  if (response.status === 401) {
    throw new Error("Discord session expired. Please sign in again.");
  }
  if (!response.ok) {
    throw new Error("Unable to retrieve your Discord servers.");
  }

  const guilds = await response.json();
  const manageable = guilds.filter(g =>
    discordGuildPermissions(g) || isOwner(user.id)
  );

  return manageable.filter(g => client.guilds.cache.has(g.id));
}

async function requireGuildAccess(req, res, next) {
  try {
    const guildId = req.params.guildId;
    const guilds = await getManageableGuilds(req.session.user);
    const allowed = guilds.some(g => g.id === guildId);

    if (!allowed) {
      return res.status(403).json({
        error: "You cannot manage this server or NexusGuard is not installed."
      });
    }

    req.guildId = guildId;
    next();
  } catch (error) {
    next(error);
  }
}

function safeError(res, error) {
  console.error(error);
  if (res.headersSent) return;

  res.status(500).json({
    error: "An internal error occurred. Check the service logs."
  });
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      botReady: client.isReady(),
      database: "connected",
      uptimeSeconds: Math.floor(process.uptime())
    });
  } catch {
    res.status(503).json({ status: "unhealthy" });
  }
});

app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(32).toString("hex");
  req.session.oauthState = state;

  req.session.save(err => {
    if (err) return safeError(res, err);

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

    if (error) return res.redirect("/?login=cancelled");
    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !req.session.oauthState ||
      state !== req.session.oauthState
    ) {
      return res.status(400).send("Invalid sign-in state. Please try again.");
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
      req.session.regenerate(err => err ? reject(err) : resolve());
    });

    req.session.user = {
      id: profile.id,
      username: profile.username,
      globalName: profile.global_name || profile.username,
      avatar: profile.avatar || null,
      accessToken: tokenData.access_token
    };

    await new Promise((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });

    res.redirect("/");
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res.redirect("/?login=failed");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return safeError(res, err);
    res.clearCookie("nexusguard.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.json({ authenticated: false });
  }

  const { id, username, globalName, avatar } = req.session.user;
  res.json({
    authenticated: true,
    user: { id, username, globalName, avatar },
    owner: isOwner(id)
  });
});

app.get("/api/guilds", requireLogin, async (req, res, next) => {
  try {
    const guilds = await getManageableGuilds(req.session.user);
    res.json(guilds.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      botInstalled: client.guilds.cache.has(g.id)
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
      const settings = await getSettings(req.guildId);
      const guild = client.guilds.cache.get(req.guildId);

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

      for (const key of allowedKeys) {
        if (!(key in body)) continue;

        if (["welcomeEnabled", "logsEnabled", "automodEnabled"].includes(key)) {
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
      }

      await saveSettings(req.guildId, current);
      await audit(
        req.guildId,
        req.session.user.id,
        "settings.updated",
        null,
        { changedKeys: Object.keys(body).filter(k => allowedKeys.includes(k)) }
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

app.get("/api/owner/stats", requireLogin, async (req, res) => {
  if (!isOwner(req.session.user.id)) {
    return res.status(403).json({ error: "Owner access required." });
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
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#100d1b">
<title>NexusGuard — Control Center</title>
<style>
:root{color-scheme:dark;--bg:#100d1b;--panel:#1b1629;--line:#342847;--text:#f8f5ff;--muted:#aaa0bc;--purple:#9d70ff;--cyan:#51e1e5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui,-apple-system,sans-serif}
header{padding:20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line)}
.brand{font-weight:900;letter-spacing:1px}.brand span{color:var(--purple)}
main{max-width:1000px;margin:auto;padding:24px 16px}
h1{font-size:clamp(27px,6vw,42px);margin-bottom:8px}
p{color:var(--muted);line-height:1.6}
button,a.button{border:0;border-radius:12px;padding:12px 16px;background:var(--purple);color:white;font-weight:700;text-decoration:none;cursor:pointer;display:inline-block}
.secondary{background:var(--panel);border:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:14px;margin-top:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}
select,input{width:100%;padding:12px;margin:8px 0;background:var(--bg);color:white;border:1px solid var(--line);border-radius:10px}
label{display:block;margin-top:14px;color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.hidden{display:none!important}.status{color:var(--cyan)}.small{font-size:13px}
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
    <p>Manage your Discord communities with NexusGuard's moderation tools, settings, and security controls.</p>
    <a class="button" href="/auth/login">Sign in with Discord</a>
    <p id="loginError" class="small"></p>
  </section>

  <section id="dashboard" class="hidden">
    <h1 id="greeting">Dashboard</h1>
    <p>Select a server to manage its NexusGuard configuration.</p>
    <div class="card">
      <label for="guilds">Your manageable servers</label>
      <select id="guilds"><option>Loading servers…</option></select>
      <div class="row">
        <button id="load">Open server</button>
        <button id="logout" class="secondary">Sign out</button>
      </div>
    </div>
    <div id="serverPanel" class="hidden">
      <div class="grid">
        <div class="card"><h3>Server overview</h3><p id="overview"></p></div>
        <div class="card"><h3>Protection settings</h3><p>Choose the features enabled for this server.</p></div>
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
        <div class="row"><button id="save">Save settings</button></div>
        <p id="message" role="status"></p>
      </div>
      <div class="card">
        <h3>Recent audit events</h3>
        <button id="logs" class="secondary">Load audit log</button>
        <pre id="logOutput" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      </div>
    </div>
    <div id="ownerPanel" class="card hidden">
      <h3>Owner controls</h3>
      <p>Global platform statistics. Restricted to the configured owner.</p>
      <button id="ownerStats" class="secondary">Load global statistics</button>
      <pre id="stats"></pre>
    </div>
  </section>
</main>
<script>
const $=id=>document.getElementById(id);
let selected=null;

async function api(url,options={}){
  const r=await fetch(url,{
    ...options,
    headers:{"Content-Type":"application/json",...(options.headers||{})}
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||"Request failed ("+r.status+")");
  return data;
}

async function start(){
  const params=new URLSearchParams(location.search);
  if(params.has("login")){
    $("loginError").textContent=
      params.get("login")==="failed"
      ?"Sign-in failed. Check the OAuth redirect URI and client secret."
      :"Sign-in was cancelled. You can try again.";
    history.replaceState({}, "", "/");
  }
  try{
    const me=await api("/api/me");
    if(!me.authenticated)return;
    $("welcome").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
    $("greeting").textContent="Welcome, "+me.user.globalName;
    if(me.owner)$("ownerPanel").classList.remove("hidden");
    const guilds=await api("/api/guilds");
    $("guilds").replaceChildren();
    if(!guilds.length){
      $("guilds").add(new Option("No manageable servers with NexusGuard installed",""));
    }
    for(const g of guilds){
      $("guilds").add(new Option(g.name,g.id));
    }
  }catch(e){
    $("loginError").textContent=e.message;
  }
}

$("load").onclick=async()=>{
  selected=$("guilds").value;
  if(!selected)return;
  try{
    const d=await api("/api/guild/"+selected);
    $("serverPanel").classList.remove("hidden");
    $("overview").textContent=d.name+" · "+(d.memberCount??"Unknown")+" members";
    for(const key of ["welcomeEnabled","logsEnabled","automodEnabled"]){
      $(key).checked=Boolean(d.settings[key]);
    }
    for(const key of ["welcomeChannel","logChannel","moderatorRole"]){
      $(key).value=d.settings[key]||"";
    }
    $("message").textContent="";
  }catch(e){alert(e.message)}
};

$("save").onclick=async()=>{
  if(!selected)return;
  try{
    const settings={};
    for(const key of ["welcomeEnabled","logsEnabled","automodEnabled"]){
      settings[key]=$(key).checked;
    }
    for(const key of ["welcomeChannel","logChannel","moderatorRole"]){
      settings[key]=$(key).value.trim();
    }
    await api("/api/guild/"+selected+"/settings",{
      method:"PUT",body:JSON.stringify(settings)
    });
    $("message").textContent="Settings saved successfully.";
  }catch(e){$("message").textContent=e.message}
};

$("logs").onclick=async()=>{
  try{
    const logs=await api("/api/guild/"+selected+"/logs");
    $("logOutput").textContent=JSON.stringify(logs,null,2);
  }catch(e){$("logOutput").textContent=e.message}
};

$("ownerStats").onclick=async()=>{
  try{$("stats").textContent=JSON.stringify(await api("/api/owner/stats"),null,2)}
  catch(e){$("stats").textContent=e.message}
};

$("logout").onclick=async()=>{
  try{await api("/auth/logout",{method:"POST"});location.href="/"}
  catch(e){alert(e.message)}
};

start();
</script>
</body>
</html>`);
});

client.on("guildCreate", async guild => {
  try {
    await getSettings(guild.id);
    console.log(`NexusGuard joined ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error("Guild initialization failed:", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "ping") {
      return interaction.reply({
        content: `Pong! WebSocket latency: ${client.ws.ping}ms`,
        ephemeral: true
      });
    }

    if (interaction.commandName === "serverinfo") {
      const g = interaction.guild;
      if (!g) return interaction.reply({
        content: "Use this command in a server.",
        ephemeral: true
      });

      const embed = new EmbedBuilder()
        .setColor(0x9d70ff)
        .setTitle(g.name)
        .setThumbnail(g.iconURL({ size: 256 }))
        .addFields(
          { name: "Server ID", value: g.id, inline: true },
          { name: "Members", value: String(g.memberCount ?? "Unknown"), inline: true },
          { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>` }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "userinfo") {
      const user = interaction.options.getUser("member") || interaction.user;
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x51e1e5)
            .setTitle(user.username)
            .setThumbnail(user.displayAvatarURL({ size: 256 }))
            .addFields(
              { name: "User ID", value: user.id },
              { name: "Account created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>` }
            )
        ]
      });
    }

    if (interaction.commandName === "warn") {
      const member = interaction.options.getUser("member");
      const reason = interaction.options.getString("reason", true);

      await audit(
        interaction.guildId,
        interaction.user.id,
        "member.warned",
        member.id,
        { reason }
      );

      return interaction.reply({
        content: `⚠️ ${member} has been warned. Reason: ${reason}`,
        allowedMentions: { users: [] }
      });
    }

    if (interaction.commandName === "timeout") {
      const user = interaction.options.getUser("member", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const reason = interaction.options.getString("reason") || "No reason supplied";

      const target = await interaction.guild.members.fetch(user.id);
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      const botMember = await interaction.guild.members.fetchMe();

      if (!actor.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({
          content: "You need the Moderate Members permission.",
          ephemeral: true
        });
      }

      if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({
          content: "NexusGuard needs the Moderate Members permission.",
          ephemeral: true
        });
      }

      if (!target.moderatable) {
        return interaction.reply({
          content: "I cannot timeout that member. Check role hierarchy and permissions.",
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
        content: `⏱️ ${user.username} was timed out for ${minutes} minute(s).`,
        allowedMentions: { users: [] }
      });
    }

    if (interaction.commandName === "settings") {
      const settings = await getSettings(interaction.guildId);
      return interaction.reply({
        content: "```json\n" + JSON.stringify(settings, null, 2) + "\n```",
        ephemeral: true
      });
    }
  } catch (error) {
    console.error("Command failed:", error);

    const response = {
      content: "That command failed. Check the bot logs for details.",
      ephemeral: true
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );

  console.log(`Registered ${commands.length} NexusGuard slash commands.`);
}

async function start() {
  await initDatabase();

  if (process.argv.includes("--register")) {
    await registerCommands();
    await pool.end();
    process.exit(0);
  }

  await client.login(BOT_TOKEN);

  app.use((error, _req, res, _next) => safeError(res, error));

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`NexusGuard website listening on ${PORT}`);
  });
}

async function shutdown() {
  console.log("Shutting down NexusGuard...");
  client.destroy();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch(error => {
  console.error("NexusGuard startup failed:", error);
  process.exit(1);
});
