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
  DISCORD_TOKEN: TOKEN,
  DISCORD_CLIENT_ID: CLIENT_ID,
  DISCORD_CLIENT_SECRET: CLIENT_SECRET,
  DATABASE_URL,
  SESSION_SECRET
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
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : undefined
});

pool.on("error", err =>
  console.error("PostgreSQL pool error:", err.message)
);

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS audit_log_guild_created_idx
    ON audit_log(guild_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS warnings (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getSettings(guildId) {
  const result = await pool.query(
    "SELECT settings FROM guild_settings WHERE guild_id=$1",
    [guildId]
  );

  return {
    ...DEFAULT_SETTINGS,
    ...(result.rows[0]?.settings || {})
  };
}

async function saveSettings(guildId, settings) {
  await pool.query(`
    INSERT INTO guild_settings(guild_id, settings, updated_at)
    VALUES($1, $2::jsonb, NOW())
    ON CONFLICT(guild_id)
    DO UPDATE SET
      settings = $2::jsonb,
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
  await pool.query(`
    INSERT INTO audit_log(
      guild_id, actor_id, action, target_id, details
    )
    VALUES($1, $2, $3, $4, $5::jsonb)
  `, [
    guildId,
    actorId || null,
    action,
    targetId,
    JSON.stringify(details)
  ]);
}

function isOwner(id) {
  return Boolean(OWNER_ID) && id === OWNER_ID;
}

function has(member, permission) {
  return Boolean(member?.permissions?.has(permission));
}

const commands = [
  new SlashCommandBuilder()
    .setName("website")
    .setDescription("Get the NexusGuard dashboard link"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show NexusGuard commands"),

  new SlashCommandBuilder()
    .setName("invite")
    .setDescription("Get the NexusGuard invite link"),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency"),

  new SlashCommandBuilder()
    .setName("botinfo")
    .setDescription("View bot information"),

  new SlashCommandBuilder()
    .setName("uptime")
    .setDescription("Check bot uptime"),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View server information"),

  new SlashCommandBuilder()
    .setName("membercount")
    .setDescription("Count server members"),

  new SlashCommandBuilder()
    .setName("servericon")
    .setDescription("Show the server icon"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View a user's information")
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar")
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("View information about a role")
    .addRoleOption(o =>
      o.setName("role")
        .setDescription("Role")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("channelinfo")
    .setDescription("View channel information")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("Channel")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("rolelist")
    .setDescription("List server roles"),

  new SlashCommandBuilder()
    .setName("channellist")
    .setDescription("List server channels"),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Record a member warning")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
        .setRequired(true)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View a member's warnings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("minutes")
        .setDescription("Minutes, 1-40320")
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
    .setName("untimeout")
    .setDescription("Remove a member timeout")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
        .setRequired(false)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o =>
      o.setName("member")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
        .setRequired(false)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user by ID")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o =>
      o.setName("userid")
        .setDescription("Discord user ID")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("1-100 messages")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set channel slowmode")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o =>
      o.setName("seconds")
        .setDescription("0-21600 seconds")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(21600)
    ),

  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Create a yes/no poll")
    .addStringOption(o =>
      o.setName("question")
        .setDescription("Poll question")
        .setRequired(true)
        .setMaxLength(200)
    ),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Post an announcement")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("message")
        .setDescription("Announcement")
        .setRequired(true)
        .setMaxLength(1800)
    ),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a message as NexusGuard")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o =>
      o.setName("message")
        .setDescription("Message")
        .setRequired(true)
        .setMaxLength(1800)
    ),

  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("View saved server settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Flip a coin"),

  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Roll a die"),

  new SlashCommandBuilder()
    .setName("eightball")
    .setDescription("Ask the magic eight ball")
    .addStringOption(o =>
      o.setName("question")
        .setDescription("Your question")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("choose")
    .setDescription("Choose from options")
    .addStringOption(o =>
      o.setName("options")
        .setDescription("Choices separated by commas")
        .setRequired(true)
        .setMaxLength(1000)
    ),

  new SlashCommandBuilder()
    .setName("rate")
    .setDescription("Rate something out of 100")
    .addStringOption(o =>
      o.setName("thing")
        .setDescription("What to rate")
        .setRequired(true)
        .setMaxLength(200)
    ),

  new SlashCommandBuilder()
    .setName("rps")
    .setDescription("Play rock paper scissors")
    .addStringOption(o =>
      o.setName("choice")
        .setDescription("Your move")
        .setRequired(true)
        .addChoices(
          { name: "Rock", value: "rock" },
          { name: "Paper", value: "paper" },
          { name: "Scissors", value: "scissors" }
        )
    )
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const result = await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );
  console.log(`Registered ${result.length} global slash commands.`);
}

client.once("ready", () => {
  console.log(
    `Logged in as ${client.user.tag}; guilds: ${client.guilds.cache.size}`
  );
  client.user.setActivity("over your communities");
});

client.on("guildCreate", async guild => {
  try {
    await saveSettings(guild.id, await getSettings(guild.id));
  } catch (e) {
    console.error("Guild setup failed:", e.message);
  }
});

client.on("guildMemberAdd", async member => {
  try {
    const s = await getSettings(member.guild.id);
    if (!s.welcomeEnabled || !s.welcomeChannel) return;

    const ch = await member.guild.channels
      .fetch(s.welcomeChannel)
      .catch(() => null);

    if (!ch?.isTextBased()) return;

    const msg = String(
      s.welcomeMessage || DEFAULT_SETTINGS.welcomeMessage
    )
      .replaceAll("{user}", `<@${member.id}>`)
      .replaceAll("{server}", member.guild.name);

    await ch.send({
      content: msg,
      allowedMentions: { users: [member.id] }
    });

    if (s.logsEnabled && s.logsChannel) {
      const log = await member.guild.channels
        .fetch(s.logsChannel)
        .catch(() => null);

      if (log?.isTextBased()) {
        await log.send(`📥 ${member.user.tag} joined the server.`);
      }
    }
  } catch (e) {
    console.error("Welcome handler:", e.message);
  }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  try {
    const s = await getSettings(message.guild.id);
    if (!s.automodEnabled) return;

    const invite =
      /discord(?:\.gg|\.com\/invite)\/[a-z0-9-]+/i.test(
        message.content || ""
      );

    const massMention =
      message.mentions.users.size >= 6 ||
      message.mentions.roles.size >= 5;

    if (
      (invite || massMention) &&
      !message.member?.permissions.has(
        PermissionFlagsBits.ManageMessages
      )
    ) {
      await message.delete().catch(() => {});
      await audit(
        message.guild.id,
        client.user.id,
        "automod_delete",
        message.author.id,
        { invite, massMention }
      );
    }
  } catch (e) {
    console.error("Automod handler:", e.message);
  }
});
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName: cmd, guild, member, user } = interaction;

  try {
    if (cmd === "website") {
      return interaction.reply({
        content: `🌐 **NexusGuard Dashboard**\n${WEBSITE_URL}`,
        ephemeral: true
      });
    }

    if (cmd === "invite") {
      const url = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot%20applications.commands&permissions=8`;
      return interaction.reply({
        content: `Invite NexusGuard to your server:\n${url}`,
        ephemeral: true
      });
    }

    if (cmd === "help") {
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle("NexusGuard Commands")
        .setDescription(
          "**General**\n" +
          "`/website` `/invite` `/ping` `/botinfo` `/uptime` `/help`\n\n" +
          "**Server information**\n" +
          "`/serverinfo` `/membercount` `/servericon` `/userinfo` `/avatar` `/roleinfo` `/channelinfo` `/rolelist` `/channellist`\n\n" +
          "**Moderation**\n" +
          "`/warn` `/warnings` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` `/lock` `/unlock` `/slowmode`\n\n" +
          "**Community**\n" +
          "`/poll` `/announce` `/say` `/settings`\n\n" +
          "**Fun**\n" +
          "`/coinflip` `/dice` `/eightball` `/choose` `/rate` `/rps`"
        )
        .setFooter({ text: "NexusGuard • Multi-server protection" });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (cmd === "ping") {
      return interaction.reply(
        `🏓 Gateway: ${client.ws.ping}ms`
      );
    }

    if (cmd === "botinfo") {
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle("NexusGuard")
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          { name: "Servers", value: `${client.guilds.cache.size}`, inline: true },
          { name: "Users (cached)", value: `${client.users.cache.size}`, inline: true },
          { name: "Node.js", value: process.version, inline: true }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (cmd === "uptime") {
      const seconds = Math.floor(client.uptime / 1000);
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);

      return interaction.reply(
        `⏱️ Uptime: **${days}d ${hours}h ${minutes}m**`
      );
    }

    if (cmd === "serverinfo") {
      if (!guild) {
        return interaction.reply({
          content: "Use this command inside a server.",
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(guild.name)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
          { name: "Server ID", value: guild.id, inline: true },
          { name: "Owner ID", value: guild.ownerId, inline: true },
          { name: "Members", value: `${guild.memberCount}`, inline: true },
          { name: "Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (cmd === "membercount") {
      if (!guild) {
        return interaction.reply({
          content: "Use this command inside a server.",
          ephemeral: true
        });
      }

      return interaction.reply(
        `👥 This server has **${guild.memberCount}** members.`
      );
    }

    if (cmd === "servericon") {
      if (!guild) {
        return interaction.reply({
          content: "Use this command inside a server.",
          ephemeral: true
        });
      }

      const icon = guild.iconURL({ size: 1024 });

      return interaction.reply(
        icon ? `🖼️ ${icon}` : "This server doesn't have an icon."
      );
    }

    if (cmd === "userinfo" || cmd === "avatar") {
      const target = interaction.options.getUser("member") || user;

      if (cmd === "avatar") {
        return interaction.reply({
          content: target.displayAvatarURL({ size: 1024 }),
          ephemeral: true
        });
      }

      const targetMember = guild
        ? await guild.members.fetch(target.id).catch(() => null)
        : null;

      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(target.tag)
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "User ID", value: target.id, inline: true },
          { name: "Account Created", value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
          {
            name: "Joined Server",
            value: targetMember
              ? `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:D>`
              : "Unknown",
            inline: true
          }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (cmd === "roleinfo") {
      const role = interaction.options.getRole("role");

      const embed = new EmbedBuilder()
        .setColor(role.color || 0x8b5cf6)
        .setTitle(role.name)
        .addFields(
          { name: "Role ID", value: role.id, inline: true },
          { name: "Members", value: `${role.members.size}`, inline: true },
          { name: "Position", value: `${role.position}`, inline: true },
          { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
          { name: "Hoisted", value: role.hoist ? "Yes" : "No", inline: true }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (cmd === "channelinfo") {
      const channel =
        interaction.options.getChannel("channel") || interaction.channel;

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setTitle(channel.name || "Channel information")
            .addFields(
              { name: "Channel ID", value: channel.id, inline: true },
              { name: "Type", value: `${channel.type}`, inline: true }
            )
        ]
      });
    }

    if (cmd === "rolelist") {
      const roles = guild.roles.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => `${r} — ${r.id}`);

      return interaction.reply({
        content: roles.slice(0, 40).join("\n") || "No roles found.",
        ephemeral: true
      });
    }

    if (cmd === "channellist") {
      const channels = guild.channels.cache
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map(ch => `${ch} — ${ch.id}`);

      return interaction.reply({
        content: channels.slice(0, 40).join("\n") || "No channels found.",
        ephemeral: true
      });
    }

    if (cmd === "warn") {
      const target = interaction.options.getUser("member");
      const reason = interaction.options.getString("reason");
      const targetMember = await guild.members.fetch(target.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({
          content: "That member is not in this server.",
          ephemeral: true
        });
      }

      if (
        target.id === user.id ||
        target.id === guild.ownerId ||
        targetMember.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        return interaction.reply({
          content: "You can't warn yourself, the server owner, or an administrator.",
          ephemeral: true
        });
      }

      await pool.query(
        `INSERT INTO warnings(guild_id,user_id,moderator_id,reason)
         VALUES($1,$2,$3,$4)`,
        [guild.id, target.id, user.id, reason]
      );

      await audit(guild.id, user.id, "warn", target.id, { reason });

      return interaction.reply(
        `⚠️ ${target} has been warned.\n**Reason:** ${reason}`
      );
    }

    if (cmd === "warnings") {
      const target = interaction.options.getUser("member");

      const result = await pool.query(
        `SELECT moderator_id, reason, created_at
         FROM warnings
         WHERE guild_id=$1 AND user_id=$2
         ORDER BY created_at DESC
         LIMIT 10`,
        [guild.id, target.id]
      );

      if (!result.rows.length) {
        return interaction.reply({
          content: `${target.tag} has no recorded warnings.`,
          ephemeral: true
        });
      }

      const description = result.rows.map((w, i) =>
        `**${i + 1}.** ${w.reason}\nModerator: <@${w.moderator_id}> • <t:${Math.floor(new Date(w.created_at).getTime() / 1000)}:R>`
      ).join("\n\n");

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle(`Warnings for ${target.tag}`)
            .setDescription(description)
        ],
        ephemeral: true
      });
    }

    if (cmd === "timeout") {
      const target = interaction.options.getUser("member");
      const minutes = interaction.options.getInteger("minutes");
      const reason = interaction.options.getString("reason") || "No reason provided.";
      const targetMember = await guild.members.fetch(target.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({
          content: "Member not found.",
          ephemeral: true
        });
      }

      if (
        target.id === user.id ||
        target.id === guild.ownerId ||
        targetMember.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        return interaction.reply({
          content: "You can't timeout yourself, the server owner, or an administrator.",
          ephemeral: true
        });
      }

      await targetMember.timeout(minutes * 60 * 1000, reason);
      await audit(guild.id, user.id, "timeout", target.id, { minutes, reason });

      return interaction.reply(
        `🔇 ${target} was timed out for **${minutes} minutes**.\nReason: ${reason}`
      );
    }

    if (cmd === "untimeout") {
      const target = interaction.options.getUser("member");
      const targetMember = await guild.members.fetch(target.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({
          content: "Member not found.",
          ephemeral: true
        });
      }

      await targetMember.timeout(null, "Timeout removed by moderator.");
      await audit(guild.id, user.id, "untimeout", target.id);

      return interaction.reply(`🔊 Removed the timeout from ${target}.`);
    }

    if (cmd === "kick") {
      const target = interaction.options.getUser("member");
      const reason = interaction.options.getString("reason") || "No reason provided.";
      const targetMember = await guild.members.fetch(target.id).catch(() => null);

      if (!targetMember) {
        return interaction.reply({
          content: "Member not found.",
          ephemeral: true
        });
      }

      if (
        target.id === user.id ||
        target.id === guild.ownerId ||
        targetMember.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        return interaction.reply({
          content: "This member cannot be kicked with this command.",
          ephemeral: true
        });
      }

      await targetMember.kick(reason);
      await audit(guild.id, user.id, "kick", target.id, { reason });

      return interaction.reply(`👢 Kicked **${target.tag}**.\nReason: ${reason}`);
    }

    if (cmd === "ban") {
      const target = interaction.options.getUser("member");
      const reason = interaction.options.getString("reason") || "No reason provided.";
      const targetMember = await guild.members.fetch(target.id).catch(() => null);

      if (
        target.id === user.id ||
        target.id === guild.ownerId ||
        targetMember?.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        return interaction.reply({
          content: "This member cannot be banned with this command.",
          ephemeral: true
        });
      }

      await guild.members.ban(target.id, { reason });
      await audit(guild.id, user.id, "ban", target.id, { reason });

      return interaction.reply(`🔨 Banned **${target.tag}**.\nReason: ${reason}`);
    }

    if (cmd === "unban") {
      const id = interaction.options.getString("userid").trim();

      if (!/^\d{17,20}$/.test(id)) {
        return interaction.reply({
          content: "Enter a valid Discord user ID.",
          ephemeral: true
        });
      }

      await guild.members.unban(id);
      await audit(guild.id, user.id, "unban", id);

      return interaction.reply(`✅ Unbanned user ID \`${id}\`.`);
    }

    if (cmd === "purge") {
      const amount = interaction.options.getInteger("amount");

      if (!interaction.channel?.bulkDelete) {
        return interaction.reply({
          content: "This channel doesn't support bulk deletion.",
          ephemeral: true
        });
      }

      const deleted = await interaction.channel.bulkDelete(amount, true);

      return interaction.reply({
        content: `🧹 Deleted ${deleted.size} messages.`,
        ephemeral: true
      });
    }

    if (cmd === "lock" || cmd === "unlock") {
      const channel = interaction.channel;
      const locked = cmd === "lock";

      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: !locked }
      );

      await audit(guild.id, user.id, cmd, channel.id);

      return interaction.reply(
        locked ? "🔒 Channel locked." : "🔓 Channel unlocked."
      );
    }

    if (cmd === "slowmode") {
      const seconds = interaction.options.getInteger("seconds");
      await interaction.channel.setRateLimitPerUser(seconds);

      return interaction.reply(
        seconds
          ? `🐢 Slowmode set to ${seconds} seconds.`
          : "Slowmode disabled."
      );
    }

    if (cmd === "poll") {
      const question = interaction.options.getString("question");

      const msg = await interaction.reply({
        content: `📊 **${question}**\n\n👍 Yes\n👎 No`,
        fetchReply: true
      });

      await msg.react("👍");
      await msg.react("👎");
      return;
    }

    if (cmd === "announce" || cmd === "say") {
      const message = interaction.options.getString("message");

      await interaction.channel.send({
        content: message,
        allowedMentions: { parse: [] }
      });

      return interaction.reply({
        content: "✅ Message sent.",
        ephemeral: true
      });
    }

    if (cmd === "settings") {
      const s = await getSettings(guild.id);

      const embed = new EmbedBuilder()
        .setColor(s.accentColor || 0x8b5cf6)
        .setTitle(`${guild.name} — NexusGuard Settings`)
        .addFields(
          { name: "Welcome messages", value: s.welcomeEnabled ? "Enabled" : "Disabled", inline: true },
          { name: "Automod", value: s.automodEnabled ? "Enabled" : "Disabled", inline: true },
          { name: "Logs", value: s.logsEnabled ? "Enabled" : "Disabled", inline: true },
          { name: "Welcome channel", value: s.welcomeChannel ? `<#${s.welcomeChannel}>` : "Not configured", inline: true },
          { name: "Logs channel", value: s.logsChannel ? `<#${s.logsChannel}>` : "Not configured", inline: true }
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (cmd === "coinflip") {
      return interaction.reply(
        Math.random() < 0.5 ? "🪙 **Heads!**" : "🪙 **Tails!**"
      );
    }

    if (cmd === "dice") {
      return interaction.reply(
        `🎲 You rolled **${Math.floor(Math.random() * 6) + 1}**.`
      );
    }

    if (cmd === "eightball") {
      const answers = [
        "It is certain.", "Without a doubt.", "Yes, definitely.",
        "Most likely.", "Signs point to yes.", "Ask again later.",
        "Cannot predict now.", "Don't count on it.", "Very doubtful.",
        "My reply is no."
      ];

      return interaction.reply(
        `🎱 **${answers[Math.floor(Math.random() * answers.length)]}**`
      );
    }

    if (cmd === "choose") {
      const choices = interaction.options.getString("options")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      if (choices.length < 2) {
        return interaction.reply({
          content: "Provide at least two comma-separated choices.",
          ephemeral: true
        });
      }

      return interaction.reply(
        `🎯 I choose: **${choices[Math.floor(Math.random() * choices.length)]}**`
      );
    }

    if (cmd === "rate") {
      const thing = interaction.options.getString("thing");
      const score = Math.floor(Math.random() * 101);

      return interaction.reply(`⭐ I'd rate **${thing}** a **${score}/100**.`);
    }

    if (cmd === "rps") {
      const choice = interaction.options.getString("choice");
      const options = ["rock", "paper", "scissors"];
      const botChoice = options[Math.floor(Math.random() * options.length)];

      let result = "It's a tie!";
      if (
        (choice === "rock" && botChoice === "scissors") ||
        (choice === "paper" && botChoice === "rock") ||
        (choice === "scissors" && botChoice === "paper")
      ) result = "You win!";
      else if (choice !== botChoice) result = "I win!";

      return interaction.reply(
        `You chose **${choice}**. I chose **${botChoice}**. ${result}`
      );
    }
  } catch (error) {
    console.error(`Command ${cmd} failed:`, error);

    const response = {
      content: "❌ The command failed. Check the bot logs for details.",
      ephemeral: true
    };

    if (interaction.replied || interaction.deferred) {
      return interaction.followUp(response).catch(() => {});
    }

    return interaction.reply(response).catch(() => {});
  }
});
// ============================================
// NEXUSGUARD DASHBOARD AND WEB SERVER
// ============================================

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "50kb" }));

