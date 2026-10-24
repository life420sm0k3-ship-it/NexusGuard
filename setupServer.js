
'use strict';

const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  OverwriteType
} = require('discord.js');

const ACCENT = 0x8B5CF6;
const CYAN = 0x22D3EE;

const ROLE_DEFINITIONS = [
  { name: 'Founder', color: 0xF59E0B },
  { name: 'Administrator', color: 0xEF4444 },
  { name: 'Moderator', color: 0xF97316 },
  { name: 'Developer', color: 0x8B5CF6 },
  { name: 'Client', color: 0x22D3EE },
  { name: 'Beta Tester', color: 0x10B981 },
  { name: 'Community', color: 0x94A3B8 }
];

const CATEGORY_DEFINITIONS = [
  {
    name: '✦ START HERE',
    channels: [
      ['welcome', 'Welcome and server introduction'],
      ['rules', 'Community rules'],
      ['announcements', 'Official project and server news'],
      ['server-guide', 'How to use this server']
    ]
  },
  {
    name: '✦ PROJECT SHOWCASE',
    channels: [
      ['bot-showcase', 'Showcase Discord bots'],
      ['website-showcase', 'Showcase websites and dashboards'],
      ['minecraft-projects', 'Minecraft builds, add-ons and tools'],
      ['demos-and-media', 'Screenshots, videos and live demos'],
      ['project-roadmap', 'Development updates and upcoming features']
    ]
  },
  {
    name: '✦ TESTING LAB',
    channels: [
      ['beta-testing', 'Find and join beta tests'],
      ['bug-reports', 'Report bugs and technical problems'],
      ['suggestions', 'Suggest improvements'],
      ['known-issues', 'Known bugs and workarounds']
    ]
  },
  {
    name: '✦ HIRE & COMMISSIONS',
    channels: [
      ['hire-me', 'Services and availability'],
      ['services-and-prices', 'Service information and estimated prices'],
      ['project-requests', 'Discuss a potential project'],
      ['client-reviews', 'Feedback from completed projects']
    ]
  },
  {
    name: '✦ COMMUNITY',
    channels: [
      ['general-chat', 'General community conversation'],
      ['developer-chat', 'Programming and development discussion'],
      ['show-your-work', 'Share your own projects'],
      ['gaming-chat', 'Games and gaming discussion'],
      ['bot-commands', 'Use bot commands here']
    ]
  },
  {
    name: '✦ SUPPORT DESK',
    channels: [
      ['open-a-ticket', 'Open a private support or commission ticket']
    ]
  },
  {
    name: '✦ STAFF HQ',
    staffOnly: true,
    channels: [
      ['staff-chat', 'Private staff conversation'],
      ['staff-reports', 'Private reports and moderation notes'],
      ['ticket-log', 'Ticket closure records']
    ]
  }
];

const welcomeEmbed = () => new EmbedBuilder()
  .setColor(ACCENT)
  .setTitle('✦ Welcome to Nexus Development')
  .setDescription([
    'A home for Discord bots, websites, Minecraft projects, and creative developers.',
    '',
    '✧ Explore the project showcases.',
    '✧ Join beta tests and help improve projects.',
    '✧ Share your own work with the community.',
    '✧ Ask about commissions or open a private ticket.',
    '',
    'Start by reading **#rules** and checking out **#project-showcase**.'
  ].join('\n'))
  .setFooter({ text: 'Nexus Development • Build something remarkable' });

const rulesEmbed = () => new EmbedBuilder()
  .setColor(CYAN)
  .setTitle('✦ Community Rules')
  .setDescription([
    '**01 — Respect everyone.** No harassment, hate, threats, or targeted abuse.',
    '**02 — No spam.** Avoid message flooding, unsolicited advertising, and excessive pings.',
    '**03 — Keep content in the right channels.** Use the appropriate project and support areas.',
    '**04 — Protect privacy.** Never post passwords, tokens, private keys, or personal information.',
    '**05 — No malicious projects.** Do not share malware, token stealers, or tools intended to harm others.',
    '**06 — Be honest.** Do not claim someone else’s work as your own.',
    '**07 — Use tickets for private requests.** Keep client details and sensitive support issues private.',
    '**08 — Follow Discord’s Terms and Community Guidelines.**',
    '',
    'Staff may remove content or take action when necessary to protect the community.'
  ].join('\n'))
  .setFooter({ text: 'Nexus Development • Rules apply to all members' });

