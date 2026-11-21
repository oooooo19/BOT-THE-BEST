const http = require('node:http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('Bot is running'); }).listen(PORT, () => console.log(`Web listener on port ${PORT}`));

const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  createReview,
  findRuleMatches,
  getGuildSettings,
  normalizeText,
  resolveReview,
  saveSettings,
} = require('./ruleStore');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const rest = new REST({ version: '10' });

client.once(Events.ClientReady, readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}. Bot is ready.`);
});

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is online.'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show commands and setup guidance.'),
  new SlashCommandBuilder()
    .setName('rule')
    .setDescription('Configure and test phrase-based rule review.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a rule and a phrase that should be reviewed.')
        .addStringOption(option =>
          option.setName('name').setDescription('Short name for the rule').setRequired(true).setMaxLength(32),
        )
        .addStringOption(option =>
          option
            .setName('phrase')
            .setDescription('Exact phrase to look for (use a specific phrase, not a broad word)')
            .setRequired(true)
            .setMinLength(4)
            .setMaxLength(100),
        )
        .addStringOption(option =>
          option
            .setName('description')
            .setDescription('What server rule moderators should check')
            .setRequired(true)
            .setMaxLength(200),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a configured rule by name.')
        .addStringOption(option =>
          option.setName('name').setDescription('Name of the rule to remove').setRequired(true).setMaxLength(32),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('enable')
        .setDescription('Enable a tested rule for moderator review.')
        .addStringOption(option =>
          option.setName('name').setDescription('Name of the rule to enable').setRequired(true).setMaxLength(32),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('disable')
        .setDescription('Pause a rule without deleting its feedback.')
        .addStringOption(option =>
          option.setName('name').setDescription('Name of the rule to disable').setRequired(true).setMaxLength(32),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand.setName('list').setDescription('List configured rules.'),
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('test')
        .setDescription('Test sample text against your rules without logging or taking action.')
        .addStringOption(option =>
          option
            .setName('text')
            .setDescription('Sample message to test')
            .setRequired(true)
            .setMaxLength(1000),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand.setName('stats').setDescription('Show moderator feedback for each rule.'),
    ),
  new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Choose where potential rule matches are sent.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the private moderator review channel.')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Private text channel for moderator reviews')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand.setName('disable').setDescription('Stop sending rule matches to a review channel.'),
    ),
  new SlashCommandBuilder()
    .setName('auditlog')
    .setDescription('Choose where moderation actions are logged.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the audit log channel.')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Text channel for moderation audit logs')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand(subcommand =>
      subcommand.setName('disable').setDescription('Disable moderation audit logging.'),
    ),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Temporarily prevent a member from chatting.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option.setName('user').setDescription('Member to timeout').setRequired(true),
    )
    .addStringOption(option =>
      option
        .setName('duration')
        .setDescription('Duration, e.g. 10m, 2h, or 1d (maximum 28d)')
        .setRequired(true),
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Why this action is being taken'),
    ),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Remove a member from the server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(option =>
      option.setName('user').setDescription('Member to kick').setRequired(true),
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Why this action is being taken'),
    ),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(option =>
      option.setName('user').setDescription('Member to ban').setRequired(true),
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Why this action is being taken'),
    ),
];

function parseDuration(input) {
  const match = /^(\d+)(s|m|h|d)$/i.exec(input);
  if (!match) return null;

  const amount = Number(match[1]);
  const unitMilliseconds = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[match[2].toLowerCase()];
  const duration = amount * unitMilliseconds;
  const maximumDuration = 28 * 24 * 60 * 60 * 1000;

  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > maximumDuration) {
    return null;
  }
  return duration;
}

async function getModerationTarget(interaction) {
  const user = interaction.options.getUser('user', true);
  const target = await interaction.guild.members.fetch(user.id);
  const moderator = await interaction.guild.members.fetch(interaction.user.id);

  if (target.id === interaction.guild.ownerId) {
    throw new Error('The server owner cannot be moderated.');
  }
  if (target.id === moderator.id) {
    throw new Error('You cannot moderate yourself.');
  }
  if (
    moderator.id !== interaction.guild.ownerId &&
    target.roles.highest.comparePositionTo(moderator.roles.highest) >= 0
  ) {
    throw new Error('You can only moderate members with a lower role than yours.');
  }

  return target;
}

async function handleConfigCommand(interaction) {
  const settings = getGuildSettings(interaction.guildId);

  if (interaction.commandName === 'modlog') {
    if (interaction.options.getSubcommand() === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      settings.modLogChannelId = channel.id;
      saveSettings();
      await interaction.editReply({
        content: `Potential rule matches will be sent to <#${channel.id}>. Make sure only moderators can view that channel.`,
      });
      return;
    }

    settings.modLogChannelId = null;
    saveSettings();
    await interaction.editReply({ content: 'Moderator review logging is disabled.' });
    return;
  }

  if (interaction.commandName === 'auditlog') {
    if (interaction.options.getSubcommand() === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      settings.auditLogChannelId = channel.id;
      saveSettings();
      await interaction.editReply({
        content: `Moderation actions will be logged to <#${channel.id}>.`,
      });
      return;
    }

    settings.auditLogChannelId = null;
    saveSettings();
    await interaction.editReply({ content: 'Moderation audit logging is disabled.' });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'add') {
    if (!settings.modLogChannelId) {
      await interaction.editReply({
        content: 'Set a review channel first with `/modlog set`, then add rules.',
      });
      return;
    }
    if (settings.rules.length >= 10) {
      await interaction.editReply({ content: 'This starter supports up to 10 rules per server.' });
      return;
    }

    const name = interaction.options.getString('name', true).trim();
    const phrase = interaction.options.getString('phrase', true).trim();
    const description = interaction.options.getString('description', true).trim();
    const normalizedName = name.toLocaleLowerCase('en-US');
    const normalizedPhrase = normalizeText(phrase);

    if (!name || normalizedPhrase.length < 4 || !description) {
      await interaction.editReply({
        content: 'Use a specific phrase of at least four characters and a non-empty rule description.',
      });
      return;
    }
    if (settings.rules.some(rule =>
      rule.name.toLocaleLowerCase('en-US') === normalizedName ||
      normalizeText(rule.phrase) === normalizedPhrase
    )) {
      await interaction.editReply({
        content: 'A rule with that name or phrase already exists. Remove or edit it first.',
      });
      return;
    }

    settings.rules.push({
      id: randomUUID(),
      name,
      phrase,
      description,
      active: false,
      confirmed: 0,
      falseAlarms: 0,
    });
    saveSettings();
    await interaction.editReply({
      content: `Added **${name}** as a draft. Test it with \`/rule test\`, then enable it with \`/rule enable\`.`,
    });
    return;
  }

  if (subcommand === 'remove') {
    const name = interaction.options.getString('name', true).trim().toLocaleLowerCase('en-US');
    const ruleIndex = settings.rules.findIndex(
      rule => rule.name.toLocaleLowerCase('en-US') === name,
    );
    if (ruleIndex === -1) {
      await interaction.editReply({ content: 'No rule with that name was found.' });
      return;
    }

    if (subcommand === 'enable' || subcommand === 'disable') {
      const name = interaction.options.getString('name', true).trim().toLocaleLowerCase('en-US');
      const rule = settings.rules.find(candidate =>
        candidate.name.toLocaleLowerCase('en-US') === name,
      );
      if (!rule) {
        await interaction.editReply({ content: 'No rule with that name was found.' });
        return;
      }

      rule.active = subcommand === 'enable';
      saveSettings();
      await interaction.editReply({
        content: `Rule **${rule.name}** is now ${rule.active ? 'enabled' : 'disabled'}.`,
      });
      return;
    }

    const [removedRule] = settings.rules.splice(ruleIndex, 1);
    saveSettings();
    await interaction.editReply({ content: `Removed **${removedRule.name}**.` });
    return;
  }

  if (subcommand === 'test') {
    if (settings.rules.length === 0) {
      await interaction.editReply({ content: 'No rules configured yet. Add one with `/rule add`.' });
      return;
    }

    const sample = interaction.options.getString('text', true);
    const matches = findRuleMatches(settings.rules, sample);
    const result = matches.length > 0
      ? `Would flag: ${matches.map(rule => `**${rule.name}**`).join(', ')}.`
      : 'No configured rule matched that sample.';
    await interaction.editReply({
      content: `${result} This is only a test; no report or moderation action was created.`,
    });
    return;
  }

  if (subcommand === 'stats') {
    if (settings.rules.length === 0) {
      await interaction.editReply({ content: 'No rules configured yet.' });
      return;
    }

    const stats = settings.rules
      .map(rule =>
        `• **${rule.name}** (${rule.active ? 'enabled' : 'draft/disabled'}) — confirmed: ${rule.confirmed}; false alarms: ${rule.falseAlarms}`,
      )
      .join('\n');
    await interaction.editReply({
      content: `${stats}\nFeedback is informational; it does not automatically change rules or take action.`,
    });
    return;
  }

  if (settings.rules.length === 0) {
    await interaction.editReply({ content: 'No rules configured yet. Add one with `/rule add`.' });
    return;
  }

  const ruleList = settings.rules
    .map(rule => `• **${rule.name}** (${rule.active ? 'enabled' : 'draft/disabled'}) — phrase: ${rule.phrase}`)
    .join('\n');
  await interaction.editReply({ content: ruleList });
}

