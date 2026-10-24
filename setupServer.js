'use strict';

const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const ACCENT = 0x8B5CF6;
const CYAN = 0x22D3EE;
const SETUP_REASON = 'NexusGuard developer showcase setup';

const ROLE_DEFINITIONS = [
  // Decorative role dividers: no permissions and no members.
  { name: '「━━━━ 👑 MANAGEMENT ━━━━」', color: 0xA78BFA, divider: true },
  { name: 'Owner', color: 0xF59E0B, permissions: [PermissionFlagsBits.Administrator], hoist: true },
  { name: 'Administrator', color: 0xEF4444, permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers], hoist: true },
  { name: 'Head Administrator', color: 0xFB7185, permissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers], hoist: true },

  { name: '「━━━━ 🛡️ STAFF TEAM ━━━━」', color: 0xA78BFA, divider: true },
  { name: 'Senior Moderator', color: 0xF97316, permissions: [PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages], hoist: true },
  { name: 'Moderator', color: 0x22C55E, permissions: [PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages], hoist: true },
  { name: 'Trial Moderator', color: 0x14B8A6, permissions: [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages] },
  { name: 'Support Team', color: 0x38BDF8, permissions: [] },
  { name: '「━━━━ 💻 CREATORS ━━━━」', color: 0xA78BFA, divider: true },
  { name: 'Developer', color: 0x8B5CF6, permissions: [], hoist: true },
  { name: 'Partner', color: 0xC084FC, permissions: [] },
  { name: 'Client', color: 0x22D3EE, permissions: [] },
  { name: 'Beta Tester', color: 0x10B981, permissions: [] },
  { name: '「━━━━ 💜 COMMUNITY ━━━━」', color: 0xA78BFA, divider: true },
  { name: 'VIP', color: 0xF472B6, permissions: [] },
  { name: 'Verified Member', color: 0x60A5FA, permissions: [] },
  { name: 'Community', color: 0x94A3B8, permissions: [] },
  { name: 'New Member', color: 0x9CA3AF, permissions: [] },
  { name: '「━━━━ ⚙️ SYSTEM ━━━━」', color: 0xA78BFA, divider: true },
  { name: 'Bots', color: 0x64748B, permissions: [] },
  { name: 'Muted', color: 0x6B7280, permissions: [] },
  { name: 'Quarantined', color: 0x991B1B, permissions: [] }
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

const welcomeEmbed = () =>
  new EmbedBuilder()
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
      'Start by reading **#rules** and checking out **#bot-showcase**.'
    ].join('\n'))
    .setFooter({
      text: 'Nexus Development • Build something remarkable'
    });

const rulesEmbed = () =>
  new EmbedBuilder()
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
    .setFooter({
      text: 'Nexus Development • Rules apply to all members'
    });

const hireEmbed = () =>
  new EmbedBuilder()
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
      '**Important:** Prices and delivery dates are confirmed individually. Do not send passwords or bot tokens. A project is not accepted until the details are agreed upon.'
    ].join('\n'));

const projectTemplate = kind =>
  new EmbedBuilder()
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

async function getOrCreateRole(guild, definition) {
  let role = guild.roles.cache.find(
    r => r.name === definition.name
  );

  const permissionBits = definition.divider
    ? []
    : (definition.permissions || []);

  if (role) {
    // Reconcile configured role settings without changing unrelated roles.
    await role.edit({
      color: definition.color,
      permissions: permissionBits,
      mentionable: false,
      hoist: Boolean(definition.hoist)
    }, SETUP_REASON);
    return { role: await guild.roles.fetch(role.id), created: false };
  }

  role = await guild.roles.create({
    name: definition.name,
    color: definition.color,
    permissions: permissionBits,
    mentionable: false,
    hoist: Boolean(definition.hoist),
    reason: SETUP_REASON
  });

  return { role, created: true };
}

async function getOrCreateCategory(guild, name, overwrites) {
  let category = guild.channels.cache.find(
    c =>
      c.type === ChannelType.GuildCategory &&
      c.name === name
  );

  if (category) {
    return { channel: category, created: false };
  }

  category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: SETUP_REASON
  });

  return { channel: category, created: true };
}

