const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const settingsPath = path.join(__dirname, 'data', 'guild-settings.json');
let settingsNeedMigration = false;

function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('The saved guild settings file must contain a JSON object.');
  }
  for (const guild of Object.values(settings)) {
    if (
      !guild ||
      typeof guild !== 'object' ||
      (guild.modLogChannelId !== null && typeof guild.modLogChannelId !== 'string') ||
      !Array.isArray(guild.rules) ||
      guild.rules.length > 10 ||
      (guild.reviews !== undefined &&
        (!guild.reviews || typeof guild.reviews !== 'object' || Array.isArray(guild.reviews))) ||
      guild.rules.some(rule =>
        !rule ||
        typeof rule.name !== 'string' ||
        typeof rule.phrase !== 'string' ||
        typeof rule.description !== 'string' ||
        (rule.id !== undefined && typeof rule.id !== 'string') ||
        (rule.active !== undefined && typeof rule.active !== 'boolean') ||
        (rule.confirmed !== undefined && !Number.isSafeInteger(rule.confirmed)) ||
        (rule.falseAlarms !== undefined && !Number.isSafeInteger(rule.falseAlarms))
      )
    ) {
      throw new Error('The saved guild settings file contains invalid rule configuration.');
    }
    if (!guild.reviews) guild.reviews = {};
    for (const review of Object.values(guild.reviews)) {
      if (
        !review ||
        typeof review !== 'object' ||
        !Array.isArray(review.ruleIds) ||
        review.ruleIds.some(ruleId => typeof ruleId !== 'string') ||
        !['pending', 'confirmed', 'false_alarm'].includes(review.status)
      ) {
        throw new Error('The saved guild settings file contains invalid review records.');
      }
    }
    for (const [reviewId, review] of Object.entries(guild.reviews)) {
      if (review.status !== 'pending') {
        delete guild.reviews[reviewId];
        settingsNeedMigration = true;
      }
    }
    for (const rule of guild.rules) {
      if (!rule.id) {
        rule.id = randomUUID();
        settingsNeedMigration = true;
      }
      if (rule.active === undefined) {
        rule.active = true;
        settingsNeedMigration = true;
      }
      if (rule.confirmed === undefined) {
        rule.confirmed = 0;
        settingsNeedMigration = true;
      }
      if (rule.falseAlarms === undefined) {
        rule.falseAlarms = 0;
        settingsNeedMigration = true;
      }
    }
  }
  return settings;
}

const guildSettings = loadSettings();
if (settingsNeedMigration) saveSettings();

function getGuildSettings(guildId) {
  if (!guildSettings[guildId]) {
    guildSettings[guildId] = { modLogChannelId: null, auditLogChannelId: null, rules: [], reviews: {}, appeals: {}, warnings: {} };
  }
  if (!guildSettings[guildId].reviews) guildSettings[guildId].reviews = {};
  if (!guildSettings[guildId].appeals) guildSettings[guildId].appeals = {};
  if (!guildSettings[guildId].warnings) guildSettings[guildId].warnings = {};
  if (guildSettings[guildId].auditLogChannelId === undefined) guildSettings[guildId].auditLogChannelId = null;
  return guildSettings[guildId];
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(guildSettings, null, 2), 'utf8');
  fs.renameSync(temporaryPath, settingsPath);
}

function normalizeText(text) {
  return text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function findRuleMatches(rules, content) {
  const normalizedContent = normalizeText(content);
  return rules.filter(rule => normalizedContent.includes(normalizeText(rule.phrase)));
}

function createReview(settings, reviewId, ruleIds) {
  settings.reviews[reviewId] = { ruleIds, status: 'pending' };
}

function resolveReview(settings, reviewId, outcome, moderatorId) {
  if (outcome !== 'confirmed' && outcome !== 'false_alarm') {
    throw new Error(`Unsupported review outcome: ${outcome}`);
  }

  const review = settings.reviews[reviewId];
  if (!review || review.status !== 'pending') return false;

  for (const ruleId of review.ruleIds) {
    const rule = settings.rules.find(candidate => candidate.id === ruleId);
    if (rule) rule[outcome === 'confirmed' ? 'confirmed' : 'falseAlarms'] += 1;
  }
  delete settings.reviews[reviewId];
  return true;
}

module.exports = {
  createReview,
  findRuleMatches,
  getGuildSettings,
  normalizeText,
  resolveReview,
  saveSettings,
};