const hireEmbed = () => new EmbedBuilder()
  .setColor(ACCENT)
  .setTitle('✦ Hire / Commission a Project')
  .setDescription([
    'Looking for a Discord bot, website, dashboard, or Minecraft project?',
    '',
    '**How it works**',
    '1. Open a private ticket in #open-a-ticket.',
    '2. Describe what you want built.',
    '3. Discuss the scope, estimated cost, and timeframe.',
    '4. Approve the details before work begins.',
    '',
    '**Important:** Prices and delivery dates are confirmed individually. Do not send passwords or bot tokens. Never assume a project is accepted until the details are agreed upon.'
  ].join('\n'));

const projectTemplate = (kind) => new EmbedBuilder()
  .setColor(CYAN)
  .setTitle(`✦ ${kind} Showcase Template`)
  .setDescription([
    '**Project name:**',
    '**What it does:**',
    '**Main features:**',
    '**Technology / platform:**',
    '**Demo or website link:**',
    '**Screenshots / video:**',
    '**Current status:** In development / Beta / Released',
    '**Feedback wanted:**',
    '',
    'Do not publish API keys, passwords, private links, or other secrets.'
  ].join('\n'));

const slug = (value) => value
  .toLowerCase()
  .replace(/[✦]/g, '')
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 90);

async function getOrCreateRole(guild, definition) {
  let role = guild.roles.cache.find(r => r.name === definition.name);
  if (role) return role;

  role = await guild.roles.create({
    name: definition.name,
    color: definition.color,
    mentionable: false,
    hoist: ['Founder', 'Administrator', 'Moderator', 'Developer'].includes(
      definition.name
    ),
    reason: 'NexusGuard developer showcase setup'
  });

  return role;
}

async function getOrCreateCategory(guild, name, overwrites = []) {
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === name
  );

  if (!category) {
    category = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
      reason: 'NexusGuard developer showcase setup'
    });
  }

  return category;
}

async function getOrCreateTextChannel(guild, name, parent, overwrites = []) {
  let channel = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText &&
         c.name === name &&
         c.parentId === parent.id
  );

  if (!channel) {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent,
      permissionOverwrites: overwrites,
      reason: 'NexusGuard developer showcase setup'
    });
  }

  return channel;
}

async function sendStarterPost(channel, embed, marker) {
  // Avoid posting the same starter message every time setup is rerun.
  const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);

  if (recent?.some(message =>
    message.author.id === channel.client.user.id &&
    message.embeds.some(e => e.footer?.text === marker)
  )) {
    return false;
  }

  const copy = EmbedBuilder.from(embed)
    .setFooter({ text: marker });

  await channel.send({ embeds: [copy] });
  return true;
}