async function getOrCreateTextChannel(
  guild,
  name,
  parent,
  overwrites
) {
  let channel = guild.channels.cache.find(
    c =>
      c.type === ChannelType.GuildText &&
      c.name === name &&
      c.parentId === parent.id
  );

  if (channel) {
    return { channel, created: false };
  }

  channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    permissionOverwrites: overwrites,
    reason: SETUP_REASON
  });

  return { channel, created: true };
}

async function sendStarterPost(channel, embed, marker) {
  if (!channel) return false;

  const recent = await channel.messages
    .fetch({ limit: 50 })
    .catch(() => null);

  const exists = recent?.some(message =>
    message.author.id === channel.client.user.id &&
    message.embeds.some(
      item => item.footer?.text === marker
    )
  );

  if (exists) return false;

  const copy = EmbedBuilder.from(embed)
    .setFooter({ text: marker });

  await channel.send({ embeds: [copy] });

  return true;
}

async function setupServer(guild, requester) {
  const me =
    guild.members.me ||
    await guild.members.fetchMe();

  const required = [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory
  ];

  if (!me.permissions.has(required)) {
    throw new Error(
      'NexusGuard needs Manage Channels, Manage Roles, ' +
      'View Channel, Send Messages, Embed Links, and ' +
      'Read Message History permissions.'
    );
  }

  const created = {
    roles: 0,
    categories: 0,
    channels: 0,
    posts: 0
  };

  const roles = {};

  for (const definition of ROLE_DEFINITIONS) {
    const result = await getOrCreateRole(
      guild,
      definition
    );

    roles[definition.name] = result.role;

    if (result.created) {
      created.roles++;
    }
  }

  const staffRoles = [
    roles.Owner,
    roles.Administrator,
    roles['Head Administrator'],
    roles['Senior Moderator'],
    roles.Moderator,
    roles['Support Team']
  ].filter(Boolean);

  const announcementOnly = new Set([
    'welcome', 'rules', 'announcements', 'server-guide',
    'known-issues', 'services-and-prices', 'hire-me'
  ]);

  const memberRole = roles['Verified Member'] || roles.Community;
  const staffCanPost = staffRoles.filter(Boolean);

  const staffOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
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

  const channelsByName = new Map();

  for (const definition of CATEGORY_DEFINITIONS) {
    const overwrites = definition.staffOnly
      ? staffOverwrites
      : [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages]
          },
          {
            id: me.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages]
          },
          ...(memberRole ? [{
            id: memberRole.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]
          }] : []),
          {
            id: me.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages]
          },
          ...staffCanPost.map(role => ({
            id: role.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
          }))
        ];

    const categoryResult = await getOrCreateCategory(
      guild,
      definition.name,
      overwrites
    );

    // Apply permission overwrites to existing categories too.
    await categoryResult.channel.permissionOverwrites.set(overwrites, SETUP_REASON);

    const category = categoryResult.channel;

    if (categoryResult.created) {
      created.categories++;
    }

    for (const [name] of definition.channels) {
      let channelOverwrites = definition.staffOnly ? staffOverwrites : overwrites;
      if (!definition.staffOnly && announcementOnly.has(name)) {
        channelOverwrites = [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages]
          },
          {
            id: me.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages]
          },
          ...staffCanPost.map(role => ({
            id: role.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
          }))
        ];
      }

      const result = await getOrCreateTextChannel(
        guild,
        name,
        category,
        channelOverwrites
      );
      await result.channel.permissionOverwrites.set(channelOverwrites, SETUP_REASON);

      channelsByName.set(name, result.channel);

      if (result.created) {
        created.channels++;
      }
    }
  }

  const posts = [
    [
      'welcome',
      welcomeEmbed(),
      'NexusGuard Setup • Welcome'
    ],
    [
      'rules',
      rulesEmbed(),
      'NexusGuard Setup • Rules'
    ],
    [
      'hire-me',
      hireEmbed(),
      'NexusGuard Setup • Hire'
    ],
    [
      'bot-showcase',
      projectTemplate('Discord Bot'),
      'NexusGuard Setup • Bot Template'
    ],
    [
      'website-showcase',
      projectTemplate('Website'),
      'NexusGuard Setup • Website Template'
    ],
    [
      'minecraft-projects',
      projectTemplate('Minecraft Project'),
      'NexusGuard Setup • Minecraft Template'
    ]
  ];

  for (const [name, embed, marker] of posts) {
    const posted = await sendStarterPost(
      channelsByName.get(name),
      embed,
      marker
    );

    if (posted) {
      created.posts++;
    }
  }

  const ticketChannel =
    channelsByName.get('open-a-ticket');

  if (ticketChannel) {
    const recent = await ticketChannel.messages
      .fetch({ limit: 50 })
      .catch(() => null);

    const alreadyPosted = recent?.some(message =>
      message.author.id === guild.client.user.id &&
      message.embeds.some(
        item => item.title === '✦ NexusGuard Support Desk'
      )
    );

    if (!alreadyPosted) {
      const embed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('✦ NexusGuard Support Desk')
        .setDescription(
          'Open a private ticket for help, bug reports, or commissions.\n\n' +
          'Choose the option that best describes your request.'
        );

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

      await ticketChannel.send({
        embeds: [embed],
        components: [row]
      });

      created.posts++;
    }
  }

  return {
    created,
    roles,
    requester: requester?.id ?? null
  };
}

