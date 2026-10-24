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
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const result = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log(`Registered ${result.length} global slash commands.`);
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
  const n = i.commandName;
  const replyError = async e => {
    console.error(`/${n}:`, e);
    const payload = { content: "Command failed. Check Render logs for details.", ephemeral: true };
    if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
    else await i.reply(payload).catch(() => {});
  };

  try {
    if (!i.inGuild() && !["website","help","invite","ping","botinfo","uptime"].includes(n)) {
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

    if (n === "help") {
      const e = new EmbedBuilder().setColor(0x8b5cf6).setTitle("🛡️ NexusGuard Commands")
        .setDescription(
          "**General:** /website /help /invite /ping /botinfo /uptime\n\n" +
          "**Server:** /serverinfo /membercount /servericon /userinfo /avatar /roleinfo /channelinfo /rolelist /channellist\n\n" +
          "**Moderation:** /warn /warnings /timeout /untimeout /kick /ban /unban /purge /lock /unlock /slowmode\n\n" +
          "**Community:** /poll /announce /say /settings\n\n" +
          "**Fun:** /coinflip /dice /eightball /choose /rate /rps"
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
    const list=await manageableGuilds(req.session.user);
    if(!list.some(g=>g.id===req.params.guildId)) return res.status(403).json({error:"You cannot manage this server, or NexusGuard is not installed."});
    req.guildId=req.params.guildId; next();
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
  try { res.json((await manageableGuilds(req.session.user)).map(g => ({ id: g.id, name: g.name, icon: g.icon, botInstalled: true }))); }
  catch(e){next(e);}
});
app.get("/api/guild/:guildId",requireLogin,guildAccess,async(req,res,next)=>{
  try {
    const guild=client.guilds.cache.get(req.guildId), settings=await getSettings(req.guildId);
    const logs=await pool.query("SELECT id,actor_id,action,target_id,details,created_at FROM audit_log WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 50",[req.guildId]);
    res.json({guild:{id:guild.id,name:guild.name,icon:guild.iconURL({size:256}),memberCount:guild.memberCount},settings,logs:logs.rows});
  } catch(e){next(e);}
});
app.put("/api/guild/:guildId/settings",requireLogin,guildAccess,async(req,res,next)=>{
  try {
    const settings=await getSettings(req.guildId), body=req.body||{};
    const boolKeys=["welcomeEnabled","logsEnabled","automodEnabled"];
    const strKeys=["welcomeChannel","welcomeMessage","logsChannel","moderatorRole","announcementChannel","accentColor"];
    for(const k of boolKeys) if(Object.hasOwn(body,k)){if(typeof body[k]!=="boolean")return res.status(400).json({error:`${k} must be true or false.`});settings[k]=body[k];}
    for(const k of strKeys) if(Object.hasOwn(body,k)){if(typeof body[k]!=="string"||body[k].length>500)return res.status(400).json({error:`Invalid ${k}.`});settings[k]=body[k];}
    await saveSettings(req.guildId,settings);
    await audit(req.guildId,req.session.user.id,"settings.updated",null,{keys:[...boolKeys,...strKeys].filter(k=>Object.hasOwn(body,k))});
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

// -------------------- DASHBOARD HTML --------------------

app.get("/",(req,res)=>{
  const signedIn=Boolean(req.session.user);
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#100b20"><title>NexusGuard Control Center</title>
<style>
:root{color-scheme:dark;--bg:#080b16;--panel:#11182a;--panel2:#151e33;--line:#27344e;--purple:#9a6bff;--cyan:#59f0e3;--text:#f4f7ff;--muted:#a8b5cc;--pink:#ff5f9e;--green:#72f7b2}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 8% -8%,#34205e 0,transparent 34%),radial-gradient(ellipse at 95% 22%,#103b49 0,transparent 30%),linear-gradient(135deg,#080b16,#0b1020 55%,#0b1320);color:var(--text);font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:linear-gradient(#7585a51a 1px,transparent 1px),linear-gradient(90deg,#7585a51a 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(to bottom,#000,transparent 75%)}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px max(16px,calc((100% - 1120px)/2));border-bottom:1px solid #35435d80;background:#080b16d9;backdrop-filter:blur(18px)}.brand{display:flex;align-items:center;gap:10px;font-weight:950;letter-spacing:1.7px}.brand:before{content:"N";display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:linear-gradient(140deg,var(--purple),#4c9eff);box-shadow:0 0 24px #9467ff55;color:white;font-size:21px;font-style:italic}.brand span{color:var(--cyan)}main{position:relative;max-width:1120px;margin:auto;padding:34px 18px 70px}.hero{position:relative;overflow:hidden;padding:clamp(24px,6vw,62px);border:1px solid #6477a344;border-radius:28px;background:linear-gradient(125deg,#171c35f5,#101d2bf2 65%,#17112bf2);box-shadow:0 24px 80px #0004}.hero:after{content:"✦";position:absolute;right:5%;top:6%;font-size:clamp(110px,24vw,250px);line-height:1;color:#a27aff0d;transform:rotate(14deg);pointer-events:none}.eyebrow{display:inline-flex;align-items:center;gap:8px;color:var(--cyan);font-weight:850;letter-spacing:2px;font-size:11px;text-transform:uppercase}.eyebrow:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 14px var(--green)}h1{position:relative;z-index:1;font-size:clamp(38px,7vw,72px);letter-spacing:-2px;line-height:1.01;margin:18px 0;max-width:780px}h1 span{background:linear-gradient(90deg,var(--cyan),#a9a0ff 75%);-webkit-background-clip:text;background-clip:text;color:transparent}h2{margin:0 0 8px;letter-spacing:-.4px}h3{margin:20px 0 8px}p{color:var(--muted);line-height:1.75}.hero p{max-width:650px;font-size:16px}.status{display:inline-flex;align-items:center;gap:8px;color:var(--green);font-weight:750;font-size:13px}.status:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor}button,a.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 17px;border:1px solid transparent;border-radius:12px;background:linear-gradient(115deg,#9864ff,#5d8cff);color:white;font:inherit;font-weight:800;text-decoration:none;cursor:pointer;margin:4px 5px 4px 0;box-shadow:0 8px 24px #795bff2c;transition:transform .18s,border-color .18s,filter .18s}button:hover,a.button:hover{transform:translateY(-2px);filter:brightness(1.12)}button:disabled{opacity:.55;cursor:wait;transform:none}.secondary{background:#151e32!important;border-color:#3a4864!important;box-shadow:none!important}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,245px),1fr));gap:16px;margin-top:20px}.card{padding:22px;border:1px solid #34415d;background:linear-gradient(145deg,#131b2fef,#0f1627f5);border-radius:20px;margin-top:16px;box-shadow:0 14px 38px #0002}.grid .card{margin-top:0;transition:transform .2s,border-color .2s}.grid .card:hover{transform:translateY(-4px);border-color:#7d70d7}.grid .card h2{display:flex;align-items:center;gap:9px}.hidden{display:none!important}label{display:block;margin:15px 0;color:#d5deef;font-weight:650}input[type=text],select,textarea{width:100%;padding:13px 14px;background:#080d19;color:var(--text);border:1px solid #34415c;border-radius:12px;margin-top:8px;font:inherit;outline:none}input:focus,select:focus,textarea:focus{border-color:var(--purple);box-shadow:0 0 0 3px #9864ff25}input[type=checkbox]{accent-color:var(--purple);width:17px;height:17px;vertical-align:middle}.server{padding:13px;border:1px solid #34415c;border-radius:12px;margin-top:9px;overflow-wrap:anywhere;background:#0b1221}footer{position:relative;text-align:center;padding:24px 14px;border-top:1px solid #26324a;color:#8493ad;font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080d19;padding:14px;border-radius:12px;color:var(--cyan);border:1px solid var(--line)}
@media(max-width:560px){header{padding:12px 14px}.brand{font-size:12px;letter-spacing:1px}.brand:before{width:32px;height:32px;font-size:18px}header .button{padding:10px 11px;font-size:12px}main{padding:18px 12px 45px}.hero{padding:25px 19px;border-radius:21px}h1{letter-spacing:-1.3px}.card{padding:17px;border-radius:16px}.hero p{font-size:15px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body>
<header><div class="brand">NEXUS<span>GUARD</span></div><a class="button" href="${signedIn?"/auth/logout":"/auth/login"}">${signedIn?"Sign out":"Sign in with Discord"}</a></header>
<main><section class="hero"><div class="eyebrow">COMMUNITY PROTECTION PLATFORM</div><h1>Guard your community.<br><span style="color:var(--cyan)">Your way.</span></h1>
<p>Moderation, server configuration, and community management from one dashboard.</p><p class="status" id="status">Checking system status...</p>
<a class="button" href="${signedIn?"#dashboard":"/auth/login"}">${signedIn?"Open Dashboard":"Get Started"}</a>
<a class="button secondary" href="https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&scope=bot%20applications.commands&permissions=0">Add NexusGuard</a></section>
<section class="grid"><article class="card"><h2>🛡️ Moderation</h2><p>Moderation commands, warnings and channel controls.</p></article><article class="card"><h2>⚙️ Configuration</h2><p>Configure supported features for each server.</p></article><article class="card"><h2>📋 Audit history</h2><p>Review recorded moderation and settings events.</p></article></section>
<section id="dashboard" class="card ${signedIn?"":"hidden"}"><h2>Your Dashboard</h2><p id="user">Loading account...</p><label for="servers">Select a server</label><select id="servers"><option value="">Loading servers...</option></select><div id="server"></div>
<div id="owner" class="hidden card"><h3>Owner controls</h3><button id="ownerStats" class="secondary">Load global statistics</button><pre id="stats"></pre></div></section></main>
<footer>NexusGuard • Guarding Your Community, Empowering Your Server.</footer>
<script>
async function api(url,options={}){const r=await fetch(url,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Request failed.");return d}
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
async function status(){try{const d=await api("/health");document.getElementById("status").textContent="Website online • Bot "+d.bot+" • "+d.servers+" servers"}catch{document.getElementById("status").textContent="Status unavailable"}}
async function loadGuild(id){
 const root=document.getElementById("server");root.replaceChildren();if(!id)return;
 try{
  const d=await api("/api/guild/"+encodeURIComponent(id));root.appendChild(el("h3",d.guild.name));root.appendChild(el("p","Members: "+(d.guild.memberCount??"Unknown")));
  for(const [key,title] of [["welcomeEnabled","Enable welcome messages"],["logsEnabled","Enable join logging"],["automodEnabled","Enable basic AutoMod"]]){
   const label=el("label",title),box=document.createElement("input");box.type="checkbox";box.checked=Boolean(d.settings[key]);box.style.marginRight="10px";
   box.addEventListener("change",async()=>{box.disabled=true;try{await api("/api/guild/"+encodeURIComponent(id)+"/settings",{method:"PUT",body:JSON.stringify({[key]:box.checked})})}catch(e){box.checked=!box.checked;alert(e.message)}finally{box.disabled=false}});
   label.prepend(box);root.appendChild(label);
  }
  const fields=[["welcomeChannel","Welcome channel ID"],["welcomeMessage","Welcome message"],["logsChannel","Log channel ID"]];
  const inputs={};
  for(const [key,title] of fields){const label=el("label",title),input=key==="welcomeMessage"?document.createElement("textarea"):document.createElement("input");input.value=d.settings[key]||"";input.placeholder=key==="welcomeMessage"?"Use {user} and {server}":"Discord channel ID";if(key!=="welcomeMessage")input.type="text";label.appendChild(input);root.appendChild(label);inputs[key]=input}
  const save=el("button","Save channel and message settings");save.addEventListener("click",async()=>{save.disabled=true;try{await api("/api/guild/"+encodeURIComponent(id)+"/settings",{method:"PUT",body:JSON.stringify({welcomeChannel:inputs.welcomeChannel.value.trim(),welcomeMessage:inputs.welcomeMessage.value,logsChannel:inputs.logsChannel.value.trim()})});alert("Settings saved.")}catch(e){alert(e.message)}finally{save.disabled=false}});root.appendChild(save);
  root.appendChild(el("h3","Recent audit events"));if(!d.logs.length)root.appendChild(el("p","No audit events recorded yet."));
  for(const log of d.logs)root.appendChild(el("div",log.action+" • "+(log.actor_id||"system")+" • "+new Date(log.created_at).toLocaleString(),"server"));
 }catch(e){root.appendChild(el("p",e.message))}
}
async function init(){await status();try{const me=await api("/api/me");if(!me.loggedIn)return;document.getElementById("user").textContent="Signed in as "+(me.user.globalName||me.user.username);if(me.isOwner)document.getElementById("owner").classList.remove("hidden");
 const gs=await api("/api/guilds"),sel=document.getElementById("servers");sel.replaceChildren();if(!gs.length){sel.appendChild(new Option("No manageable servers with NexusGuard installed",""));return}
 sel.appendChild(new Option("Choose a server",""));for(const g of gs)sel.appendChild(new Option(g.name,g.id));sel.addEventListener("change",()=>loadGuild(sel.value))
}catch(e){document.getElementById("user").textContent=e.message}}
document.getElementById("ownerStats")?.addEventListener("click",async()=>{try{document.getElementById("stats").textContent=JSON.stringify(await api("/api/owner/stats"),null,2)}catch(e){document.getElementById("stats").textContent=e.message}});
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