async function setupServer(guild, requester) {
  const me = guild.members.me || await guild.members.fetchMe();

  const needed = [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory
  ];

  const missing = needed.filter(permission =>
    !me.permissions.has(permission)
  );

  if (missing.length) {
    throw new Error(
      'NexusGuard is missing required server permissions. ' +
      'Grant Manage Channels, Manage Roles, View Channels, Send Messages, ' +
      'Embed Links, and Read Message History, then try again.'
    );
  }

  const everyone = guild.roles.everyone;
  const created = {
    roles: 0,
    categories: 0,
    channels: 0,
    posts: 0
  };

  const roles = {};

  for (const definition of ROLE_DEFINITIONS) {
    const existed = guild.roles.cache.some(r => r.name === definition.name);
    roles[definition.name] = await getOrCreateRole(guild, definition);
    if (!existed) created.roles++;
  }

  // Keep existing role permissions unchanged. New roles receive no
  // Administrator permission and must be assigned to people by staff.
  const staffRoles = [
    roles.Founder,
    roles.Administrator,
    roles.Moderator
  ];

  const staffOverwrites = [
    {
      id: everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    ...staffRoles.map(role => ({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    })
  ];

  for (const definition of CATEGORY_DEFINITIONS) {
    const overwrites = definition.staffOnly ? staffOverwrites : [];
    const oldCategory = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === definition.name
    );

    const category = await getOrCreateCategory(
      guild,
      definition.name,
      overwrites
    );

    if (!oldCategory) created.categories++;

    for (const [name] of definition.channels) {
      const oldChannel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText &&
             c.name === name &&
             c.parentId === category.id
      );

      await getOrCreateTextChannel(
        guild,
        name,
        category,
        definition.staffOnly ? staffOverwrites : []
      );

      if (!oldChannel) created.channels++;
    }
  }

  const channel = name => guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name === name
  );

  const posts = [
    [channel('welcome'), welcomeEmbed(), 'NexusGuard Setup • Welcome'],
    [channel('rules'), rulesEmbed(), 'NexusGuard Setup • Rules'],
    [channel('hire-me'), hireEmbed(), 'NexusGuard Setup • Hire'],
    [channel('bot-showcase'), projectTemplate('Discord Bot'), 'NexusGuard Setup • Bot Template'],
    [channel('website-showcase'), projectTemplate('Website'), 'NexusGuard Setup • Website Template'],
    [channel('minecraft-projects'), projectTemplate('Minecraft Project'), 'NexusGuard Setup • Minecraft Template']
  ];

  for (const [target, embed, marker] of posts) {
    if (target && await sendStarterPost(target, embed, marker)) {
      created.posts++;
    }
  }

  const ticketChannel = channel('open-a-ticket');

  if (ticketChannel) {
    const recent = await ticketChannel.messages.fetch({ limit: 25 }).catch(() => null);
    const alreadyPosted = recent?.some(message =>
      message.author.id === guild.client.user.id &&
      message.embeds.some(e => e.title === '✦ NexusGuard Support Desk')
    );

    if (!alreadyPosted) {
      const embed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('✦ NexusGuard Support Desk')
        .setDescription([
          'Open a private ticket for help, bug reports, or commissions.',
          '',
          'Choose the option that best describes your request.'
        ].join('\n'));

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('nexus_ticket_support')
          .setLabel('Support')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('nexus_ticket_bug')
          .setLabel('Bug Report')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('nexus_ticket_commission')
          .setLabel('Commission')
          .setStyle(ButtonStyle.Success)
      );

      await ticketChannel.send({ embeds: [embed], components: [row] });
      created.posts++;
    }
  }

  return { created, roles, requester };
}