async function handleTicketButton(interaction) {
  if (!interaction.isButton()) return false;

  const id = interaction.customId;

  if (!id.startsWith('nexus_ticket_')) {
    return false;
  }

  if (!interaction.inGuild()) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Tickets can only be opened inside a server.',
        ephemeral: true
      });
    }

    return true;
  }

  if (id === 'nexus_ticket_close') {
    const channel = interaction.channel;

    const openerId = channel?.topic?.startsWith(
      'nexus-ticket:'
    )
      ? channel.topic.slice('nexus-ticket:'.length)
      : null;

    const isStaff =
      interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageChannels
      ) ?? false;

    if (
      interaction.user.id !== openerId &&
      !isStaff
    ) {
      await interaction.reply({
        content:
          'Only the ticket opener or a member with Manage Channels can close this ticket.',
        ephemeral: true
      });

      return true;
    }

    await interaction.reply({
      content: 'Closing this ticket in a moment…',
      ephemeral: true
    });

    await channel.send(
      `Ticket closed by ${interaction.user.tag}. This channel will be deleted in 5 seconds.`
    ).catch(() => {});

    setTimeout(() => {
      channel
        .delete(`Ticket closed by ${interaction.user.tag}`)
        .catch(() => {});
    }, 5000);

    return true;
  }

  const kinds = {
    nexus_ticket_support: 'support',
    nexus_ticket_bug: 'bug',
    nexus_ticket_commission: 'commission'
  };

  const kind = kinds[id];

  if (!kind) return false;

  const guild = interaction.guild;

  const existing = guild.channels.cache.find(
    channel =>
      channel.type === ChannelType.GuildText &&
      channel.topic ===
        `nexus-ticket:${interaction.user.id}`
  );

  if (existing) {
    await interaction.reply({
      content: `You already have an open ticket: ${existing}`,
      ephemeral: true
    });

    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const safeName = interaction.user.username
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 35) || 'member';

    const staffRoles = [
      'Founder',
      'Administrator',
      'Moderator'
    ]
      .map(name =>
        guild.roles.cache.find(
          role => role.name === name
        )
      )
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

    const ticket = await guild.channels.create({
      name: `ticket-${safeName}`.slice(0, 90),
      type: ChannelType.GuildText,
      topic: `nexus-ticket:${interaction.user.id}`,
      permissionOverwrites: overwrites,
      reason: `Ticket opened by ${interaction.user.tag}`
    });

    const closeRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('nexus_ticket_close')
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger)
      );

    const ticketEmbed = new EmbedBuilder()
      .setColor(
        kind === 'commission' ? CYAN : ACCENT
      )
      .setTitle(
        `✦ ${kind.charAt(0).toUpperCase() + kind.slice(1)} Ticket`
      )
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
      .setFooter({
        text: `Opened by ${interaction.user.tag}`
      });

    await ticket.send({
      content: `${interaction.user}`,
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
      content:
        'I could not create the ticket. Check my Manage Channels permission and role position.'
    }).catch(() => {});
  }

  return true;
}

