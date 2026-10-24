"use strict";

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, ChannelType
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const OWNER_ID = process.env.OWNER_DISCORD_ID || "";
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = Number(process.env.PORT || 10000);
const WEBSITE_URL = "https://nexusguard-rxkr.onrender.com";
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${WEBSITE_URL}/auth/callback`;

for (const [key, value] of Object.entries({
  DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_ID: CLIENT_ID,
  DISCORD_CLIENT_SECRET: CLIENT_SECRET, DATABASE_URL, SESSION_SECRET
})) {
  if (!value) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}
if (SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
// Prevent Discord.js client error events from terminating the whole Render process.
// Interaction error 10062 means Discord has expired the interaction token; it is logged
// and ignored rather than being allowed to crash the bot.
client.on("error", error => {
  if (error?.code === 10062 || error?.rawError?.code === 10062) {
    console.warn("Discord interaction expired (10062); the bot will keep running.");
    return;
  }
  console.error("Discord client error:", error);
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});
pool.on("error", err => console.error("PostgreSQL pool error:", err.message));

const DEFAULT_SETTINGS = {
  welcomeEnabled: false,
  welcomeChannel: "",
  welcomeMessage: "Welcome {user} to {server}!",
  logsEnabled: false,
  logsChannel: "",
  automodEnabled: false,
  announcementChannel: "",
  moderatorRole: "",
  moderatorRoles: [],
  accentColor: "#8b5cf6"
};

async function initDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT,
    action TEXT NOT NULL, target_id TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_guild_created_idx
    ON audit_log(guild_id, created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS warnings (
    id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Create the exact table connect-pg-simple uses. This avoids session-table startup errors.
  await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
    sid VARCHAR NOT NULL PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions(expire)`);
}

async function getSettings(guildId) {
  const r = await pool.query("SELECT settings FROM guild_settings WHERE guild_id=$1", [guildId]);
  return { ...DEFAULT_SETTINGS, ...(r.rows[0]?.settings || {}) };
}
async function saveSettings(guildId, settings) {
  await pool.query(`INSERT INTO guild_settings(guild_id,settings,updated_at)
    VALUES($1,$2::jsonb,NOW()) ON CONFLICT(guild_id)
    DO UPDATE SET settings=$2::jsonb,updated_at=NOW()`,
    [guildId, JSON.stringify(settings)]);
}
async function audit(guildId, actorId, action, targetId = null, details = {}) {
  await pool.query(`INSERT INTO audit_log(guild_id,actor_id,action,target_id,details)
    VALUES($1,$2,$3,$4,$5::jsonb)`,
    [guildId, actorId || null, action, targetId, JSON.stringify(details)]);
}
function isOwner(id) { return Boolean(OWNER_ID) && id === OWNER_ID; }
function has(member, permission) { return Boolean(member?.permissions?.has(permission)); }