async function reviewMessage(message) {
  if (!message.guild || message.author.bot || !message.content.trim()) return;

  const settings = getGuildSettings(message.guild.id);
  if (!settings.modLogChannelId || settings.rules.length === 0) return;

  const activeRules = settings.rules.filter(rule => rule.active);
  const matches = findRuleMatches(activeRules, message.content);
  if (matches.length === 0) return;

  const channel = await message.guild.channels.fetch(settings.modLogChannelId);
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    throw new Error(`Configured moderator review channel ${settings.modLogChannelId} is unavailable.`);
  }

  const matchedRules = matches.slice(0, 3);
  const ruleDetails = matchedRules
    .map(rule => `• **${rule.name}**: ${rule.description} (phrase: ${rule.phrase})`)
    .join('\n');
  const remainingMatches = matches.length - matchedRules.length;
  const excerpt = message.content.length > 300
    ? `${message.content.slice(0, 300)}…`
    : message.content;
  const extraMatches = remainingMatches > 0
    ? `\n• ${remainingMatches} additional rule match(es)`
    : '';
  const reviewId = randomUUID();
  const reviewButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rule-review:confirmed:${reviewId}`)
      .setLabel('Confirm violation')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`rule-review:false_alarm:${reviewId}`)
      .setLabel('False alarm')
      .setStyle(ButtonStyle.Secondary),
  );
  createReview(settings, reviewId, matchedRules.map(rule => rule.id));
  saveSettings();

  await channel.send({
    content:
      `**Potential rule match — review only; no action taken**\n` +
      `Member: ${message.author.tag} (${message.author.id})\n` +
      `Channel: <#${message.channel.id}>\n` +
      `${ruleDetails}${extraMatches}\n` +
      `Message: ${excerpt}\n` +
      `${message.url}`,
    components: [reviewButtons],
    allowedMentions: { parse: [] },
  });
}