function registerSetupCommand(client) {
  const command = new SlashCommandBuilder()
    .setName('setupserver')
    .setDescription(
      'Create the Nexus Development showcase server layout'
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    );

  client.once('ready', async () => {
    try {
      const commands = client.application?.commands;

      if (!commands) {
        throw new Error(
          'Discord application is not available yet.'
        );
      }

      const existing = await commands.fetch();

      const found = existing.find(
        item => item.name === 'setupserver'
      );

      if (found) {
        await commands.edit(
          found.id,
          command.toJSON()
        );

        console.log(
          '[NexusGuard] Updated /setupserver'
        );
      } else {
        await commands.create(command.toJSON());

        console.log(
          '[NexusGuard] Registered /setupserver'
        );
      }
    } catch (error) {
      console.error(
        '[NexusGuard] Could not register /setupserver:',
        error
      );
    }
  });

  
  client.on('interactionCreate', async interaction => {
    // Handle /setupserver separately from ticket buttons.
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === 'setupserver'
    ) {
      try {
        // Acknowledge immediately, and only once.
        await interaction.deferReply({ flags: 64 });
      } catch (error) {
        console.error(
          '[NexusGuard Setup] Could not acknowledge interaction:',
          error
        );
        return;
      }

      try {
        if (!interaction.inGuild() || !interaction.guild) {
          await interaction.editReply({
            content: 'Please run /setupserver inside your Discord server.'
          });
          return;
        }

        if (
          !interaction.memberPermissions?.has(
            PermissionFlagsBits.Administrator
          )
        ) {
          await interaction.editReply({
            content: 'Only server administrators can run this setup.'
          });
          return;
        }

        const result = await setupServer(
          interaction.guild,
          interaction.user
        );

        const embed = new EmbedBuilder()
          .setColor(ACCENT)
          .setTitle('✦ NexusGuard Setup Complete')
          .setDescription([
            'The server layout has been checked and created.',
            '',
            `**New roles:** ${result.created.roles}`,
            `**New categories:** ${result.created.categories}`,
            `**New channels:** ${result.created.channels}`,
            `**Starter posts:** ${result.created.posts}`,
            '',
            'Existing matching roles and channels were reused.',
            'Review role positions and test channel permissions.'
          ].join('\n'))
          .setFooter({
            text: 'NexusGuard • Purple × Cyan'
          });

        await interaction.editReply({
          embeds: [embed]
        });
      } catch (error) {
        console.error('[NexusGuard Setup]', error);

        await interaction.editReply({
          content:
            `Setup stopped: ${String(error.message || error).slice(0, 1500)}`
        }).catch(() => {});
      }

      return;
    }

    // Preserve the existing ticket-button functionality.
    try {
      await handleTicketButton(interaction);
    } catch (error) {
      console.error('[NexusGuard Ticket Interaction]', error);

      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction.reply({
          content: 'Something went wrong while processing that action.',
          flags: 64
        }).catch(() => {});
      }
    }
  });


    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.editReply({
        content: 'Use this command inside your Discord server.'
      });
      return;
    }

    if (
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      )
    ) {
      await interaction.editReply({
        content: 'Only server administrators can run this setup.'
      });
      return;
    }

        try {
          const guild = interaction.guild;

if (!guild || !interaction.guildId) {
  await interaction.editReply({
    content: 'I could not identify the Discord server. Please run /setupserver again inside your server.'
  });
  return;
}

const result = await setupServer(guild, interaction.user);
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
            .setFooter({
              text: 'NexusGuard • Purple × Cyan'
            });

          await interaction.editReply({
            embeds: [embed]
          });
        } catch (error) {
          console.error(
            '[NexusGuard Setup]',
            error
          );

          await interaction.editReply({
            content:
              `Setup stopped: ${String(error.message || error).slice(0, 1500)}`
          });
        }

        return;
      }

      await handleTicketButton(interaction);
    } catch (error) {
      console.error(
        '[NexusGuard Interaction]',
        error
      );

      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction.reply({
          content:
            'Something went wrong while processing that action.',
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