app.use("/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use(session({
  name: "nexusguard.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  store: new PgSession({
    pool,
    tableName: "session",
    createTableIfMissing: true
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "You must sign in with Discord first."
    });
  }

  next();
}

function canManageGuild(user, guild) {
  if (!user || !guild) return false;
  if (isOwner(user.id)) return true;

  const permissions = BigInt(guild.permissions || "0");
  const administrator = (permissions & 8n) === 8n;
  const manageGuild = (permissions & 32n) === 32n;

  return guild.owner === true || administrator || manageGuild;
}

async function getUserGuilds(user) {
  if (!user?.accessToken) {
    throw new Error("Missing Discord access token.");
  }

  const response = await fetch(
    "https://discord.com/api/users/@me/guilds",
    {
      headers: {
        Authorization: `Bearer ${user.accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error("Discord could not retrieve your servers.");
  }

  return response.json();
}

async function getManageableGuilds(user) {
  const guilds = await getUserGuilds(user);

  return guilds.filter(guild =>
    canManageGuild(user, guild) &&
    client.guilds.cache.has(guild.id)
  );
}

async function requireGuildAccess(req, res, next) {
  try {
    const guildId = req.params.guildId;

    if (!/^\d{17,20}$/.test(guildId || "")) {
      return res.status(400).json({ error: "Invalid server ID." });
    }

    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
      return res.status(404).json({
        error: "NexusGuard is not installed in this server."
      });
    }

    const manageable = await getManageableGuilds(req.session.user);
    const allowed = manageable.some(item => item.id === guildId);

    if (!allowed) {
      return res.status(403).json({
        error: "You don't have permission to manage this server."
      });
    }

    req.guild = guild;
    next();
  } catch (error) {
    console.error("Guild permission check:", error.message);

    return res.status(502).json({
      error: "Could not verify your Discord permissions. Please sign in again."
    });
  }
}

function requireGuildManagePermission(req, res, next) {
  if (isOwner(req.session.user.id)) return next();

  next();
}

function safeChannelId(value) {
  if (value === "" || value === null || value === undefined) {
    return "";
  }

  return /^\d{17,20}$/.test(String(value))
    ? String(value)
    : null;
}

// ============================================
// MAIN WEBSITE
// ============================================

app.get("/", (req, res) => {
  const user = req.session.user;

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0b0915">
<title>NexusGuard — Discord Protection</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0b0915;
  --panel: #141122;
  --panel2: #1b172d;
  --line: #302843;
  --purple: #a78bfa;
  --text: #f5f3ff;
  --muted: #a9a2bd;
  --green: #34d399;
  --red: #fb7185;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(ellipse at 10% 0%, #32205b 0%, transparent 42%),
    radial-gradient(ellipse at 100% 80%, #241442 0%, transparent 35%),
    var(--bg);
  color: var(--text);
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, a { font: inherit; }
a { color: inherit; text-decoration: none; }
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 18px clamp(16px, 5vw, 64px);
  border-bottom: 1px solid #ffffff12;
  background: #0b0915b8;
  backdrop-filter: blur(18px);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand { display: flex; align-items: center; gap: 12px; font-weight: 900; letter-spacing: 1.2px; }
.logo {
  display: grid;
  place-items: center;
  width: 43px;
  height: 43px;
  border-radius: 14px;
  background: linear-gradient(135deg, #a78bfa, #6d28d9);
  color: white;
  font-size: 22px;
  box-shadow: 0 0 28px #8b5cf644;
}
.brand small {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 2px;
}
.btn {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 17px;
  background: var(--panel2);
  color: white;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: .2s;
}
.btn:hover { border-color: var(--purple); transform: translateY(-1px); }
.btn-primary {
  background: linear-gradient(135deg, #8b5cf6, #6d28d9);
  border-color: transparent;
  font-weight: 750;
}
.hero {
  max-width: 1050px;
  margin: auto;
  padding: 86px 22px 60px;
  text-align: center;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 13px;
  border: 1px solid #a78bfa45;
  background: #a78bfa12;
  color: #d8ccff;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}
.dot { width: 8px; height: 8px; background: var(--green); border-radius: 50%; }
h1 {
  margin: 25px auto 20px;
  max-width: 850px;
  font-size: clamp(40px, 8vw, 78px);
  line-height: 1.02;
  letter-spacing: -3px;
}
.gradient {
  background: linear-gradient(90deg, #c4b5fd, #a78bfa, #f0abfc);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.subtitle {
  max-width: 660px;
  margin: 0 auto;
  color: var(--muted);
  font-size: clamp(15px, 2.5vw, 19px);
  line-height: 1.8;
}
.actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 30px;
}
.features {
  max-width: 1050px;
  margin: 0 auto;
  padding: 20px 22px 80px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 15px;
}
.feature {
  padding: 23px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: linear-gradient(145deg, #1a1529, #100e1c);
}
.feature .icon { font-size: 27px; }
.feature h3 { margin: 15px 0 8px; }
.feature p { color: var(--muted); font-size: 14px; line-height: 1.7; }
.section {
  max-width: 900px;
  margin: 0 auto;
  padding: 30px 22px 80px;
}
.section h2 { font-size: clamp(25px, 5vw, 40px); text-align: center; }
footer {
  border-top: 1px solid #ffffff12;
  padding: 25px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}
.dashboard { max-width: 1150px; margin: auto; padding: 28px 18px 70px; }
.dash-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 22px;
}
.dash-head h1 { font-size: 32px; letter-spacing: -1px; margin: 0; }
.muted { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 14px; }
.card {
  border: 1px solid var(--line);
  background: #151122e8;
  border-radius: 17px;
  padding: 20px;
  min-width: 0;
}
.card h3 { margin-top: 0; }
.server-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.server {
  display: flex;
  align-items: center;
  gap: 13px;
  border: 1px solid var(--line);
  border-radius: 15px;
  padding: 15px;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
  color: white;
  min-width: 0;
}
.server:hover { border-color: var(--purple); }
.server img, .server .placeholder {
  width: 45px; height: 45px; border-radius: 14px; object-fit: cover;
}
.placeholder { display: grid; place-items: center; background: #32254e; font-weight: 900; }
.server-name { overflow-wrap: anywhere; font-weight: 750; }
.form-row { margin: 16px 0; }
.form-row label { display: block; color: var(--muted); font-size: 13px; margin-bottom: 8px; }
input, select, textarea {
  width: 100%;
  color: white;
  background: #0e0b19;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
}
input[type=checkbox] { width: 19px; height: 19px; accent-color: #a78bfa; }
.toggle-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 0; border-bottom:1px solid #ffffff12; }
.hidden { display:none !important; }
.notice { padding: 14px; border-radius: 12px; background: #a78bfa12; border: 1px solid #a78bfa30; color: #ddd2ff; }
.error { color: var(--red); }
@media(max-width:720px) {
  .hero { padding-top: 60px; }
  h1 { letter-spacing: -1.5px; }
  .features, .grid { grid-template-columns: 1fr; }
  .server-list { grid-template-columns: 1fr; }
  .topbar { padding: 13px 14px; }
  .brand { font-size: 13px; }
  .topbar .btn { padding: 10px; font-size: 12px; }
}
</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">
    <span class="logo">N</span>
    <span>NEXUSGUARD<small>DISCORD SECURITY</small></span>
  </a>
  <div>
    ${user
      ? `<a class="btn" href="#dashboard">Dashboard</a> <a class="btn" href="/auth/logout">Sign out</a>`
      : `<a class="btn btn-primary" href="/auth/login">Sign in with Discord</a>`}
  </div>
</header>

${user ? `
<main class="dashboard" id="dashboard">
  <div class="dash-head">
    <div>
      <h1>Your dashboard</h1>
      <p class="muted">Welcome back, ${escapeHtml(user.username)}.</p>
    </div>
    <a class="btn btn-primary" href="/auth/login">Refresh Discord access</a>
  </div>
  <div class="notice" id="status">Loading your servers…</div>
  <div style="height:18px"></div>
  <div id="servers" class="server-list"></div>
  <section id="settingsPanel" class="card hidden" style="margin-top:22px">
    <button class="btn" onclick="closeSettings()">← Back to servers</button>
    <h2 id="serverTitle">Server settings</h2>
    <p class="muted">Changes apply to the selected server.</p>
    <form id="settingsForm">
      <div class="toggle-row">
        <label for="welcomeEnabled">Welcome messages</label>
        <input id="welcomeEnabled" type="checkbox">
      </div>
      <div class="form-row">
        <label for="welcomeChannel">Welcome channel ID</label>
        <input id="welcomeChannel" placeholder="Discord channel ID">
      </div>
      <div class="form-row">
        <label for="welcomeMessage">Welcome message</label>
        <textarea id="welcomeMessage" rows="3" maxlength="500"></textarea>
        <small class="muted">Available placeholders: {user} and {server}</small>
      </div>
      <div class="toggle-row">
        <label for="automodEnabled">Basic automod</label>
        <input id="automodEnabled" type="checkbox">
      </div>
      <div class="toggle-row">
        <label for="logsEnabled">Join logs</label>
        <input id="logsEnabled" type="checkbox">
      </div>
      <div class="form-row">
        <label for="logsChannel">Logs channel ID</label>
        <input id="logsChannel" placeholder="Discord channel ID">
      </div>
      <div class="form-row">
        <label for="accentColor">Accent color</label>
        <input id="accentColor" value="#8b5cf6" maxlength="7">
      </div>
      <button class="btn btn-primary" type="submit">Save settings</button>
      <span id="saveStatus" class="muted"></span>
    </form>
  </section>
  <section class="card" style="margin-top:22px">
    <h3>Recent audit logs</h3>
    <div id="logs" class="muted">Select a server to view logs.</div>
  </section>
</main>
<script>
let selectedGuild = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

async function loadServers() {
  const status = document.getElementById("status");
  const container = document.getElementById("servers");

  try {
    const data = await api("/api/guilds");
    container.innerHTML = "";

    if (!data.guilds.length) {
      status.textContent = "No manageable servers with NexusGuard installed were found.";
      return;
    }

    status.textContent = data.guilds.length + " manageable server(s) found.";

    for (const guild of data.guilds) {
      const button = document.createElement("button");
      button.className = "server";

      const icon = guild.icon
        ? '<img alt="" src="https://cdn.discordapp.com/icons/' +
          encodeURIComponent(guild.id) + '/' +
          encodeURIComponent(guild.icon) + '.png?size=128">'
        : '<span class="placeholder">' +
          escapeText(guild.name.slice(0, 1)) + '</span>';

      button.innerHTML = icon +
        '<span class="server-name">' + escapeText(guild.name) +
        '<br><small class="muted">Open settings →</small></span>';

      button.addEventListener("click", () => openSettings(guild));
      container.appendChild(button);
    }
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  }
}

function escapeText(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

async function openSettings(guild) {
  selectedGuild = guild.id;
  document.getElementById("settingsPanel").classList.remove("hidden");
  document.getElementById("serverTitle").textContent = guild.name;
  document.getElementById("saveStatus").textContent = "Loading…";

  try {
    const data = await api("/api/guild/" + encodeURIComponent(guild.id));
    const s = data.settings;

    document.getElementById("welcomeEnabled").checked = !!s.welcomeEnabled;
    document.getElementById("welcomeChannel").value = s.welcomeChannel || "";
    document.getElementById("welcomeMessage").value = s.welcomeMessage || "";
    document.getElementById("automodEnabled").checked = !!s.automodEnabled;
    document.getElementById("logsEnabled").checked = !!s.logsEnabled;
    document.getElementById("logsChannel").value = s.logsChannel || "";
    document.getElementById("accentColor").value = s.accentColor || "#8b5cf6";
    document.getElementById("saveStatus").textContent = "";

    const logs = await api("/api/guild/" + encodeURIComponent(guild.id) + "/logs");
    const logContainer = document.getElementById("logs");
    logContainer.innerHTML = "";

    if (!logs.logs.length) {
      logContainer.textContent = "No audit entries yet.";
    } else {
      for (const item of logs.logs) {
        const line = document.createElement("p");
        line.textContent =
          item.action + " • " +
          (item.actor_id || "System") + " • " +
          new Date(item.created_at).toLocaleString();
        logContainer.appendChild(line);
      }
    }
  } catch (error) {
    document.getElementById("saveStatus").textContent = error.message;
  }
}

function closeSettings() {
  selectedGuild = null;
  document.getElementById("settingsPanel").classList.add("hidden");
}

document.getElementById("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!selectedGuild) return;

  const status = document.getElementById("saveStatus");
  status.textContent = "Saving…";

  const settings = {
    welcomeEnabled: document.getElementById("welcomeEnabled").checked,
    welcomeChannel: document.getElementById("welcomeChannel").value.trim(),
    welcomeMessage: document.getElementById("welcomeMessage").value,
    automodEnabled: document.getElementById("automodEnabled").checked,
    logsEnabled: document.getElementById("logsEnabled").checked,
    logsChannel: document.getElementById("logsChannel").value.trim(),
    accentColor: document.getElementById("accentColor").value.trim()
  };

  try {
    await api("/api/guild/" + encodeURIComponent(selectedGuild) + "/settings", {
      method: "POST",
      body: JSON.stringify(settings)
    });

    status.textContent = "Saved successfully.";
  } catch (error) {
    status.textContent = error.message;
  }
});

loadServers();
</script>
` : `
<main>
  <section class="hero">
    <div class="pill"><span class="dot"></span> MULTI-SERVER DISCORD PROTECTION</div>
    <h1>Protect your community.<br><span class="gradient">Simplify your server.</span></h1>
    <p class="subtitle">
      NexusGuard brings moderation, server tools, welcome messages,
      automod and dashboard controls together in one place.
    </p>
    <div class="actions">
      <a class="btn btn-primary" href="/auth/login">Continue with Discord ↗</a>
      <a class="btn" href="/auth/login">Open Dashboard</a>
    </div>
  </section>
  <section class="features">
    <article class="feature">
      <div class="icon">🛡️</div>
      <h3>Moderation</h3>
      <p>Manage warnings, timeouts, kicks, bans, channel locks and message cleanup.</p>
    </article>
    <article class="feature">
      <div class="icon">⚙️</div>
      <h3>Server dashboard</h3>
      <p>Manage supported settings for each server you are authorized to control.</p>
    </article>
    <article class="feature">
      <div class="icon">✨</div>
      <h3>Community tools</h3>
      <p>Welcome messages, polls, announcements, fun commands and server information.</p>
    </article>
  </section>
  <section class="section">
    <h2>One dashboard. Your servers.</h2>
    <p class="subtitle">Sign in securely through Discord. Only servers where you have management permission and NexusGuard is installed appear in your dashboard.</p>
    <div class="actions"><a class="btn btn-primary" href="/auth/login">Get Started</a></div>
  </section>
</main>
`}

<footer>NexusGuard · Discord community tools · ${new Date().getFullYear()}</footer>
</body>
</html>`);
});

// ============================================
// DISCORD OAUTH LOGIN
// ============================================

app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;

  req.session.save(error => {
    if (error) {
      console.error("Session save failed:", error.message);
      return res.status(500).send("Could not start login. Please try again.");
    }

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "identify guilds",
      state
    });

    res.redirect(
      "https://discord.com/oauth2/authorize?" + params.toString()
    );
  });
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const savedState = req.session.oauthState;

  delete req.session.oauthState;

  if (!code || !state || !savedState || state !== savedState) {
    return res.status(400).send(
      "Login could not be verified. Please return to the dashboard and try again."
    );
  }

  try {
    const tokenResponse = await fetch(
      "https://discord.com/api/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: REDIRECT_URI
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Discord token exchange failed:", tokenData.error);
      return res.status(401).send(
        "Discord sign-in failed. Please try again."
      );
    }

    const profileResponse = await fetch(
      "https://discord.com/api/users/@me",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const profile = await profileResponse.json();

    if (!profileResponse.ok || !profile.id) {
      return res.status(401).send(
        "Discord could not verify your account. Please try again."
      );
    }

    req.session.regenerate(error => {
      if (error) {
        console.error("Session regeneration failed:", error.message);
        return res.status(500).send("Could not create a secure session.");
      }

      req.session.user = {
        id: profile.id,
        username: profile.global_name || profile.username,
        avatar: profile.avatar || null,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenExpiresAt: Date.now() + (tokenData.expires_in * 1000)
      };

      req.session.save(saveError => {
        if (saveError) {
          console.error("Login session save failed:", saveError.message);
          return res.status(500).send("Could not save your login session.");
        }

        res.redirect("/");
      });
    });
  } catch (error) {
    console.error("OAuth callback error:", error.message);
    res.status(500).send(
      "An error occurred during Discord login. Please try again."
    );
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      console.error("Logout error:", error.message);
    }

    res.clearCookie("nexusguard.sid", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    });

    res.redirect("/");
  });
});