async function handleTicketButton(interaction) {
  if (!interaction.isButton()) return false;

  const id = interaction.customId;

  if (id.startsWith('nexus_ticket_')) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Tickets can only be opened inside a server.',
        ephemeral: true
      });
      return true;
    }

    const guild = interaction.guild;
    const member = interaction.member;
    const kind = id.replace('nexus_ticket_', '');

    const existing = guild.channels.cache.find(channel =>
      channel.type === ChannelType.GuildText &&
      channel.topic === `nexus-ticket:${interaction.user.id}`
    );

    if (existing) {
      await interaction.reply({
        content: `You already have an open ticket: ${existing}`,
        ephemeral: true
      });
      return true;
    }

    const safeName = interaction.user.username
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 35) || 'member';

    const staffRoles = ['Founder', 'Administrator', 'Moderator']
      .map(name => guild.roles.cache.find(role => role.name === name))
      .filter(Boolean);

    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: guild.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels
        ]
      },
      ...staffRoles.map(role => ({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }))
    ];

    await interaction.deferReply({ ephemeral: true });

    try {
      const ticket = await guild.channels.create({
        name: `ticket-${safeName}`.slice(0, 90),
        type: ChannelType.GuildText,
        topic: `nexus-ticket:${interaction.user.id}`,
        permissionOverwrites: overwrites,
        reason: `Ticket opened by ${interaction.user.tag}`
      });

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('nexus_ticket_close')
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger)
      );

      const ticketEmbed = new EmbedBuilder()
        .setColor(kind === 'commission' ? CYAN : ACCENT)
        .setTitle(`✦ ${kind.charAt(0).toUpperCase() + kind.slice(1)} Ticket`)
        .setDescription([
          `Hello ${interaction.user}, welcome to your private ticket.`,
          '',
          '**Please provide:**',
          '• A clear description of your request',
          '• Relevant links or screenshots',
          '• What you have tried so far, if applicable',
          '',
          'Never share passwords, bot tokens, or private keys here.'
        ].join('\n'))
        .setFooter({ text: `Opened by ${interaction.user.tag}` });

      await ticket.send({
        content: `${interaction.user} ${staffRoles.map(r => `<@&${r.id}>`).join(' ')}`.trim(),
        embeds: [ticketEmbed],
        components: [closeRow],
        allowedMentions: {
          users: [interaction.user.id],
          roles: []
        }
      });

      await interaction.editReply({
        content: `Your private ticket is ready: ${ticket}`
      });
    } catch (error) {
      console.error('[NexusGuard Ticket]', error);
      await interaction.editReply({
        content: 'I could not create the ticket. Check my Manage Channels permission and role position.'
      });
    }

    return true;
  }

  if (id === 'nexus_ticket_close') {
    if (!interaction.inGuild()) return true;

    const channel = interaction.channel;
    const openerId = channel?.topic?.startsWith('nexus-ticket:')
      ? channel.topic.slice('nexus-ticket:'.length)
      : null;

    const isStaff = interaction.memberPermissions?.has(
      PermissionFlagsBits.ManageChannels
    );

    if (interaction.user.id !== openerId && !isStaff) {
      await interaction.reply({
        content: 'Only the ticket opener or a member with Manage Channels can close this ticket.',
        ephemeral: true
      });
      return true;
    }

    await interaction.reply({
      content: 'Closing this ticket in a moment…',
      ephemeral: true
    });

    await channel.send(
      `Ticket closed by ${interaction.user.tag}. This channel will now be deleted.`
    ).catch(() => {});

    setTimeout(() => {
      channel.delete(`Ticket closed by ${interaction.user.tag}`).catch(() => {});
    }, 5000);

    return true;
  }

  return false;
}

function registerSetupCommand(client) {
  const command = new SlashCommandBuilder()
    .setName('setupserver')
    .setDescription('Create the Nexus Development showcase server layout')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  client.once('ready', async () => {
    try {
      const existing = await client.application.commands.fetch();
      const found = existing.find(c => c.name === 'setupserver');

      if (!found) {
        await client.application.commands.create(command.toJSON());
        console.log('[NexusGuard] Registered /setupserver');
      }
    } catch (error) {
      console.error('[NexusGuard] Could not register /setupserver:', error);
    }
  });

  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isChatInputCommand() &&
          interaction.commandName === 'setupserver') {
        if (!interaction.inGuild()) {
          return interaction.reply({
            content: 'Use this command inside your Discord server.',
            ephemeral: true
          });
        }

        if (!interaction.memberPermissions?.has(
          PermissionFlagsBits.Administrator
        )) {
          return interaction.reply({
            content: 'Only server administrators can run this setup.',
            ephemeral: true
          });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const result = await setupServer(
            interaction.guild,
            interaction.user
          );

          const embed = new EmbedBuilder()
            .setColor(ACCENT)
            .setTitle('✦ NexusGuard Setup Complete')
            .setDescription([
              'The developer showcase structure has been checked and created.',
              '',
              `**New roles:** ${result.created.roles}`,
              `**New categories:** ${result.created.categories}`,
              `**New channels:** ${result.created.channels}`,
              `**Starter posts:** ${result.created.posts}`,
              '',
              'Existing matching channels and roles were reused.',
              'Review role positions and assign staff roles manually.'
            ].join('\n'))
            .setFooter({ text: 'NexusGuard • Purple × Cyan' });

          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          console.error('[NexusGuard Setup]', error);
          await interaction.editReply({
            content: `Setup stopped: ${String(error.message || error).slice(0, 1500)}`
          });
        }

        return;
      }

      await handleTicketButton(interaction);
    } catch (error) {
      console.error('[NexusGuard Interaction]', error);

      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Something went wrong while processing that action.',
          ephemeral: true
        }).catch(() => {});
      }
    }
  });
}

module.exports = {
  registerSetupCommand,
  setupServer,
  handleTicketButton
};