const commands = [
  new SlashCommandBuilder().setName("website").setDescription("Get the NexusGuard dashboard link"),
  new SlashCommandBuilder().setName("help").setDescription("Show NexusGuard commands"),
  new SlashCommandBuilder().setName("commands").setDescription("Display the complete categorized command directory"),
  // Intentional no-action category dividers: these only label command groups in Discord.
  new SlashCommandBuilder().setName("general").setDescription("━━━━━━━━ GENERAL COMMANDS · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("server-tools").setDescription("━━━━━━━━ SERVER TOOLS · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("moderation-tools").setDescription("━━━━━━━━ MODERATION · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("roles").setDescription("━━━━━━━━ ROLES & MEMBERS · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("tickets").setDescription("━━━━━━━━ TICKETS · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("community").setDescription("━━━━━━━━ COMMUNITY · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("automod").setDescription("━━━━━━━━ AUTOMOD & SECURITY · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("levels").setDescription("━━━━━━━━ LEVELS & XP · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("economy").setDescription("━━━━━━━━ ECONOMY · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("fun").setDescription("━━━━━━━━ FUN & GAMES · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("configuration").setDescription("━━━━━━━━ CONFIGURATION · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("owner").setDescription("━━━━━━━━ OWNER-ONLY TOOLS · CATEGORY DIVIDER ━━━━━━━━"),
  new SlashCommandBuilder().setName("invite").setDescription("Get the NexusGuard invite link"),
  new SlashCommandBuilder().setName("ping").setDescription("Check bot latency"),
  new SlashCommandBuilder().setName("botinfo").setDescription("View bot information"),
  new SlashCommandBuilder().setName("uptime").setDescription("Check bot uptime"),
  new SlashCommandBuilder().setName("serverinfo").setDescription("View server information"),
  new SlashCommandBuilder().setName("membercount").setDescription("Count server members"),
  new SlashCommandBuilder().setName("servericon").setDescription("Show the server icon"),
  new SlashCommandBuilder().setName("userinfo").setDescription("View a user's information")
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder().setName("avatar").setDescription("Show a user's avatar")
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder().setName("roleinfo").setDescription("View information about a role")
    .addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder().setName("channelinfo").setDescription("View channel information")
    .addChannelOption(o => o.setName("channel").setDescription("Channel").setRequired(false)),
  new SlashCommandBuilder().setName("rolelist").setDescription("List server roles"),
  new SlashCommandBuilder().setName("channellist").setDescription("List server channels"),
  new SlashCommandBuilder().setName("warn").setDescription("Record a member warning")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName("warnings").setDescription("View a member's warnings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Minutes, 1-40320").setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false).setMaxLength(500)),
  new SlashCommandBuilder().setName("untimeout").setDescription("Remove a member timeout")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false).setMaxLength(500)),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false).setMaxLength(500)),
  new SlashCommandBuilder().setName("unban").setDescription("Unban a user by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o => o.setName("userid").setDescription("Discord user ID").setRequired(true)),
  new SlashCommandBuilder().setName("purge").setDescription("Delete recent messages")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName("amount").setDescription("1-100 messages").setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName("lock").setDescription("Lock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("unlock").setDescription("Unlock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("slowmode").setDescription("Set channel slowmode")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o => o.setName("seconds").setDescription("0-21600 seconds").setRequired(true).setMinValue(0).setMaxValue(21600)),
  new SlashCommandBuilder().setName("poll").setDescription("Create a yes/no poll")
    .addStringOption(o => o.setName("question").setDescription("Poll question").setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName("announce").setDescription("Post an announcement")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName("message").setDescription("Announcement").setRequired(true).setMaxLength(1800)),
  new SlashCommandBuilder().setName("say").setDescription("Send a message as NexusGuard")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o.setName("message").setDescription("Message").setRequired(true).setMaxLength(1800)),
  new SlashCommandBuilder().setName("settings").setDescription("View saved server settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("coinflip").setDescription("Flip a coin"),
  new SlashCommandBuilder().setName("dice").setDescription("Roll a die"),
  new SlashCommandBuilder().setName("eightball").setDescription("Ask the magic eight ball")
    .addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder().setName("choose").setDescription("Choose from options")
    .addStringOption(o => o.setName("options").setDescription("Choices separated by commas").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("rate").setDescription("Rate something out of 100")
    .addStringOption(o => o.setName("thing").setDescription("What to rate").setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName("rps").setDescription("Play rock paper scissors")
    .addStringOption(o => o.setName("choice").setDescription("Your move").setRequired(true)
      .addChoices({name:"Rock",value:"rock"},{name:"Paper",value:"paper"},{name:"Scissors",value:"scissors"}))
  ,new SlashCommandBuilder().setName("nickname").setDescription("Change a member nickname")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption(o=>o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption(o=>o.setName("nickname").setDescription("New nickname (blank is not supported)").setRequired(true).setMaxLength(32)),
  new SlashCommandBuilder().setName("roleadd").setDescription("Give a role to a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption(o=>o.setName("member").setDescription("Member").setRequired(true))
    .addRoleOption(o=>o.setName("role").setDescription("Role to add").setRequired(true)),
  new SlashCommandBuilder().setName("roleremove").setDescription("Remove a role from a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption(o=>o.setName("member").setDescription("Member").setRequired(true))
    .addRoleOption(o=>o.setName("role").setDescription("Role to remove").setRequired(true)),
  new SlashCommandBuilder().setName("clearwarnings").setDescription("Clear recorded warnings for a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o=>o.setName("member").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("memberstats").setDescription("View member account and server stats")
    .addUserOption(o=>o.setName("member").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder().setName("topic").setDescription("Set this channel topic")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(o=>o.setName("text").setDescription("New channel topic").setRequired(true).setMaxLength(1024)),
  new SlashCommandBuilder().setName("remind").setDescription("Set a short reminder in this channel")
    .addIntegerOption(o=>o.setName("minutes").setDescription("Minutes from now (1-1440)").setRequired(true).setMinValue(1).setMaxValue(1440))
    .addStringOption(o=>o.setName("message").setDescription("Reminder text").setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName("embed").setDescription("Post a styled embed")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o=>o.setName("title").setDescription("Embed title").setRequired(true).setMaxLength(256))
    .addStringOption(o=>o.setName("description").setDescription("Embed description").setRequired(true).setMaxLength(3500)),
  new SlashCommandBuilder().setName("serverstats").setDescription("View server stats")
].map(c => c.toJSON());

// Convert the old visual divider commands into real Discord command groups.
// Commands with Discord-side default permissions stay top-level so their
// existing permission restrictions are preserved exactly.
const COMMAND_GROUPS = {
  general: new Set(["website", "help", "commands", "invite", "ping", "botinfo", "uptime"]),
  "server-tools": new Set(["serverinfo", "membercount", "servericon", "userinfo", "avatar", "roleinfo", "channelinfo", "rolelist", "channellist", "memberstats", "serverstats"]),
  moderation: new Set(["warnings", "untimeout", "clearwarnings"]),
  roles: new Set(["nickname", "roleadd", "roleremove"]),
  community: new Set(["poll", "announce", "say", "remind"]),
  fun: new Set(["coinflip", "dice", "eightball", "choose", "rate", "rps"]),
  configuration: new Set(["settings"])
};
const DIVIDER_NAMES = new Set(["general", "server-tools", "moderation-tools", "roles", "tickets", "community", "automod", "levels", "economy", "fun", "configuration", "owner"]);
function buildGroupedCommands() {
  const flat = commands.filter(c => !DIVIDER_NAMES.has(c.name));
  const groups = new Map();
  const output = [];
  for (const cmd of flat) {
    const groupName = Object.keys(COMMAND_GROUPS).find(name => COMMAND_GROUPS[name].has(cmd.name));
    // Preserve Discord-enforced permission defaults on their existing commands.
    if (!groupName || cmd.default_member_permissions != null || cmd.dm_permission === false && !groupName) {
      output.push(cmd);
      continue;
    }
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push({ type: 1, name: cmd.name, description: cmd.description.slice(0, 100), options: cmd.options || [] });
  }
  for (const [name, options] of groups) {
    output.push({ type: 1, name, description: `${name.replace(/-/g, " ")} commands`, options });
  }
  return output;
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const body = buildGroupedCommands();
  const result = await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`Registered ${result.length} global slash commands (${body.filter(c => c.options?.some(o => o.type === 1)).length} command groups).`);
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}; guilds: ${client.guilds.cache.size}`);
  client.user.setActivity("over your communities");
});

client.on("guildCreate", async guild => {
  try { await saveSettings(guild.id, await getSettings(guild.id)); }
  catch (e) { console.error("Guild setup failed:", e.message); }
});

client.on("guildMemberAdd", async member => {
  try {
    const s = await getSettings(member.guild.id);
    if (!s.welcomeEnabled || !s.welcomeChannel) return;
    const ch = await member.guild.channels.fetch(s.welcomeChannel).catch(() => null);
    if (!ch?.isTextBased()) return;
    const msg = String(s.welcomeMessage || DEFAULT_SETTINGS.welcomeMessage)
      .replaceAll("{user}", `<@${member.id}>`)
      .replaceAll("{server}", member.guild.name);
    await ch.send({ content: msg, allowedMentions: { users: [member.id] } });
    if (s.logsEnabled && s.logsChannel) {
      const log = await member.guild.channels.fetch(s.logsChannel).catch(() => null);
      if (log?.isTextBased()) await log.send(`📥 ${member.user.tag} joined the server.`);
    }
  } catch (e) { console.error("Welcome handler:", e.message); }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;
  try {
    const s = await getSettings(message.guild.id);
    if (!s.automodEnabled) return;
    const invite = /discord(?:\.gg|\.com\/invite)\/[a-z0-9-]+/i.test(message.content || "");
    const massMention = message.mentions.users.size >= 6 || message.mentions.roles.size >= 5;
    if (!invite && !massMention) return;
    if (has(message.member, PermissionFlagsBits.ManageMessages)) return;
    await message.delete().catch(() => {});
    await audit(message.guild.id, client.user.id, "automod.message_removed", message.author.id,
      { reason: massMention ? "Mass mentions" : "Invite link" });
    const notice = await message.channel.send({
      content: `${message.author}, your message was removed by AutoMod.`,
      allowedMentions: { users: [message.author.id] }
    }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 5000);
  } catch (e) { console.error("AutoMod handler:", e.message); }
});

client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;
  // For grouped commands, dispatch using the selected subcommand's original
  // name so the existing handlers and option reads continue to work unchanged.
  const n = i.options.getSubcommand(false) || i.commandName;
  const replyError = async e => {
    if (e?.code === 10062 || e?.rawError?.code === 10062) {
      console.warn(`/${n}: Discord interaction expired before a response could be sent (10062).`);
      return;
    }
    console.error(`/${n}:`, e);
    const payload = { content: "Command failed. Check Render logs for details.", ephemeral: true };
    if (i.deferred || i.replied) await i.followUp(payload).catch(err => {
      if (err?.code !== 10062) console.error(`/${n} follow-up failed:`, err.message);
    });
    else await i.reply(payload).catch(err => {
      if (err?.code !== 10062) console.error(`/${n} error reply failed:`, err.message);
    });
  };

  try {
    if (!i.inGuild() && !["website","help","commands","invite","ping","botinfo","uptime"].includes(n)) {
      return i.reply({ content: "Use this command inside a server.", ephemeral: true });
    }

    if (n === "website") return i.reply({ content: `🌐 NexusGuard Dashboard: ${WEBSITE_URL}`, ephemeral: true });

    if (n === "invite") {
      const u = new URL("https://discord.com/oauth2/authorize");
      u.searchParams.set("client_id", CLIENT_ID);
      u.searchParams.set("scope", "bot applications.commands");
      u.searchParams.set("permissions", "8");
      return i.reply({ content: `Invite NexusGuard: ${u}`, ephemeral: true });
    }

    if (n === "commands" || n === "help") {
      const e = new EmbedBuilder().setColor(0x8b5cf6).setTitle("🛡️ NexusGuard Commands")
        .setDescription(
          "**GENERAL GROUP:** /general website, /general help, /general commands, /general invite, /general ping, /general botinfo, /general uptime\n\n" +
          "**SERVER TOOLS GROUP:** /server-tools serverinfo, membercount, servericon, userinfo, avatar, roleinfo, channelinfo, rolelist, channellist, memberstats, serverstats\n\n" +
          "**MODERATION:** /warn, /timeout, /kick, /ban, /purge, /lock, /unlock, /slowmode and related tools\n\n" +
          "**ROLES GROUP:** /roles nickname, /roles roleadd, /roles roleremove\n" +
          "**COMMUNITY GROUP:** /community poll, /community announce, /community say, /community remind\n" +
          "**FUN GROUP:** /fun coinflip, /fun dice, /fun eightball, /fun choose, /fun rate, /fun rps\n" +
          "**CONFIGURATION GROUP:** /configuration settings\n\n" +
          "Commands with specific Discord permission requirements remain separate top-level commands."
        );
      return i.reply({ embeds: [e], ephemeral: true });
    }

    if (n === "ping") return i.reply({ content: `🏓 Pong! ${client.ws.ping}ms`, ephemeral: true });
    if (n === "uptime") {
      const t = Math.floor(process.uptime()), d = Math.floor(t/86400), h = Math.floor(t%86400/3600), m = Math.floor(t%3600/60);
      return i.reply({ content: `⏱️ Uptime: ${d}d ${h}h ${m}m`, ephemeral: true });
    }
    if (n === "botinfo") {
      const e = new EmbedBuilder().setColor(0x51e1e5).setTitle("NexusGuard")
        .setDescription("Guarding Your Community, Empowering Your Server.")
        .addFields({name:"Servers",value:String(client.guilds.cache.size),inline:true},
          {name:"Latency",value:`${client.ws.ping}ms`,inline:true},{name:"Dashboard",value:WEBSITE_URL});
      if (client.user) e.setThumbnail(client.user.displayAvatarURL());
      return i.reply({ embeds:[e] });
    }

    if (n === "serverinfo") {
      const g=i.guild, e=new EmbedBuilder().setColor(0x8b5cf6).setTitle(g.name)
        .addFields({name:"Server ID",value:g.id,inline:true},{name:"Members",value:String(g.memberCount),inline:true},
          {name:"Created",value:`<t:${Math.floor(g.createdTimestamp/1000)}:D>`});
      const icon=g.iconURL({size:256}); if(icon)e.setThumbnail(icon);
      return i.reply({embeds:[e]});
    }
    if (n === "membercount") return i.reply(`👥 This server has **${i.guild.memberCount}** members.`);
    if (n === "servericon") return i.reply({content:i.guild.iconURL({size:1024}) || "This server has no icon.",ephemeral:true});
    if (n === "userinfo" || n === "avatar") {
      const u=i.options.getUser("member") || i.user;
      if(n==="avatar") return i.reply({content:u.displayAvatarURL({size:1024}),ephemeral:true});
      const e=new EmbedBuilder().setColor(0x51e1e5).setTitle(u.username).setThumbnail(u.displayAvatarURL({size:512}))
        .addFields({name:"User ID",value:u.id},{name:"Created",value:`<t:${Math.floor(u.createdTimestamp/1000)}:F>`});
      return i.reply({embeds:[e]});
    }
    if (n === "roleinfo") {
      const r=i.options.getRole("role"), e=new EmbedBuilder().setColor(r.color||0x8b5cf6).setTitle(`Role: ${r.name}`)
        .addFields({name:"Role ID",value:r.id,inline:true},{name:"Members",value:String(r.members.size),inline:true},{name:"Position",value:String(r.position),inline:true});
      return i.reply({embeds:[e],ephemeral:true});
    }
    if (n === "channelinfo") {
      const c=i.options.getChannel("channel") || i.channel;
      return i.reply({embeds:[new EmbedBuilder().setColor(0x8b5cf6).setTitle(c.name||"Channel")
        .addFields({name:"Channel ID",value:c.id},{name:"Type",value:String(c.type)})],ephemeral:true});
    }
    if (n === "rolelist") {
      const out=i.guild.roles.cache.filter(r=>r.id!==i.guild.id).sort((a,b)=>b.position-a.position).first(40).map(r=>`• ${r.name}`).join("\n");
      return i.reply({content:out||"No roles found.",ephemeral:true});
    }
    if (n === "channellist") {
      const out=i.guild.channels.cache.sort((a,b)=>a.rawPosition-b.rawPosition).first(50)
        .map(c=>`${c.type===ChannelType.GuildCategory?"📁":"#"} ${c.name}`).join("\n");
      return i.reply({content:out||"No channels found.",ephemeral:true});
    }

    if (n === "warn") {
      const u=i.options.getUser("member",true), reason=i.options.getString("reason",true), actor=await i.guild.members.fetch(i.user.id);
      if(!has(actor,PermissionFlagsBits.ModerateMembers)) return i.reply({content:"You need Moderate Members permission.",ephemeral:true});
      if(u.id===i.user.id || u.id===client.user.id) return i.reply({content:"You cannot warn yourself or the bot.",ephemeral:true});
      await pool.query("INSERT INTO warnings(guild_id,user_id,moderator_id,reason) VALUES($1,$2,$3,$4)",[i.guildId,u.id,i.user.id,reason]);
      await audit(i.guildId,i.user.id,"member.warned",u.id,{reason});
      return i.reply({content:`⚠️ **${u.username}** has been warned.\nReason: ${reason}`,allowedMentions:{parse:[]}});
    }
    if (n === "warnings") {
      const u=i.options.getUser("member",true), actor=await i.guild.members.fetch(i.user.id);
      if(!has(actor,PermissionFlagsBits.ModerateMembers)) return i.reply({content:"You need Moderate Members permission.",ephemeral:true});
      const r=await pool.query("SELECT reason,moderator_id,created_at FROM warnings WHERE guild_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 10",[i.guildId,u.id]);
      if(!r.rows.length) return i.reply({content:"No warnings recorded for this user.",ephemeral:true});
      const desc=r.rows.map((x,j)=>`**${j+1}.** ${x.reason}\nModerator: <@${x.moderator_id}> • <t:${Math.floor(new Date(x.created_at).getTime()/1000)}:R>`).join("\n\n");
      return i.reply({embeds:[new EmbedBuilder().setColor(0xf59e0b).setTitle(`Warnings: ${u.username}`).setDescription(desc)],ephemeral:true});
    }
    if (n === "timeout" || n === "untimeout") {
      const u=i.options.getUser("member",true), actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe(), target=await i.guild.members.fetch(u.id);
      if(!has(actor,PermissionFlagsBits.ModerateMembers)||!has(bot,PermissionFlagsBits.ModerateMembers)) return i.reply({content:"You and NexusGuard need Moderate Members permission.",ephemeral:true});
      if(!target.moderatable) return i.reply({content:"I cannot moderate this member. Check role hierarchy.",ephemeral:true});
      if(n==="timeout"){
        const minutes=i.options.getInteger("minutes",true), reason=i.options.getString("reason")||"No reason supplied";
        await target.timeout(minutes*60000,reason); await audit(i.guildId,i.user.id,"member.timed_out",u.id,{minutes,reason});
        return i.reply(`⏱️ **${u.username}** timed out for ${minutes} minute(s).`);
      }
      await target.timeout(null,`Timeout removed by ${i.user.tag}`); await audit(i.guildId,i.user.id,"member.timeout_removed",u.id);
      return i.reply(`✅ Timeout removed for **${u.username}**.`);
    }
    if (n === "kick" || n === "ban") {
      const u=i.options.getUser("member",true), reason=i.options.getString("reason")||"No reason supplied";
      const actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe();
      const perm=n==="kick"?PermissionFlagsBits.KickMembers:PermissionFlagsBits.BanMembers;
      if(!has(actor,perm)||!has(bot,perm)) return i.reply({content:`You and NexusGuard need ${n==="kick"?"Kick Members":"Ban Members"} permission.`,ephemeral:true});
      if(u.id===i.user.id||u.id===client.user.id) return i.reply({content:`You cannot ${n} yourself or the bot.`,ephemeral:true});
      const target=await i.guild.members.fetch(u.id).catch(()=>null);
      if(target && (n==="kick"?!target.kickable:!target.bannable)) return i.reply({content:`I cannot ${n} this member. Check role hierarchy.`,ephemeral:true});
      if(n==="kick") await target.kick(reason); else await i.guild.members.ban(u.id,{reason});
      await audit(i.guildId,i.user.id,n==="kick"?"member.kicked":"member.banned",u.id,{reason});
      return i.reply({content:`✅ **${u.username}** was ${n==="kick"?"kicked":"banned"}.`,allowedMentions:{parse:[]}});
    }
    if (n === "unban") {
      const actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe();
      if(!has(actor,PermissionFlagsBits.BanMembers)||!has(bot,PermissionFlagsBits.BanMembers)) return i.reply({content:"You and NexusGuard need Ban Members permission.",ephemeral:true});
      const id=i.options.getString("userid",true);
      if(!/^\d{17,20}$/.test(id)) return i.reply({content:"Enter a valid Discord user ID.",ephemeral:true});
      await i.guild.members.unban(id); await audit(i.guildId,i.user.id,"member.unbanned",id);
      return i.reply(`✅ Unbanned user ID ${id}.`);
    }
    if (n === "purge") {
      const amount=i.options.getInteger("amount",true), actor=await i.guild.members.fetch(i.user.id);
      if(!has(actor,PermissionFlagsBits.ManageMessages)) return i.reply({content:"You need Manage Messages permission.",ephemeral:true});
      if(!i.channel?.bulkDelete) return i.reply({content:"This channel does not support bulk deletion.",ephemeral:true});
      const deleted=await i.channel.bulkDelete(amount,true); await audit(i.guildId,i.user.id,"messages.purged",i.channelId,{count:deleted.size});
      return i.reply({content:`🧹 Deleted ${deleted.size} message(s). Messages older than 14 days are skipped.`,ephemeral:true});
    }
    if (n === "lock" || n === "unlock") {
      const actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe();
      if(!has(actor,PermissionFlagsBits.ManageChannels)||!has(bot,PermissionFlagsBits.ManageChannels)) return i.reply({content:"You and NexusGuard need Manage Channels permission.",ephemeral:true});
      const locked=n==="lock";
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:locked?false:null});
      await audit(i.guildId,i.user.id,`channel.${n}`,i.channelId);
      return i.reply(locked?"🔒 Channel locked.":"🔓 Channel unlocked.");
    }
    if (n === "slowmode") {
      const seconds=i.options.getInteger("seconds",true), actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe();
      if(!has(actor,PermissionFlagsBits.ManageChannels)||!has(bot,PermissionFlagsBits.ManageChannels)) return i.reply({content:"You and NexusGuard need Manage Channels permission.",ephemeral:true});
      await i.channel.setRateLimitPerUser(seconds); await audit(i.guildId,i.user.id,"channel.slowmode",i.channelId,{seconds});
      return i.reply(seconds===0?"Slowmode disabled.":`🐢 Slowmode set to ${seconds} seconds.`);
    }
    if (n === "poll") {
      const question=i.options.getString("question",true);
      const msg=await i.reply({content:`📊 **Poll:** ${question}\n\nReact with 👍 or 👎.`,fetchReply:true,allowedMentions:{parse:[]}});
      await msg.react("👍"); await msg.react("👎"); return;
    }
    if (n === "announce") {
      const actor=await i.guild.members.fetch(i.user.id);
      if(!has(actor,PermissionFlagsBits.ManageGuild)) return i.reply({content:"You need Manage Server permission.",ephemeral:true});
      const text=i.options.getString("message",true), s=await getSettings(i.guildId);
      const channel=s.announcementChannel?await i.guild.channels.fetch(s.announcementChannel).catch(()=>null):i.channel;
      if(!channel?.isTextBased()) return i.reply({content:"Announcement channel unavailable.",ephemeral:true});
      await channel.send({embeds:[new EmbedBuilder().setColor(0x8b5cf6).setTitle("📢 Announcement").setDescription(text).setFooter({text:`Posted by ${i.user.username}`}).setTimestamp()],allowedMentions:{parse:[]}});
      await audit(i.guildId,i.user.id,"announcement.posted",channel.id);
      return i.reply({content:`Announcement posted in <#${channel.id}>.`,ephemeral:true});
    }
    if (n === "say") {
      const actor=await i.guild.members.fetch(i.user.id);
      if(!has(actor,PermissionFlagsBits.ManageMessages)) return i.reply({content:"You need Manage Messages permission.",ephemeral:true});
      const text=i.options.getString("message",true);
      await i.reply({content:"Message sent.",ephemeral:true});
      await i.channel.send({content:text,allowedMentions:{parse:[]}}); return;
    }
    if (n === "settings") {
      return i.reply({content:"```json\n"+JSON.stringify(await getSettings(i.guildId),null,2)+"\n```",ephemeral:true});
    }
    if (n === "coinflip") return i.reply(Math.random()<0.5?"🪙 Heads!":"🪙 Tails!");
    if (n === "dice") return i.reply(`🎲 You rolled **${crypto.randomInt(1,7)}**.`);
    if (n === "eightball") {
      const a=["Absolutely!","Definitely!","Probably.","Signs point to yes.","Ask again later.","Cannot predict that now.","Probably not.","Definitely not!","The outlook is uncertain."];
      return i.reply(`🎱 ${a[crypto.randomInt(a.length)]}`);
    }
    if (n === "choose") {
      const a=i.options.getString("options",true).split(",").map(v=>v.trim()).filter(Boolean).slice(0,50);
      if(a.length<2) return i.reply({content:"Enter at least two comma-separated choices.",ephemeral:true});
      return i.reply({content:`🎯 My choice: **${a[crypto.randomInt(a.length)]}**`,allowedMentions:{parse:[]}});
    }
    if (n === "rate") {
      return i.reply({content:`⭐ I'd rate **${i.options.getString("thing",true)}** **${crypto.randomInt(101)}/100**!`,allowedMentions:{parse:[]}});
    }
    if (n === "rps") {
      const player=i.options.getString("choice",true), a=["rock","paper","scissors"], bot=a[crypto.randomInt(a.length)];
      let result="It's a tie!";
      if((player==="rock"&&bot==="scissors")||(player==="paper"&&bot==="rock")||(player==="scissors"&&bot==="paper")) result="You win!";
      else if(player!==bot) result="NexusGuard wins!";
      return i.reply(`You chose **${player}**. I chose **${bot}**. ${result}`);
    }
    if (n === "nickname") {
      const actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe(), u=i.options.getUser("member",true), target=await i.guild.members.fetch(u.id), nick=i.options.getString("nickname",true);
      if(!has(actor,PermissionFlagsBits.ManageNicknames)||!has(bot,PermissionFlagsBits.ManageNicknames)) return i.reply({content:"You and NexusGuard need Manage Nicknames permission.",ephemeral:true});
      if(!target.manageable) return i.reply({content:"I cannot change this member's nickname because of role hierarchy.",ephemeral:true});
      await target.setNickname(nick,`Changed by ${i.user.tag}`); await audit(i.guildId,i.user.id,"member.nickname_changed",u.id,{nickname:nick});
      return i.reply({content:`Nickname updated for **${u.username}**.`,ephemeral:true});
    }
    if (n === "roleadd" || n === "roleremove") {
      const actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe(), u=i.options.getUser("member",true), role=i.options.getRole("role",true), target=await i.guild.members.fetch(u.id);
      if(!has(actor,PermissionFlagsBits.ManageRoles)||!has(bot,PermissionFlagsBits.ManageRoles)) return i.reply({content:"You and NexusGuard need Manage Roles permission.",ephemeral:true});
      if(role.managed||role.position>=bot.roles.highest.position) return i.reply({content:"I cannot manage that role. Check integration status and role hierarchy.",ephemeral:true});
      if(n==="roleadd") await target.roles.add(role,`Granted by ${i.user.tag}`); else await target.roles.remove(role,`Removed by ${i.user.tag}`);
      await audit(i.guildId,i.user.id,n==="roleadd"?"member.role_added":"member.role_removed",u.id,{roleId:role.id});
      return i.reply({content:`${n==="roleadd"?"Added":"Removed"} **${role.name}** ${n==="roleadd"?"to":"from"} **${u.username}**.`,ephemeral:true});
    }
    if (n === "clearwarnings") {
      const actor=await i.guild.members.fetch(i.user.id), u=i.options.getUser("member",true);
      if(!has(actor,PermissionFlagsBits.ModerateMembers)) return i.reply({content:"You need Moderate Members permission.",ephemeral:true});
      const r=await pool.query("DELETE FROM warnings WHERE guild_id=$1 AND user_id=$2",[i.guildId,u.id]);
      await audit(i.guildId,i.user.id,"member.warnings_cleared",u.id,{count:r.rowCount});
      return i.reply({content:`Cleared ${r.rowCount} warning record(s) for **${u.username}**.`,ephemeral:true});
    }
    if (n === "memberstats") {
      const u=i.options.getUser("member")||i.user, member=await i.guild.members.fetch(u.id).catch(()=>null);
      const r=await pool.query("SELECT COUNT(*)::int AS count FROM warnings WHERE guild_id=$1 AND user_id=$2",[i.guildId,u.id]);
      const e=new EmbedBuilder().setColor(0x51e1e5).setTitle(`Member stats · ${u.username}`).setThumbnail(u.displayAvatarURL({size:256}))
        .addFields({name:"Account created",value:`<t:${Math.floor(u.createdTimestamp/1000)}:R>`,inline:true},{name:"Joined server",value:member?.joinedTimestamp?`<t:${Math.floor(member.joinedTimestamp/1000)}:R>`:"Not in server",inline:true},{name:"Recorded warnings",value:String(r.rows[0]?.count||0),inline:true},{name:"Highest role",value:member?.roles.highest?.name||"Unknown",inline:true});
      return i.reply({embeds:[e],ephemeral:true});
    }
    if (n === "topic") {
      const actor=await i.guild.members.fetch(i.user.id), bot=await i.guild.members.fetchMe();
      if(!has(actor,PermissionFlagsBits.ManageChannels)||!has(bot,PermissionFlagsBits.ManageChannels)) return i.reply({content:"You and NexusGuard need Manage Channels permission.",ephemeral:true});
      if(!i.channel?.setTopic) return i.reply({content:"This channel does not support a topic.",ephemeral:true});
      await i.channel.setTopic(i.options.getString("text",true)); await audit(i.guildId,i.user.id,"channel.topic_changed",i.channelId);
      return i.reply({content:"Channel topic updated.",ephemeral:true});
    }
    if (n === "remind") {
      const minutes=i.options.getInteger("minutes",true), message=i.options.getString("message",true), who=i.user;
      await i.reply({content:`⏰ Reminder set for ${minutes} minute(s). Note: reminders are held in memory and won't survive a bot restart.`,ephemeral:true});
      setTimeout(()=>{ if(i.channel?.isTextBased()) i.channel.send({content:`⏰ <@${who.id}> Reminder: ${message}`,allowedMentions:{users:[who.id]}}).catch(()=>{}); },minutes*60000);
      return;
    }
    if (n === "embed") {
      const actor=await i.guild.members.fetch(i.user.id);
      if(!has(actor,PermissionFlagsBits.ManageMessages)) return i.reply({content:"You need Manage Messages permission.",ephemeral:true});
      const title=i.options.getString("title",true), description=i.options.getString("description",true);
      await i.channel.send({embeds:[new EmbedBuilder().setColor(0x8b5cf6).setTitle(title).setDescription(description).setFooter({text:`Posted by ${i.user.username}`}).setTimestamp()],allowedMentions:{parse:[]}});
      await audit(i.guildId,i.user.id,"message.embed_posted",i.channelId); return i.reply({content:"Embed posted.",ephemeral:true});
    }
    if (n === "serverstats") {
      const g=i.guild, channels=g.channels.cache, roles=g.roles.cache.filter(r=>r.id!==g.id), bots=g.members.cache.filter(m=>m.user.bot).size;
      const e=new EmbedBuilder().setColor(0x8b5cf6).setTitle(`📊 ${g.name} · Server stats`).setThumbnail(g.iconURL({size:256}))
        .addFields({name:"Members",value:String(g.memberCount),inline:true},{name:"Cached bots",value:String(bots),inline:true},{name:"Roles",value:String(roles.size),inline:true},{name:"Channels",value:String(channels.size),inline:true},{name:"Boosts",value:String(g.premiumSubscriptionCount||0),inline:true},{name:"Verification",value:String(g.verificationLevel),inline:true});
      return i.reply({embeds:[e],ephemeral:true});
    }
  } catch (error) {
    await replyError(error);
  }
});

// -------------------- EXPRESS / OAUTH --------------------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'"],
    scriptSrc:["'self'","'unsafe-inline'"],
    imgSrc:["'self'","https://cdn.discordapp.com","https://media.discordapp.net","data:"],
    connectSrc:["'self'"], frameAncestors:["'none'"]
  }}
}));
app.use(express.json({limit:"32kb"}));
app.use(session({
  name:"nexusguard.sid",
  secret:SESSION_SECRET,
  store:new PgSession({pool,tableName:"user_sessions",createTableIfMissing:false}),
  resave:false, saveUninitialized:false,
  cookie:{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",maxAge:7*24*60*60*1000}
}));
app.use("/auth",rateLimit({windowMs:15*60*1000,limit:40,standardHeaders:true,legacyHeaders:false}));
app.use("/api",rateLimit({windowMs:60*1000,limit:100,standardHeaders:true,legacyHeaders:false}));

function requireLogin(req,res,next) {
  if(!req.session.user) return res.status(401).json({error:"Sign in with Discord first."});
  next();
}
async function manageableGuilds(user) {
  const response=await fetch("https://discord.com/api/v10/users/@me/guilds",{headers:{Authorization:`Bearer ${user.accessToken}`}});
  if(response.status===401) throw new Error("Discord login expired. Sign in again.");
  if(!response.ok) throw new Error("Could not retrieve Discord servers.");
  const list=await response.json();
  return list.filter(g=>{
    const p=BigInt(g.permissions||"0");
    const canManage=Boolean(g.owner)||(p&PermissionFlagsBits.Administrator)!==0n||(p&PermissionFlagsBits.ManageGuild)!==0n;
    return (canManage||isOwner(user.id))&&client.guilds.cache.has(g.id);
  });
}
async function guildAccess(req,res,next) {
  try {
    const guildId=req.params.guildId;
    // The configured owner can administer any guild the bot is actually in.
    if (isOwner(req.session.user.id) && client.guilds.cache.has(guildId)) {
      req.guildId=guildId; return next();
    }
    const list=await manageableGuilds(req.session.user);
    if(!list.some(g=>g.id===guildId)) return res.status(403).json({error:"You cannot manage this server, or NexusGuard is not installed."});
    req.guildId=guildId; next();
  } catch(e) { next(e); }
}

app.get("/auth/login",(req,res,next)=>{
  const state=crypto.randomBytes(32).toString("hex");
  req.session.oauthState=state;
  req.session.save(err=>{
    if(err) return next(err);
    const p=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,response_type:"code",scope:"identify guilds",state});
    res.redirect(`https://discord.com/oauth2/authorize?${p}`);
  });
});
app.get("/auth/callback",async(req,res,next)=>{
  try {
    if(req.query.error) return res.redirect("/?login=cancelled");
    const {code,state}=req.query;
    if(typeof code!=="string"||typeof state!=="string"||!req.session.oauthState||state!==req.session.oauthState)
      return res.status(400).send("Invalid sign-in state. Return to the website and try again.");
    delete req.session.oauthState;
    const tokenResponse=await fetch("https://discord.com/api/v10/oauth2/token",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,grant_type:"authorization_code",code,redirect_uri:REDIRECT_URI})
    });
    const token=await tokenResponse.json();
    if(!tokenResponse.ok||!token.access_token) return res.status(502).send("Discord sign-in failed. Please try again.");
    const profileResponse=await fetch("https://discord.com/api/v10/users/@me",{headers:{Authorization:`Bearer ${token.access_token}`}});
    const profile=await profileResponse.json();
    if(!profileResponse.ok||!profile.id) return res.status(502).send("Could not load your Discord profile.");
    await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));
    req.session.user={id:profile.id,username:profile.username,globalName:profile.global_name||profile.username,avatar:profile.avatar||null,accessToken:token.access_token};
    await new Promise((resolve,reject)=>req.session.save(e=>e?reject(e):resolve()));
    res.redirect("/");
  } catch(e) { next(e); }
});
app.get("/auth/logout",(req,res)=>{
  req.session.destroy(err=>{
    if(err) return res.status(500).send("Could not sign out. Try again.");
    res.clearCookie("nexusguard.sid",{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production"});
    res.redirect("/");
  });
});

app.get("/health",async(req,res)=>{
  try {
    await pool.query("SELECT 1");
    res.json({status:"ok",website:"online",bot:client.isReady()?"online":"offline",servers:client.guilds.cache.size,uptimeSeconds:Math.floor(process.uptime())});
  } catch { res.status(503).json({status:"unhealthy"}); }
});
app.get("/api/me",(req,res)=>{
  if(!req.session.user) return res.json({loggedIn:false});
  const {id,username,globalName,avatar}=req.session.user;
  res.json({loggedIn:true,user:{id,username,globalName,avatar},isOwner:isOwner(id)});
});
app.get("/api/guilds",requireLogin,async(req,res,next)=>{
  try {
    if (isOwner(req.session.user.id)) {
      return res.json([...client.guilds.cache.values()].map(g=>({id:g.id,name:g.name,icon:g.icon,memberCount:g.memberCount,botInstalled:true})).sort((a,b)=>a.name.localeCompare(b.name)));
    }
    res.json((await manageableGuilds(req.session.user)).map(g => ({ id: g.id, name: g.name, icon: g.icon, botInstalled: true })));
  } catch(e){next(e);}
});
app.get("/api/guild/:guildId",requireLogin,guildAccess,async(req,res,next)=>{
  try {
    const guild=client.guilds.cache.get(req.guildId), settings=await getSettings(req.guildId);
    const logs=await pool.query("SELECT id,actor_id,action,target_id,details,created_at FROM audit_log WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 50",[req.guildId]);
    const channels=[...guild.channels.cache.values()]
      .filter(c=>[ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum,ChannelType.GuildVoice,ChannelType.GuildStageVoice].includes(c.type))
      .sort((a,b)=>(a.parent?.rawPosition??-1)-(b.parent?.rawPosition??-1)||a.rawPosition-b.rawPosition)
      .map(c=>({id:c.id,name:c.name,type:c.type,parentId:c.parentId,parentName:c.parent?.name||""}));
    const roles=[...guild.roles.cache.values()].filter(r=>r.id!==guild.id).sort((a,b)=>b.position-a.position).map(r=>({id:r.id,name:r.name,color:r.hexColor}));
    res.json({guild:{id:guild.id,name:guild.name,icon:guild.iconURL({size:256}),memberCount:guild.memberCount},settings,logs:logs.rows,channels,roles});
  } catch(e){next(e);}
});
app.put("/api/guild/:guildId/settings",requireLogin,guildAccess,async(req,res,next)=>{
  try {
    const settings=await getSettings(req.guildId), body=req.body||{};
    const boolKeys=["welcomeEnabled","logsEnabled","automodEnabled"];
    const strKeys=["welcomeChannel","welcomeMessage","logsChannel","moderatorRole","announcementChannel","accentColor"];
    for(const k of boolKeys) if(Object.hasOwn(body,k)){if(typeof body[k]!=="boolean")return res.status(400).json({error:`${k} must be true or false.`});settings[k]=body[k];}
    for(const k of strKeys) if(Object.hasOwn(body,k)){if(typeof body[k]!=="string"||body[k].length>500)return res.status(400).json({error:`Invalid ${k}.`});settings[k]=body[k];}
    const selectedGuild=client.guilds.cache.get(req.guildId);
    for(const k of ["welcomeChannel","logsChannel","announcementChannel"]) {
      if(settings[k] && !selectedGuild.channels.cache.has(settings[k])) return res.status(400).json({error:`Choose a valid channel from this server for ${k}.`});
    }
    if(Object.hasOwn(body,"moderatorRoles")) {
      if(!Array.isArray(body.moderatorRoles) || body.moderatorRoles.length > 25 || body.moderatorRoles.some(id=>typeof id!=="string"))
        return res.status(400).json({error:"Choose up to 25 valid moderator roles."});
      const uniqueRoles=[...new Set(body.moderatorRoles)];
      if(uniqueRoles.some(id=>!selectedGuild.roles.cache.has(id) || id===selectedGuild.id))
        return res.status(400).json({error:"Every selected moderator role must belong to this server."});
      settings.moderatorRoles=uniqueRoles;
      settings.moderatorRole=uniqueRoles[0]||""; // Backwards compatibility with older settings.
    } else if(settings.moderatorRole && !selectedGuild.roles.cache.has(settings.moderatorRole)) {
      return res.status(400).json({error:"Choose a valid role from this server."});
    }
    await saveSettings(req.guildId,settings);
    await audit(req.guildId,req.session.user.id,"settings.updated",null,{keys:[...boolKeys,...strKeys,...(Object.hasOwn(body,"moderatorRoles")?["moderatorRoles"]:[])]});
    res.json({ok:true,settings});
  } catch(e){next(e);}
});
app.get("/api/guild/:guildId/logs",requireLogin,guildAccess,async(req,res,next)=>{
  try {const r=await pool.query("SELECT id,actor_id,action,target_id,details,created_at FROM audit_log WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 100",[req.guildId]);res.json(r.rows);}
  catch(e){next(e);}
});
app.get("/api/owner/stats",requireLogin,async(req,res,next)=>{
  try {
    if(!isOwner(req.session.user.id))return res.status(403).json({error:"Owner access required."});
    const r=await pool.query(`SELECT (SELECT COUNT(*) FROM guild_settings) AS configured_servers,(SELECT COUNT(*) FROM audit_log) AS audit_events,(SELECT COUNT(*) FROM warnings) AS warning_records`);
    res.json({botReady:client.isReady(),connectedGuilds:client.guilds.cache.size,...r.rows[0]});
  } catch(e){next(e);}
});

// -------------------- NEXUSGUARD DASHBOARD --------------------
app.get("/",(req,res)=>{
  const signedIn=Boolean(req.session.user);
  const owner=signedIn && isOwner(req.session.user.id);
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#090b13"><meta name="description" content="NexusGuard Discord server protection dashboard"><title>NexusGuard — Control Center</title>
<style>
:root{color-scheme:dark;--bg:#090b13;--panel:#101522;--panel2:#151c2c;--line:#263148;--purple:#a78bfa;--cyan:#67e8f9;--text:#f4f7ff;--muted:#98a6bf;--green:#6ee7b7;--red:#fb7185;--shadow:0 22px 70px #0005}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 10% 0%,#30204c66,transparent 34%),radial-gradient(ellipse at 100% 20%,#0d536044,transparent 30%),var(--bg);color:var(--text);font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.14;background-image:linear-gradient(#8793ae18 1px,transparent 1px),linear-gradient(90deg,#8793ae18 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(#000,transparent 80%)}
a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}select[multiple]{min-height:125px;padding:8px}select[multiple] option{padding:7px;border-radius:6px}button,a.btn{border:1px solid transparent;border-radius:12px;padding:11px 15px;background:linear-gradient(110deg,#8b5cf6,#6366f1);color:white;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:transform .18s,border-color .18s,filter .18s;text-decoration:none}button:hover,a.btn:hover{transform:translateY(-1px);filter:brightness(1.1)}button:disabled{opacity:.5;cursor:wait;transform:none}.btn-ghost{background:#151c2c!important;border-color:#303b52!important;box-shadow:none!important}.btn-danger{background:#351722!important;border-color:#673044!important}.hidden{display:none!important}
.topbar{position:sticky;top:0;z-index:10;height:72px;padding:0 clamp(14px,4vw,44px);display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #283149b8;background:#090b13d9;backdrop-filter:blur(20px)}.brand{display:flex;align-items:center;gap:11px;font-weight:950;letter-spacing:1.8px;font-size:14px}.logo{display:grid;place-items:center;width:39px;height:39px;border-radius:13px;background:linear-gradient(145deg,#a78bfa,#4f46e5 58%,#22d3ee);box-shadow:0 0 28px #8b5cf644;font-size:22px;font-style:italic}.brand span{color:var(--cyan)}.top-right{display:flex;align-items:center;gap:10px}.live-pill{display:flex;align-items:center;gap:8px;border:1px solid #244a43;background:#10251f;color:var(--green);border-radius:999px;padding:7px 11px;font-size:11px;font-weight:850;text-transform:uppercase;letter-spacing:.8px}.dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor}
.layout{position:relative;max-width:1450px;margin:auto;padding:28px clamp(12px,3vw,36px) 60px;display:grid;grid-template-columns:245px minmax(0,1fr);gap:24px}.sidebar{align-self:start;position:sticky;top:96px;border:1px solid var(--line);background:#0e1320e8;border-radius:20px;padding:18px;box-shadow:var(--shadow)}.side-brand{font-size:10px;color:#66758f;letter-spacing:1.7px;font-weight:900;padding:4px 10px 12px}.nav{display:grid;gap:5px}.nav button{justify-content:flex-start;background:transparent;color:#aab6cc;border:1px solid transparent;box-shadow:none;padding:11px 12px;font-weight:700;text-align:left}.nav button.active,.nav button:hover{background:linear-gradient(90deg,#8b5cf622,#22d3ee0c);border-color:#6454a34d;color:white}.nav .ico{width:24px;font-size:16px}.side-bottom{border-top:1px solid var(--line);margin-top:18px;padding-top:16px}.profile{display:flex;align-items:center;gap:10px;min-width:0}.avatar{width:36px;height:36px;flex-shrink:0;border-radius:12px;background:linear-gradient(135deg,#a78bfa,#22d3ee);display:grid;place-items:center;font-weight:900;overflow:hidden}.avatar img{width:100%;height:100%;object-fit:cover}.profile-name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.profile-sub{font-size:11px;color:var(--muted)}.main{min-width:0}.welcome{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:3px 0 24px}.eyebrow{font-size:10px;letter-spacing:2px;color:var(--cyan);font-weight:900;text-transform:uppercase}.welcome h1{font-size:clamp(28px,4vw,42px);letter-spacing:-1.6px;line-height:1.1;margin:9px 0}.welcome p{color:var(--muted);margin:0;max-width:650px}.owner-label{display:inline-flex;align-items:center;gap:7px;border:1px solid #6e4d9a;background:#291b42;color:#d8c7ff;border-radius:999px;padding:8px 12px;font-size:11px;font-weight:900;letter-spacing:.6px;white-space:nowrap}.hero{position:relative;overflow:hidden;border:1px solid #4c4777;background:linear-gradient(115deg,#1b1930 0%,#141d31 54%,#10242d 100%);border-radius:22px;padding:clamp(22px,4vw,34px);box-shadow:var(--shadow)}.hero:after{content:"N";position:absolute;right:3%;top:-45px;font-size:clamp(160px,22vw,280px);line-height:1;font-weight:1000;color:#c4b5fd08;transform:skew(-10deg);pointer-events:none}.hero-inner{position:relative;z-index:1;max-width:720px}.hero h2{font-size:clamp(25px,3.5vw,36px);line-height:1.16;letter-spacing:-1px;margin:12px 0}.hero p{color:#b5c1d6;max-width:600px;margin:0 0 20px}.actions{display:flex;flex-wrap:wrap;gap:8px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin:17px 0 22px}.metric,.panel,.server-card{border:1px solid var(--line);background:linear-gradient(145deg,#121827f2,#0e1421f2);border-radius:17px;box-shadow:0 12px 35px #0002}.metric{padding:18px;min-width:0}.metric-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--muted);font-size:12px}.metric-icon{display:grid;place-items:center;width:33px;height:33px;border-radius:11px;background:#8b5cf61a;color:#c4b5fd;font-size:16px}.metric-value{font-size:clamp(22px,3vw,32px);font-weight:950;letter-spacing:-1px;margin-top:13px;overflow-wrap:anywhere}.metric-foot{font-size:11px;color:#71809a;margin-top:3px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:12px;margin:28px 0 13px}.section-head h2{font-size:19px;margin:0}.section-head p{font-size:12px;color:var(--muted);margin:3px 0 0}.panel{padding:21px;margin-top:16px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}.panel h2,.panel h3{margin:0;font-size:17px}.muted{color:var(--muted)}.tiny{font-size:11px}.server-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.server-card{padding:16px;display:flex;align-items:center;gap:13px;text-align:left;min-width:0;transition:border-color .2s,transform .2s;cursor:pointer}.server-card:hover{border-color:#8b5cf6;transform:translateY(-2px)}.server-card.selected{border-color:#8b5cf6;background:linear-gradient(135deg,#221b3c,#101b2a)}.server-icon{width:46px;height:46px;flex-shrink:0;border-radius:15px;background:#222b40;display:grid;place-items:center;font-weight:900;font-size:17px;overflow:hidden}.server-icon img{width:100%;height:100%;object-fit:cover}.server-name{font-weight:850;overflow-wrap:anywhere}.server-meta{font-size:11px;color:var(--muted);margin-top:3px}.server-arrow{margin-left:auto;color:#72819b;font-size:18px}.toolbar{display:flex;gap:10px;flex-wrap:wrap}.toolbar select{flex:1;min-width:180px}.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}label.field{display:block;color:#d6deed;font-weight:750;font-size:12px;margin:12px 0}input[type=text],input[type=number],select,textarea{width:100%;padding:12px 13px;background:#090e19;color:var(--text);border:1px solid #303c54;border-radius:11px;margin-top:7px;outline:none}textarea{min-height:100px;resize:vertical}input:focus,select:focus,textarea:focus{border-color:var(--purple);box-shadow:0 0 0 3px #a78bfa20}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid #273148}.toggle-row:last-child{border-bottom:0}.toggle-title{font-weight:800}.toggle-desc{font-size:11px;color:var(--muted);margin-top:3px}.switch{appearance:none;width:43px;height:25px;flex-shrink:0;border-radius:99px;background:#30394c;position:relative;cursor:pointer;transition:.2s}.switch:before{content:"";position:absolute;width:19px;height:19px;left:3px;top:3px;border-radius:50%;background:white;transition:.2s}.switch:checked{background:#8b5cf6}.switch:checked:before{transform:translateX(18px)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:460px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #252f44;font-size:12px}th{color:#9eacc4;background:#121a29;font-size:10px;text-transform:uppercase;letter-spacing:1px}tr:last-child td{border-bottom:0}.event{font-weight:800}.tag{display:inline-flex;border-radius:8px;padding:4px 8px;background:#1b2940;color:#a9c8ff;font-size:10px;font-weight:850}.empty{padding:28px 12px;text-align:center;border:1px dashed #34415c;border-radius:14px;color:var(--muted)}.notice{padding:12px 14px;border:1px solid #28574b;background:#10261f;border-radius:12px;color:#a7f3d0;font-size:12px;margin:12px 0}.error{border-color:#713344;background:#2b1520;color:#fecdd3}.footer{text-align:center;padding:20px;color:#66758d;font-size:11px}.mobile-nav{display:none}
@media(max-width:1050px){.layout{grid-template-columns:205px minmax(0,1fr);gap:15px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.server-grid{grid-template-columns:1fr}}
@media(max-width:700px){.topbar{height:62px;padding:0 13px}.brand{font-size:12px;letter-spacing:1px;gap:8px}.logo{width:34px;height:34px;border-radius:11px}.live-pill{display:none}.top-right .btn{padding:9px 11px;font-size:12px}.layout{display:block;padding:18px 12px 90px}.sidebar{display:none}.welcome{margin-bottom:17px}.welcome h1{font-size:30px;letter-spacing:-1px}.owner-label{font-size:9px;padding:7px 9px}.hero{border-radius:18px;padding:22px 18px}.hero h2{font-size:26px}.metrics{gap:9px;margin:12px 0 18px}.metric{padding:13px;border-radius:14px}.metric-head{font-size:10px}.metric-icon{width:28px;height:28px}.metric-value{font-size:25px}.metric-foot{font-size:10px}.panel{padding:16px;border-radius:15px}.section-head{margin-top:23px}.field-grid{grid-template-columns:1fr}.mobile-nav{display:flex;position:fixed;z-index:20;bottom:0;left:0;right:0;padding:8px 7px calc(8px + env(safe-area-inset-bottom));background:#0b101ceF;backdrop-filter:blur(20px);border-top:1px solid #303b52;justify-content:space-around;gap:4px}.mobile-nav button{flex:1;display:flex;flex-direction:column;gap:3px;padding:7px 3px;background:transparent;border:0;box-shadow:none;color:#8f9db5;font-size:9px}.mobile-nav button.active{color:#c4b5fd;background:#8b5cf61c}.mobile-nav .nav-ico{font-size:17px}.section-head .btn{padding:9px 10px;font-size:11px}.server-card{padding:13px}.server-icon{width:40px;height:40px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important}}

/* NexusGuard visual refresh — premium, crisp, and mobile-first */
:root{--bg:#070a12;--panel:#0e1422;--panel2:#131d30;--line:#26344b;--purple:#9b8cff;--cyan:#62e7f5;--text:#f5f7ff;--muted:#9ba9c2;--green:#70efc0;--shadow:0 24px 80px #0007}
body{background:radial-gradient(ellipse at 12% -12%,#5842a533,transparent 38%),radial-gradient(ellipse at 95% 5%,#087f8e20,transparent 31%),#070a12;letter-spacing:.005em}
body:before{opacity:.09;background-size:42px 42px;mask-image:linear-gradient(#000,transparent 65%)}
.topbar{height:78px;padding-inline:clamp(16px,4vw,54px);background:#080c16d9;border-bottom-color:#253148;box-shadow:0 8px 36px #0002}
.brand{font-size:13px;letter-spacing:2.2px}.logo{width:43px;height:43px;border-radius:15px;background:linear-gradient(145deg,#a99bff,#6d5df6 52%,#43d8e8);box-shadow:0 0 0 5px #9385ff12,0 8px 28px #7665ff3b;font-size:23px}
.top-right .btn{border-radius:13px;padding:11px 16px;box-shadow:0 8px 24px #7764ff22}
.layout{max-width:1580px;padding-top:34px;grid-template-columns:255px minmax(0,1fr);gap:28px}
.sidebar{top:98px;border-color:#28334a;background:linear-gradient(165deg,#101727f5,#0b101bf5);border-radius:23px;padding:17px;box-shadow:0 18px 60px #0003}
.side-brand{color:#7686a4;font-size:10px;letter-spacing:2px;padding:9px 11px 13px}
.nav{gap:7px}.nav button{border-radius:13px;padding:12px 13px;color:#aebbd1;font-size:13px}.nav button.active{background:linear-gradient(100deg,#8b7cff25,#59d9e512);border-color:#897aff40;color:#fff;box-shadow:inset 3px 0 #9d8cff}.nav button.active .ico{color:#b7aaff}.nav .ico{width:26px;color:#8493af}
.profile{padding:3px}.avatar{border-radius:13px;box-shadow:0 0 0 3px #9d8cff1b}
.welcome{align-items:center;margin:0 0 25px}.welcome h1{font-size:clamp(31px,4vw,46px);letter-spacing:-2px;margin:10px 0 11px}.welcome p{line-height:1.75;font-size:14px}.eyebrow{letter-spacing:2.5px;font-size:10px}
.hero{border-radius:26px;border-color:#484b7b;background:radial-gradient(ellipse at 90% 15%,#5be2ed1b,transparent 35%),linear-gradient(120deg,#211b3c 0%,#171d33 50%,#102a35 100%);padding:clamp(27px,4vw,43px);box-shadow:0 22px 75px #0003,inset 0 1px #ffffff0b}
.hero:before{content:"";position:absolute;width:250px;height:250px;right:7%;top:5%;border:1px solid #9d8cff21;border-radius:50%;box-shadow:0 0 0 30px #9d8cff08,0 0 0 65px #9d8cff05;pointer-events:none}
.hero:after{right:4%;top:-28px;color:#d8d1ff08;font-size:clamp(180px,23vw,300px)}.hero-inner{max-width:760px}.hero h2{font-size:clamp(28px,3.5vw,41px);letter-spacing:-1.5px;line-height:1.13;margin:14px 0}.hero p{line-height:1.8;font-size:14px;color:#c0cbe0;max-width:620px;margin-bottom:24px}
button,a.btn{border-radius:13px;padding:12px 16px;font-weight:800;box-shadow:0 8px 24px #7764ff20}button:hover,a.btn:hover{transform:translateY(-2px);filter:brightness(1.08)}.btn-ghost{background:#151e30!important;border-color:#34415a!important;color:#e4eaff!important}.actions{gap:10px}
.metrics{gap:14px;margin:20px 0 25px}.metric{position:relative;overflow:hidden;padding:19px;border-radius:19px;border-color:#28364e;background:linear-gradient(145deg,#121b2c,#0c121f);box-shadow:0 14px 35px #0002}.metric:after{content:"";position:absolute;width:80px;height:80px;right:-36px;bottom:-43px;border-radius:50%;background:#9485ff10}.metric-head{font-size:12px;font-weight:650}.metric-icon{width:37px;height:37px;border-radius:13px;background:linear-gradient(145deg,#8d7cff27,#51dce51a);border:1px solid #8f85ff1c;color:#c4baff}.metric-value{font-size:clamp(25px,3vw,35px);margin-top:15px;letter-spacing:-1.3px}.metric-foot{color:#8796b0;margin-top:5px}
.section-head{margin:32px 0 15px}.section-head h2{font-size:20px;letter-spacing:-.4px}.section-head p{font-size:12px;line-height:1.6}.panel{border-radius:20px;padding:23px;margin-top:17px;background:linear-gradient(150deg,#111a2a,#0c121f);border-color:#28354c;box-shadow:0 15px 45px #0002}.panel-head{margin-bottom:18px}.panel h2,.panel h3{letter-spacing:-.3px}.server-grid{gap:13px}.server-card{border-radius:17px;border-color:#28364d;background:linear-gradient(140deg,#131d2e,#0d1421);padding:17px;box-shadow:0 8px 24px #0002}.server-card:hover{border-color:#9284ff;box-shadow:0 13px 35px #0003,0 0 0 1px #9284ff18}.server-card.selected{border-color:#9b8cff;background:linear-gradient(135deg,#292345,#10232f);box-shadow:0 0 0 2px #9b8cff19}.server-icon{border-radius:15px;background:linear-gradient(145deg,#29334d,#182337);border:1px solid #ffffff0a}.server-name{font-size:13px}.server-meta{line-height:1.5}
.field-grid{gap:15px}label.field{font-size:12px;letter-spacing:.01em}input[type=text],input[type=number],select,textarea{background:#090f1b;border-color:#303d55;border-radius:13px;padding:13px 14px}input:focus,select:focus,textarea:focus{border-color:#9b8cff;box-shadow:0 0 0 4px #9b8cff18}
.toggle-row{padding:16px 0;border-color:#253148}.toggle-title{font-size:13px}.toggle-desc{line-height:1.55}.switch{width:46px;height:27px}.switch:before{width:21px;height:21px}.switch:checked:before{transform:translateX(19px)}
.table-wrap{border-radius:15px;border-color:#2a374e}th{background:#141d2d;color:#aab8d0}th,td{padding:14px 15px}td{color:#d6deee}.empty{border-color:#35435c;background:#0c1320;color:#9aa9c3;border-radius:16px;padding:31px 15px;line-height:1.7}.notice{border-radius:14px;padding:13px 15px}.owner-label{border-color:#7960b2;background:#251b3c;color:#dfd2ff}
.footer{padding:28px 10px;color:#7785a0}
@media(max-width:1050px){.layout{grid-template-columns:220px minmax(0,1fr);gap:18px}.metrics{gap:10px}.metric{padding:15px}}
@media(max-width:700px){.topbar{height:66px;padding:0 14px}.brand{font-size:11px;letter-spacing:1.5px}.logo{width:36px;height:36px;border-radius:12px}.top-right .btn{padding:9px 11px;border-radius:11px}.layout{padding:19px 13px calc(105px + env(safe-area-inset-bottom));}.welcome{align-items:flex-start;gap:9px}.welcome h1{font-size:31px;line-height:1.13;letter-spacing:-1.2px}.welcome p{font-size:13px;line-height:1.7}.hero{padding:24px 19px;border-radius:21px}.hero:before{width:150px;height:150px;right:-25px;top:20px}.hero:after{font-size:170px;right:-3%;top:0}.hero h2{font-size:28px;letter-spacing:-1px}.hero p{font-size:13px;line-height:1.75}.hero .actions{display:grid;grid-template-columns:1fr}.hero .actions a,.hero .actions button{width:100%}.metrics{gap:9px;margin:14px 0 20px}.metric{padding:13px 12px;border-radius:15px}.metric-head{align-items:flex-start;font-size:10px;line-height:1.4}.metric-icon{width:29px;height:29px;border-radius:10px}.metric-value{font-size:25px;margin-top:11px}.metric-foot{font-size:9px}.panel{padding:16px;border-radius:17px}.section-head{margin-top:25px}.section-head h2{font-size:18px}.server-grid{grid-template-columns:1fr;gap:10px}.server-card{padding:14px;border-radius:15px}.server-icon{width:42px;height:42px}.toolbar{gap:8px}.toolbar select{min-width:100%}.mobile-nav{padding:8px 8px calc(9px + env(safe-area-inset-bottom));background:#080d18ed;border-top:1px solid #2b3750;box-shadow:0 -12px 35px #0004}.mobile-nav button{border-radius:12px;font-size:9px;min-height:48px}.mobile-nav button.active{color:#d1c9ff;background:linear-gradient(135deg,#8b7cff22,#55dce510)}.field-grid{grid-template-columns:1fr}.section-head .btn{padding:9px 10px}.owner-label{font-size:9px;padding:7px 9px}.table-wrap{max-width:100%}th,td{padding:12px;font-size:11px}}

</style></head><body>
<header class="topbar"><a class="brand" href="/"><span class="logo">N</span><span>NEXUS<span>GUARD</span></span></a><div class="top-right"><span class="live-pill"><i class="dot"></i><span id="topStatus">Connecting</span></span><a class="btn" href="${signedIn?"/auth/logout":"/auth/login"}">${signedIn?"Sign out":"Connect Discord ↗"}</a></div></header>
<div class="layout">
<aside class="sidebar"><div class="side-brand">WORKSPACE</div><nav class="nav" id="sideNav"><button class="active" data-view="overview"><span class="ico">◈</span> Overview</button><button data-view="servers"><span class="ico">▦</span> My servers</button><button data-view="settings"><span class="ico">⚙</span> Configuration</button><button data-view="activity"><span class="ico">≋</span> Audit activity</button>${owner?'<div class="side-brand" style="margin-top:14px">PRIVATE OWNER TOOLS</div><button data-view="owner"><span class="ico">♛</span> Owner HQ</button>':''}</nav><div class="side-bottom ${signedIn?"":"hidden"}"><div class="profile"><div class="avatar" id="sideAvatar">N</div><div style="min-width:0"><div class="profile-name" id="sideName">Signed out</div><div class="profile-sub">${owner?"Owner access":"Discord account"}</div></div></div></div><div class="${signedIn?"hidden":""}" style="padding:10px;color:var(--muted);font-size:12px">Connect Discord to access your server dashboard.</div></aside>
<main class="main">
<section class="welcome"><div><div class="eyebrow">CONTROL CENTER / ${owner?"OWNER WORKSPACE":"COMMUNITY MANAGEMENT"}</div><h1 id="greeting">${signedIn?"Welcome back.":"Protection starts here."}</h1><p>${owner?"Your private command center. Monitor the network, manage every connected server, and access the same tools as your members.":"Your Discord communities, protection settings, and activity — all in one place."}</p></div>${owner?'<span class="owner-label">♛ OWNER ACCESS</span>':''}</section>
<section class="hero"><div class="hero-inner"><div class="eyebrow">NEXUSGUARD SECURITY SUITE</div><h2>${signedIn?(owner?"Your network. Your rules.":"Your community, under control."):"A smarter command center for your community."}</h2><p>${signedIn?"Manage settings, review activity, and keep your Discord server running smoothly from one responsive dashboard.":"Connect your Discord account to manage the servers where you have permission. Your server data stays separated by access."}</p><div class="actions">${signedIn?'<button id="jumpServers">▦ Choose a server</button><button class="btn-ghost" id="refreshBtn">↻ Refresh data</button>':'<a class="btn" href="/auth/login">Continue with Discord ↗</a>'}<a class="btn btn-ghost" href="https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&scope=bot%20applications.commands&permissions=0">＋ Add NexusGuard</a></div></div></section>
<section class="metrics" id="metrics"><article class="metric"><div class="metric-head"><span>${owner?"Connected servers":"Available servers"}</span><span class="metric-icon">▦</span></div><div class="metric-value" id="mServers">—</div><div class="metric-foot">${owner?"Across the bot network":"You can manage"}</div></article><article class="metric"><div class="metric-head"><span>Bot status</span><span class="metric-icon">◉</span></div><div class="metric-value" id="mBot">—</div><div class="metric-foot" id="mBotFoot">Checking connection</div></article><article class="metric"><div class="metric-head"><span>${owner?"Audit events":"Selected server"}</span><span class="metric-icon">≋</span></div><div class="metric-value" id="mActivity">—</div><div class="metric-foot">${owner?"Recorded across the platform":"Choose a server below"}</div></article><article class="metric"><div class="metric-head"><span>${owner?"Warning records":"Protection"}</span><span class="metric-icon">⛨</span></div><div class="metric-value" id="mProtection">${owner?"—":"Ready"}</div><div class="metric-foot">${owner?"Database warning records":"Server-specific controls"}</div></article></section>
<section class="view" id="view-overview"><div class="section-head"><div><h2>${owner?"Network overview":"Your servers"}</h2><p>${owner?"Every server connected to NexusGuard":"Only servers you can manage with NexusGuard installed"}</p></div><button class="btn btn-ghost" id="viewAllServers">View all →</button></div><div class="server-grid" id="serverGrid"><div class="empty">Loading server list…</div></div><section class="panel"><div class="panel-head"><div><h2>Quick actions</h2><div class="muted tiny">Jump into the tools you use most</div></div></div><div class="actions"><button class="btn-ghost" data-jump="settings">⚙ Server settings</button><button class="btn-ghost" data-jump="activity">≋ View audit activity</button>${owner?'<button data-jump="owner">♛ Open Owner HQ</button>':''}</div></section></section>
<section class="view hidden" id="view-servers"><div class="section-head"><div><h2>Server directory</h2><p>Choose a server to manage its configuration and activity.</p></div><button class="btn btn-ghost" id="reloadServers">↻ Refresh</button></div><div class="toolbar"><select id="serverSelect"><option value="">Choose a server…</option></select><input type="text" id="serverSearch" placeholder="Search servers…" style="max-width:250px"></div><div class="server-grid" id="allServerGrid" style="margin-top:14px"></div></section>
<section class="view hidden" id="view-settings"><div class="section-head"><div><h2>Server configuration</h2><p id="settingsSubtitle">Select a server to view its settings.</p></div></div><div class="panel" id="settingsPanel"><div class="empty">Choose a server from the directory to load its configuration.</div></div></section>
<section class="view hidden" id="view-activity"><div class="section-head"><div><h2>Audit activity</h2><p id="activitySubtitle">Recorded configuration and moderation events.</p></div><button class="btn btn-ghost" id="reloadActivity">↻ Refresh</button></div><div class="panel"><div id="activityTable" class="empty">Choose a server to view its activity.</div></div></section>
${owner?'<section class="view hidden" id="view-owner"><div class="section-head"><div><h2>Owner HQ</h2><p>Private platform-wide visibility and administration.</p></div><span class="owner-label">♛ OWNER ONLY</span></div><div class="notice">Owner APIs are checked on the server. This panel is not the security boundary; your owner identity is.</div><div class="metrics" style="grid-template-columns:repeat(2,minmax(0,1fr))"><article class="metric"><div class="metric-head">Configured servers</div><div class="metric-value" id="oConfigured">—</div></article><article class="metric"><div class="metric-head">Warning records</div><div class="metric-value" id="oWarnings">—</div></article></div><div class="panel"><div class="panel-head"><div><h2>Platform telemetry</h2><div class="muted tiny">Live values from NexusGuard backend</div></div><button id="loadOwner" class="btn">Refresh stats</button></div><div id="ownerDetails" class="empty">Tap refresh to load owner statistics.</div></div><div class="panel"><div class="panel-head"><div><h2>Network server inventory</h2><div class="muted tiny">Select any server the bot is currently in.</div></div></div><div id="ownerInventory" class="server-grid"></div></div></section>':''}
<div class="footer">NEXUSGUARD • Secure by design. Built for communities.</div>
</main></div>
${signedIn?'<nav class="mobile-nav" id="mobileNav"><button class="active" data-view="overview"><span class="nav-ico">◈</span>Home</button><button data-view="servers"><span class="nav-ico">▦</span>Servers</button><button data-view="settings"><span class="nav-ico">⚙</span>Settings</button><button data-view="activity"><span class="nav-ico">≋</span>Activity</button>'+(owner?'<button data-view="owner"><span class="nav-ico">♛</span>Owner</button>':'')+'</nav>':''}
<script>
const SIGNED_IN=${JSON.stringify(signedIn)},IS_OWNER=${JSON.stringify(owner)};
let guilds=[],selectedGuild="",guildDetails=null;
const $=id=>document.getElementById(id);
async function api(url,options={}){const r=await fetch(url,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||"Request failed ("+r.status+")");return data}
function node(tag,txt,cls){const n=document.createElement(tag);if(txt!==undefined)n.textContent=txt;if(cls)n.className=cls;return n}
function iconFor(g){if(g.icon)return "https://cdn.discordapp.com/icons/"+g.id+"/"+g.icon+".png?size=96";return ""}
function serverCard(g){const b=node("button",undefined,"server-card"+(g.id===selectedGuild?" selected":""));b.type="button";const ico=node("div",undefined,"server-icon"),src=iconFor(g);if(src){const img=document.createElement("img");img.src=src;img.alt="";img.onerror=()=>{ico.textContent=(g.name||"?").slice(0,1).toUpperCase()};ico.appendChild(img)}else ico.textContent=(g.name||"?").slice(0,1).toUpperCase();const copy=node("div");copy.style.minWidth="0";copy.append(node("div",g.name,"server-name"),node("div",IS_OWNER&&g.memberCount!=null?g.memberCount.toLocaleString()+" members · Connected":"NexusGuard installed","server-meta"));b.append(ico,copy,node("span","›","server-arrow"));b.addEventListener("click",()=>chooseGuild(g.id));return b}
function renderGuilds(){const grid=$("serverGrid"),all=$("allServerGrid"),sel=$("serverSelect");grid.replaceChildren();all.replaceChildren();sel.replaceChildren(new Option("Choose a server…",""));if(!guilds.length){grid.append(node("div","No connected servers found. Add NexusGuard to a server and make sure you have permission to manage it.","empty"));all.append(node("div","No servers available.","empty"));return}guilds.forEach(g=>{grid.append(serverCard(g));all.append(serverCard(g));sel.append(new Option(g.name,g.id))});sel.value=selectedGuild||"";if(IS_OWNER&&$("ownerInventory")){ $("ownerInventory").replaceChildren(); guilds.forEach(g=>$("ownerInventory").append(serverCard(g))) }}
async function loadStatus(){try{const s=await api("/health");$("topStatus").textContent=s.bot==="online"?"Systems operational":"Bot "+s.bot;$("mBot").textContent=s.bot==="online"?"Online":"Offline";$("mBotFoot").textContent="Website "+s.website;$("mServers").textContent=String(IS_OWNER?s.servers:guilds.length)}catch{$("topStatus").textContent="Status unavailable";$("mBot").textContent="Unknown";$("mBotFoot").textContent="Could not reach status endpoint"}}
async function loadGuilds(){if(!SIGNED_IN)return;try{guilds=await api("/api/guilds");if(!guilds.some(g=>g.id===selectedGuild))selectedGuild="";renderGuilds();$("mServers").textContent=String(guilds.length);if(IS_OWNER)await loadOwnerStats();if(selectedGuild)await chooseGuild(selectedGuild,false)}catch(e){$("serverGrid").replaceChildren(node("div",e.message,"empty error"))}}
function switchView(view){document.querySelectorAll(".view").forEach(x=>x.classList.toggle("hidden",x.id!=="view-"+view));document.querySelectorAll("[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));if(view==="settings"&&!selectedGuild)$("settingsSubtitle").textContent="Choose a server in My servers first.";if(view==="owner"&&IS_OWNER)loadOwnerStats();window.scrollTo({top:0,behavior:"smooth"})}
async function chooseGuild(id,navigate=true){selectedGuild=id;const g=guilds.find(x=>x.id===id);$("serverSelect").value=id;renderGuilds();if(!id)return;try{const d=await api("/api/guild/"+encodeURIComponent(id));guildDetails=d;$("mActivity").textContent=String((d.logs||[]).length);$("mProtection").textContent=[d.settings.welcomeEnabled,d.settings.logsEnabled,d.settings.automodEnabled].filter(Boolean).length+"/3";$("settingsSubtitle").textContent=d.guild.name+" · "+(d.guild.memberCount??"")+" members";renderSettings(d);renderActivity(d.logs||[]);if(navigate)switchView("settings")}catch(e){$("settingsPanel").replaceChildren(node("div",e.message,"empty error"));if(navigate)switchView("settings")}}
function renderSettings(d){const root=$("settingsPanel");root.replaceChildren();const toggles=[["welcomeEnabled","Welcome messages","Send a welcome when a member joins."],["logsEnabled","Join / event logging","Record supported events in your configured log channel."],["automodEnabled","Basic AutoMod","Enable the configured basic automod feature."]];const togglePanel=node("div");toggles.forEach(([key,title,desc])=>{const row=node("div",undefined,"toggle-row"),copy=node("div");copy.append(node("div",title,"toggle-title"),node("div",desc,"toggle-desc"));const input=document.createElement("input");input.type="checkbox";input.className="switch";input.checked=Boolean(d.settings[key]);input.setAttribute("aria-label",title);input.addEventListener("change",async()=>{input.disabled=true;try{const r=await api("/api/guild/"+encodeURIComponent(selectedGuild)+"/settings",{method:"PUT",body:JSON.stringify({[key]:input.checked})});d.settings=r.settings;showNotice(root,title+" updated.")}catch(e){input.checked=!input.checked;showNotice(root,e.message,true)}finally{input.disabled=false}});row.append(copy,input);togglePanel.append(row)});root.append(node("h3","Protection controls"),togglePanel);
const fields=[["welcomeChannel","Welcome channel","channel"],["welcomeMessage","Welcome message","textarea"],["logsChannel","Logging channel","channel"],["moderatorRoles","Moderator roles","roles"],["announcementChannel","Announcement channel","channel"]];const form=node("div");form.className="field-grid";const inputs={};fields.forEach(([key,title,type])=>{const label=node("label",title,"field");let input;if(type==="textarea"){input=document.createElement("textarea");input.rows=3;input.placeholder="Welcome {user} to {server}!"}else{input=document.createElement("select");if(type==="roles"){input.multiple=true;input.size=Math.min(7,Math.max(4,(d.roles||[]).length));input.setAttribute("aria-label","Select one or more moderator roles");input.title="Hold Ctrl/Command on desktop, or tap roles on mobile, to select multiple roles";const selected=new Set(d.settings.moderatorRoles|| (d.settings.moderatorRole?[d.settings.moderatorRole]:[]));(d.roles||[]).forEach(r=>{const opt=new Option(r.name,r.id);opt.selected=selected.has(r.id);input.append(opt)})}else{input.append(new Option("Disabled — don't send", ""));const opts=(d.channels||[]).filter(c=>c.type===0||c.type===5||c.type===15);opts.forEach(c=>{const prefix=c.type===5?"📣 ":c.type===15?"🗂 ":"# ";input.append(new Option(prefix+c.name+(c.parentName?" · "+c.parentName:""),c.id))});input.value=d.settings[key]||""}}input.dataset.setting=key;label.append(input);if(type==="roles"){const hint=node("span","Select as many moderator roles as you need.","tiny muted");label.append(hint)}form.append(label);inputs[key]=input});const save=node("button","Save configuration");save.style.marginTop="14px";save.addEventListener("click",async()=>{save.disabled=true;try{const body={};fields.forEach(([k,,type])=>body[k]=type==="roles"?Array.from(inputs[k].selectedOptions).map(o=>o.value):inputs[k].value.trim());const r=await api("/api/guild/"+encodeURIComponent(selectedGuild)+"/settings",{method:"PUT",body:JSON.stringify(body)});d.settings=r.settings;showNotice(root,"Configuration saved successfully.");}catch(e){showNotice(root,e.message,true)}finally{save.disabled=false}});root.append(node("h3","Channels, roles and messages"),form,save);root.append(node("p","Choose channels by name and select multiple roles when needed. Options are loaded directly from the selected Discord server.","tiny muted"))}
function showNotice(root,message,isError=false){let n=root.querySelector(".notice");if(!n){n=node("div",undefined,"notice");root.prepend(n)}n.textContent=message;n.classList.toggle("error",isError)}
function renderActivity(logs){const root=$("activityTable");root.replaceChildren();$("activitySubtitle").textContent=selectedGuild?(guildDetails?.guild?.name||"Selected server")+" · Recent audit records":"Select a server to view its activity.";if(!logs.length){root.append(node("div","No audit events have been recorded for this server yet.","empty"));return}const wrap=node("div",undefined,"table-wrap"),table=document.createElement("table"),thead=document.createElement("thead"),tr=document.createElement("tr");["Event","Actor","Time"].forEach(t=>tr.append(node("th",t)));thead.append(tr);table.append(thead);const tbody=document.createElement("tbody");logs.forEach(log=>{const row=document.createElement("tr");row.append(node("td",log.action||"Event","event"),node("td",log.actor_id||"System"),node("td",log.created_at?new Date(log.created_at).toLocaleString():"—"));tbody.append(row)});table.append(tbody);wrap.append(table);root.append(wrap)}
async function loadOwnerStats(){if(!IS_OWNER)return;try{const s=await api("/api/owner/stats");$("oConfigured").textContent=s.configured_servers??"—";$("oWarnings").textContent=s.warning_records??"—";$("mActivity").textContent=s.audit_events??"—";$("mProtection").textContent=s.warning_records??"—";const box=$("ownerDetails");box.className="";box.replaceChildren();const table=document.createElement("table"),body=document.createElement("tbody");[["Bot status",s.botReady?"Online":"Offline"],["Connected servers",s.connectedGuilds],["Configured servers",s.configured_servers],["Audit events",s.audit_events],["Warning records",s.warning_records]].forEach(([a,b])=>{const tr=document.createElement("tr");tr.append(node("td",a),node("td",String(b)));body.append(tr)});table.append(body);box.append(table)}catch(e){$("ownerDetails").className="empty error";$("ownerDetails").textContent=e.message}}
function bind(){document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));document.querySelectorAll("[data-jump]").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.jump)));$("jumpServers")?.addEventListener("click",()=>switchView("servers"));$("viewAllServers")?.addEventListener("click",()=>switchView("servers"));$("reloadServers")?.addEventListener("click",loadGuilds);$("refreshBtn")?.addEventListener("click",async()=>{await loadStatus();await loadGuilds()});$("serverSelect")?.addEventListener("change",e=>chooseGuild(e.target.value));$("serverSearch")?.addEventListener("input",e=>{const q=e.target.value.toLowerCase();const list=$("allServerGrid");list.replaceChildren();guilds.filter(g=>g.name.toLowerCase().includes(q)).forEach(g=>list.append(serverCard(g)))});$("reloadActivity")?.addEventListener("click",()=>selectedGuild?chooseGuild(selectedGuild,false):switchView("servers"));$("loadOwner")?.addEventListener("click",loadOwnerStats)}
async function init(){bind();if(SIGNED_IN){try{const me=await api("/api/me");if(me.loggedIn){const name=me.user.globalName||me.user.username;$("sideName").textContent=name;$("greeting").textContent="Welcome back, "+name.split(" ")[0]+".";if(me.user.avatar)$("sideAvatar").innerHTML='<img alt="" src="https://cdn.discordapp.com/avatars/'+encodeURIComponent(me.user.id)+'/'+encodeURIComponent(me.user.avatar)+'.png?size=96">';else $("sideAvatar").textContent=name.slice(0,1).toUpperCase()}}catch(e){console.warn(e)}await loadGuilds()}await loadStatus()}
init();
</script></body></html>`);
});

app.use((error, req, res, next) => {
  console.error("HTTP error:", error);
  if (res.headersSent) return next(error);
  if (req.path.startsWith("/api/")) return res.status(500).json({error:"An internal server error occurred."});
  res.status(500).send("NexusGuard encountered an error. Please try again later.");
});

let server;
async function start() {
  await initDatabase();
  await registerCommands();
  await client.login(TOKEN);
  server=app.listen(PORT,"0.0.0.0",()=>console.log(`NexusGuard website listening on ${PORT}; ${WEBSITE_URL}`));
}
async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  if(server) await new Promise(resolve=>server.close(resolve));
  client.destroy();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
start().catch(error=>{console.error("NexusGuard startup failed:",error);process.exit(1);});