// ============================================
// API ROUTES
// ============================================

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ authenticated: false });
  }

  const { id, username, avatar } = req.session.user;

  res.json({
    authenticated: true,
    user: { id, username, avatar },
    isOwner: isOwner(id)
  });
});

app.get("/api/guilds", requireLogin, async (req, res) => {
  try {
    const guilds = await getManageableGuilds(req.session.user);

    res.json({
      guilds: guilds.map(guild => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        owner: guild.owner,
        isOwner: isOwner(req.session.user.id)
      }))
    });
  } catch (error) {
    console.error("Guild list failed:", error.message);
    res.status(502).json({
      error: "Could not load your servers. Sign out and sign in again."
    });
  }
});

app.get(
  "/api/guild/:guildId",
  requireLogin,
  requireGuildAccess,
  async (req, res) => {
    try {
      const settings = await getSettings(req.guild.id);

      res.json({
        guild: {
          id: req.guild.id,
          name: req.guild.name,
          icon: req.guild.iconURL()
        },
        settings
      });
    } catch (error) {
      console.error("Settings read failed:", error.message);
      res.status(500).json({ error: "Could not load server settings." });
    }
  }
);

app.post(
  "/api/guild/:guildId/settings",
  requireLogin,
  requireGuildAccess,
  async (req, res) => {
    try {
      const body = req.body || {};
      const current = await getSettings(req.guild.id);

      const welcomeChannel = safeChannelId(body.welcomeChannel);
      const logsChannel = safeChannelId(body.logsChannel);

      if (welcomeChannel === null || logsChannel === null) {
        return res.status(400).json({
          error: "Channel IDs must be valid Discord IDs or empty."
        });
      }

      const accentColor = String(body.accentColor || "#8b5cf6");

      if (!/^#[0-9a-fA-F]{6}$/.test(accentColor)) {
        return res.status(400).json({
          error: "Accent color must be a valid six-digit hex color."
        });
      }

      const welcomeMessage = String(
        body.welcomeMessage ?? current.welcomeMessage
      );

      if (welcomeMessage.length > 500) {
        return res.status(400).json({
          error: "Welcome message cannot exceed 500 characters."
        });
      }

      const settings = {
        ...current,
        welcomeEnabled: body.welcomeEnabled === true,
        welcomeChannel,
        welcomeMessage,
        automodEnabled: body.automodEnabled === true,
        logsEnabled: body.logsEnabled === true,
        logsChannel,
        accentColor
      };

      await saveSettings(req.guild.id, settings);

      await audit(
        req.guild.id,
        req.session.user.id,
        "dashboard_settings_updated",
        null
      );

      res.json({ success: true, settings });
    } catch (error) {
      console.error("Settings save failed:", error.message);
      res.status(500).json({ error: "Could not save settings." });
    }
  }
);