async function handleReviewButton(interaction) {
  if (!interaction.customId.startsWith('rule-review:')) return;

  const [, outcome, reviewId] = interaction.customId.split(':');
  if (!['confirmed', 'false_alarm'].includes(outcome) || !reviewId) {
    await interaction.reply({ content: 'This review button is invalid.', ephemeral: true });
    return;
  }
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Review buttons only work in a server.', ephemeral: true });
    return;
  }

  const canReview =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canReview) {
    await interaction.reply({
      content: 'You need Manage Messages or Manage Server permission to review reports.',
      ephemeral: true,
    });
    return;
  }

  const settings = getGuildSettings(interaction.guildId);
  if (!resolveReview(settings, reviewId, outcome)) {
    await interaction.reply({
      content: 'This report has already been reviewed or its review data is unavailable.',
      ephemeral: true,
    });
    return;
  }
  saveSettings();

  const result = outcome === 'confirmed' ? 'Confirmed as a violation' : 'Marked as a false alarm';
  await logAudit(interaction.guild, settings, `📋 ${interaction.user.tag} ${result.toLowerCase()} for review ${reviewId}.`);
  await interaction.update({
    content: `${interaction.message.content}\n\n**${result} by <@${interaction.user.id}>.**`,
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function logAudit(guild, settings, content) {
  if (!settings.auditLogChannelId) return;
  try {
    const channel = await guild.channels.fetch(settings.auditLogChannelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      await channel.send({ content, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    console.error('Audit log failed:', error);
  }
}
async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('appeal:')) {
      const caseId = interaction.customId.split(':')[1];
      const modal = new ModalBuilder()
        .setCustomId(`appeal-modal:${caseId}`)
        .setTitle('Appeal')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Why should this be reversed?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
        ));
      await interaction.showModal(modal);
      return;
    }
    await handleReviewButton(interaction);
    return;
  }
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('appeal-modal:')) {
      const caseId = interaction.customId.split(':')[1];
      const settings = getGuildSettings(interaction.guildId || '0');
      // find guild settings by searching? We need guildId. Modal submit may have guildId.
      const appealReason = interaction.fields.getTextInputValue('reason');
      const appealCase = settings.appeals?.[caseId];
      if (appealCase) {
        appealCase.appealText = appealReason;
        appealCase.status = 'appealed';
        saveSettings();
      }
      const channel = settings.auditLogChannelId ? await interaction.client.channels.fetch(settings.auditLogChannelId).catch(()=>null) : null;
      if (channel && channel.isTextBased()) {
        await channel.send({ content: `📩 Appeal for case ${caseId} (${appealCase?.action}) by <@${appealCase?.userId}>: ${appealReason}`, allowedMentions: { parse: [] } });
      }
      await interaction.reply({ content: 'Your appeal was submitted.', ephemeral: true });
      return;
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: 'Pong!', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'help') {
    await interaction.reply({
      ephemeral: true,
      content: [
        '**Rule review** (requires Manage Server)',
        '`/modlog set channel` — choose a private moderator review channel.',
        '`/modlog disable` — stop sending review reports.',
        '`/rule add name phrase description` — create a draft rule.',
        '`/rule list` — show configured rules.',
        '`/rule test text` — preview matching without creating a report.',
        '`/rule enable name` — start reviewing matches after testing a draft.',
        '`/rule disable name` — pause a rule.',
        '`/rule stats` — view moderator confirmations and false alarms.',
        '`/rule remove name` — remove a rule.',
        'Test a draft with `/rule test text`, then use `/rule enable name`. Review buttons record feedback only.',
        '',
        '**Manual moderation**',
        '`/auditlog set channel` — log all moderation actions to a channel.',
        '`/timeout user duration [reason]` — timeout for `10m`, `2h`, etc. (maximum 28d); requires Moderate Members.',
        '`/kick user [reason]` — requires Kick Members.',
        '`/ban user [reason]` — requires Ban Members.',
        '`/ping` — check that the bot is online.',
        '',
        'Rule matches are phrase-based review suggestions only. The bot does not automatically warn, delete, timeout, kick, or ban anyone.',
      ].join('\n'),
    });
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true,
    });
    return;
  }

  const isConfigCommand =
    interaction.commandName === 'rule' || interaction.commandName === 'modlog' || interaction.commandName === 'auditlog';
  const requiredPermission = {
    rule: PermissionFlagsBits.ManageGuild,
    modlog: PermissionFlagsBits.ManageGuild,
    auditlog: PermissionFlagsBits.ManageGuild,
    timeout: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
    ban: PermissionFlagsBits.BanMembers,
  }[interaction.commandName];
  if (!requiredPermission) return;
  if (!interaction.memberPermissions?.has(requiredPermission)) {
    await interaction.reply({
      content: 'You do not have permission to use this moderation command.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  if (isConfigCommand) {
    try {
      await handleConfigCommand(interaction);
    } catch (error) {
      console.error(`/${interaction.commandName} configuration failed:`, error);
      await interaction.editReply({
        content: 'Could not save this configuration. Check the bot logs for details.',
      });
    }
    return;
  }

  const reason = interaction.options.getString('reason') || 'No reason provided';

  try {
    const settings = getGuildSettings(interaction.guildId);
    const target = await getModerationTarget(interaction);

    if (interaction.commandName === 'timeout') {
      const durationInput = interaction.options.getString('duration', true);
      const duration = parseDuration(durationInput);
      if (!duration) {
        await interaction.editReply({
          content: 'Use a duration like `10m`, `2h`, or `1d` (maximum `28d`).',
        });
        return;
      }

      await target.timeout(duration, reason);
      await interaction.editReply({
        content: `Timed out **${target.user.tag}** for ${durationInput}. Reason: ${reason}`,
      });
      await logAudit(interaction.guild, settings, `⏱️ ${interaction.user.tag} timed out **${target.user.tag}** (${target.id}) for ${durationInput}. Reason: ${reason}`);
      const caseId = randomUUID();
      settings.appeals[caseId] = { userId: target.id, action: 'timeout', reason, moderatorId: interaction.user.id, duration: durationInput, status: 'active' };
      saveSettings();
      try { await target.send({ content: `You were timed out. You may appeal this action.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`appeal:${caseId}`).setLabel('Appeal').setStyle(ButtonStyle.Primary))] }); } catch {}
      return;
    }

    if (interaction.commandName === 'kick') {
      await target.kick(reason);
      await interaction.editReply({
        content: `Kicked **${target.user.tag}**. Reason: ${reason}`,
      });
      await logAudit(interaction.guild, settings, `👢 ${interaction.user.tag} kicked **${target.user.tag}** (${target.id}). Reason: ${reason}`);
      const caseIdKick = randomUUID();
      settings.appeals[caseIdKick] = { userId: target.id, action: 'kick', reason, moderatorId: interaction.user.id, status: 'active' };
      saveSettings();
      try { await target.send({ content: `You were kicked. You may appeal this action.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`appeal:${caseIdKick}`).setLabel('Appeal').setStyle(ButtonStyle.Primary))] }); } catch {}
      return;
    }

    if (interaction.commandName === 'ban') {
      await target.ban({ reason });
      await interaction.editReply({
        content: `Banned **${target.user.tag}**. Reason: ${reason}`,
      });
      await logAudit(interaction.guild, settings, `🔨 ${interaction.user.tag} banned **${target.user.tag}** (${target.id}). Reason: ${reason}`);
      const caseIdBan = randomUUID();
      settings.appeals[caseIdBan] = { userId: target.id, action: 'ban', reason, moderatorId: interaction.user.id, status: 'active' };
      saveSettings();
      try { await target.send({ content: `You were banned. You may appeal this action.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`appeal:${caseIdBan}`).setLabel('Appeal').setStyle(ButtonStyle.Primary))] }); } catch {}
    }
  } catch (error) {
    console.error(`/${interaction.commandName} failed:`, error);
    const errorMessage = error instanceof Error ? error.message : '';
    const message = [
      'The server owner cannot be moderated.',
      'You cannot moderate yourself.',
      'You can only moderate members with a lower role than yours.',
    ].includes(errorMessage)
      ? errorMessage
      : 'The action failed. Check the bot permissions and role hierarchy, then try again.';

    await interaction.editReply({ content: message });
  }
}

client.on(Events.InteractionCreate, interaction => {
  handleInteraction(interaction).catch(error => {
    console.error('Failed to handle interaction:', error);
  });
});

client.on(Events.MessageCreate, message => {
  reviewMessage(message).catch(error => {
    console.error('Moderator review logging failed:', error);
  });
});

async function start() {
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    throw new Error('Set DISCORD_TOKEN and CLIENT_ID in your .env file.');
  }
  rest.setToken(DISCORD_TOKEN);

  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  await rest.put(route, { body: commands.map(command => command.toJSON()) });
  console.log(GUILD_ID ? 'Registered server slash commands.' : 'Registered global slash commands.');
  await client.login(DISCORD_TOKEN);
}

start().catch(error => {
  if (error instanceof Error && error.message === 'Used disallowed intents') {
    console.error(
      'Bot startup failed: Enable Message Content Intent in Developer Portal > Bot > Privileged Gateway Intents, then restart.',
    );
  } else {
    console.error('Bot startup failed:', error);
  }
  process.exitCode = 1;
});
