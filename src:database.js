const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH || './data/nexusguard.sqlite';
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
 guild_id TEXT PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
 target_id TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS audit_guild_created ON audit_log(guild_id, created_at DESC);
CREATE TABLE IF NOT EXISTS warnings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, moderator_id TEXT NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS warnings_user ON warnings(guild_id, user_id);
CREATE TABLE IF NOT EXISTS tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, user_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', subject TEXT NOT NULL DEFAULT 'Support request', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 closed_at TEXT
);
CREATE TABLE IF NOT EXISTS cases (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, moderator_id TEXT NOT NULL,
 type TEXT NOT NULL, reason TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_xp (
 guild_id TEXT NOT NULL, user_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
 currency INTEGER NOT NULL DEFAULT 0, last_message_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS reminders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, channel_id TEXT, text TEXT NOT NULL,
 due_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scheduled_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, text TEXT NOT NULL,
 due_at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS custom_commands (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, response TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(guild_id,name)
);
CREATE TABLE IF NOT EXISTS giveaways (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
 prize TEXT NOT NULL, ends_at INTEGER NOT NULL, winner_count INTEGER NOT NULL DEFAULT 1, ended INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS suggestions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS owner_hourly_report_runs (
 hour_key TEXT PRIMARY KEY, claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const defaults = {
 prefix: '!', accent: '#8b5cf6', welcomeEnabled: false, welcomeChannelId: '', welcomeMessage: 'Welcome {user} to **{server}**!',
 leaveEnabled: false, leaveChannelId: '', logChannelId: '', modLogEnabled: true, automodEnabled: true,
 antiSpam: true, antiInvite: false, antiMassMention: true, antiRaid: true, mentionLimit: 5,
 ticketCategoryId: '', ticketStaffRoleId: '', ticketLogChannelId: '', modRoleIds: [],
 levelEnabled: true, xpPerMessage: 8, xpCooldownSeconds: 45, currencyName: 'Nexus Credits',
 slowmodeDefault: 0, verificationEnabled: false, verificationRoleId: '', verificationChannelId: '',
 suggestionsChannelId: '', announcementsChannelId: '', starboardChannelId: '', starboardThreshold: 3,
 autoRoleIds: [], blockedWords: [], allowedInviteDomains: [], maxWarningsBeforeTimeout: 3,
 defaultTimeoutMinutes: 10, raidJoinThreshold: 8, raidWindowSeconds: 15, serverNotes: ''
};
function getSettings(guildId) {
 const row = db.prepare('SELECT settings FROM guild_settings WHERE guild_id=?').get(guildId);
 return { ...defaults, ...(row ? safeJson(row.settings, {}) : {}) };
}
function setSettings(guildId, patch) {
 const settings = { ...getSettings(guildId), ...patch };
 db.prepare(`INSERT INTO guild_settings(guild_id,settings,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
 ON CONFLICT(guild_id) DO UPDATE SET settings=excluded.settings,updated_at=CURRENT_TIMESTAMP`).run(guildId, JSON.stringify(settings));
 return settings;
}
function safeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function audit(guildId, actorId, action, targetId = null, details = {}) {
 db.prepare('INSERT INTO audit_log(guild_id,actor_id,action,target_id,details) VALUES(?,?,?,?,?)')
  .run(guildId, actorId || null, action, targetId, JSON.stringify(details));
}
module.exports = { db, defaults, getSettings, setSettings, audit, safeJson };