app.get(
  "/api/guild/:guildId/logs",
  requireLogin,
  requireGuildAccess,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, actor_id, action, target_id, details, created_at
         FROM audit_log
         WHERE guild_id=$1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.guild.id]
      );

      res.json({ logs: result.rows });
    } catch (error) {
      console.error("Audit log read failed:", error.message);
      res.status(500).json({ error: "Could not load audit logs." });
    }
  }
);

app.get("/api/owner/stats", requireLogin, async (req, res) => {
  if (!isOwner(req.session.user.id)) {
    return res.status(403).json({ error: "Owner access only." });
  }

  try {
    const [guildCount, warningCount, logCount] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM guild_settings"),
      pool.query("SELECT COUNT(*)::int AS count FROM warnings"),
      pool.query("SELECT COUNT(*)::int AS count FROM audit_log")
    ]);

    res.json({
      botGuilds: client.guilds.cache.size,
      configuredGuilds: guildCount.rows[0].count,
      warnings: warningCount.rows[0].count,
      auditEntries: logCount.rows[0].count
    });
  } catch (error) {
    console.error("Owner stats failed:", error.message);
    res.status(500).json({ error: "Could not load owner statistics." });
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      botReady: client.isReady(),
      guilds: client.guilds.cache.size,
      uptime: process.uptime()
    });
  } catch {
    res.status(503).json({
      ok: false,
      database: "unavailable"
    });
  }
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API endpoint not found." });
  }

  res.status(404).type("html").send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Page not found — NexusGuard</title>
      <style>
        body {
          margin: 0; min-height: 100vh; display: grid;
          place-items: center; background: #0b0915; color: white;
          font-family: system-ui, sans-serif; text-align: center;
        }
        a { color: #c4b5fd; }
      </style>
    </head>
    <body>
      <main>
        <h1>404 — Page not found</h1>
        <p>This NexusGuard page doesn't exist.</p>
        <a href="/">Return to NexusGuard</a>
      </main>
    </body>
    </html>
  `);
});

// ============================================
// STARTUP
// ============================================

async function start() {
  await initDatabase();
  await registerCommands();

  await client.login(TOKEN);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`NexusGuard website listening on port ${PORT}`);
    console.log(`Dashboard: ${WEBSITE_URL}`);
    console.log(`OAuth redirect: ${REDIRECT_URI}`);
  });
}

process.on("unhandledRejection", error => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});

start().catch(error => {
  console.error("NexusGuard startup failed:", error);
  process.exit(1);
});