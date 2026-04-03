/**
 * Push Gateway — SQLite persistence layer
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'push-gateway.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS push_tokens (
  pushkey TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_id TEXT,
  device_name TEXT,
  registered_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);

CREATE TABLE IF NOT EXISTS mute_settings (
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  muted_until INTEGER NOT NULL,
  mention_override INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, room_id)
);
CREATE INDEX IF NOT EXISTS idx_mute_settings_user_id ON mute_settings(user_id);
`);

// Migrate: add last_used column if missing (for existing databases)
try {
  db.exec('ALTER TABLE push_tokens ADD COLUMN last_used INTEGER');
} catch (_e) {
  // Column already exists — ignore
}

// Prepared statements
const getToken = db.prepare('SELECT * FROM push_tokens WHERE pushkey = ?');
const upsertToken = db.prepare(`
  INSERT OR REPLACE INTO push_tokens (pushkey, user_id, platform, app_id, device_name, registered_at, last_used)
  VALUES (@pushkey, @user_id, @platform, @app_id, @device_name, @registered_at, @registered_at)
`);
const tokenCount = db.prepare('SELECT COUNT(*) as cnt FROM push_tokens');
const touchToken = db.prepare('UPDATE push_tokens SET last_used = ? WHERE pushkey = ?');
const STALE_TOKEN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const pruneStaleTokens = db.prepare('DELETE FROM push_tokens WHERE last_used IS NOT NULL AND last_used < ?');
const pruneNeverUsedTokens = db.prepare('DELETE FROM push_tokens WHERE last_used IS NULL AND registered_at < ?');

const getMute = db.prepare('SELECT * FROM mute_settings WHERE user_id = ? AND room_id = ?');
const upsertMute = db.prepare(`
  INSERT OR REPLACE INTO mute_settings (user_id, room_id, muted_until, mention_override)
  VALUES (@user_id, @room_id, @muted_until, @mention_override)
`);
const deleteMute = db.prepare('DELETE FROM mute_settings WHERE user_id = ? AND room_id = ?');
const muteCount = db.prepare('SELECT COUNT(*) as cnt FROM mute_settings');

// JSON migration
function migrateFromJson() {
  if (tokenCount.get().cnt > 0) return;

  const jsonFile = path.join(DATA_DIR, 'push-tokens.json');
  if (!fs.existsSync(jsonFile)) return;

  try {
    const raw = fs.readFileSync(jsonFile, 'utf-8');
    const data = JSON.parse(raw);

    const migrate = db.transaction(() => {
      if (data.pushTokens) {
        for (const [key, val] of Object.entries(data.pushTokens)) {
          upsertToken.run({
            pushkey: key,
            user_id: val.userId,
            platform: val.platform,
            app_id: val.appId || null,
            device_name: val.deviceName || null,
            registered_at: val.registeredAt || Date.now(),
          });
        }
      }
      if (data.muteSettings) {
        for (const [key, val] of Object.entries(data.muteSettings)) {
          const parts = key.split(':');
          const userId = parts[0];
          const roomId = parts.slice(1).join(':');
          upsertMute.run({
            user_id: userId,
            room_id: roomId,
            muted_until: val.mutedUntil,
            mention_override: val.mentionOverride ? 1 : 0,
          });
        }
      }
    });
    migrate();
    console.log('[Push] Migrated data from push-tokens.json to SQLite');
  } catch (err) {
    console.error('[Push] JSON migration failed:', err.message);
  }
}

migrateFromJson();

/**
 * Remove push tokens not used in 30 days.
 * Returns the number of tokens pruned.
 */
function pruneTokens() {
  const cutoff = Date.now() - STALE_TOKEN_MS;
  const r1 = pruneStaleTokens.run(cutoff);
  const r2 = pruneNeverUsedTokens.run(cutoff);
  return r1.changes + r2.changes;
}

module.exports = {
  db,
  getToken,
  upsertToken,
  tokenCount,
  touchToken,
  pruneTokens,
  STALE_TOKEN_MS,
  getMute,
  upsertMute,
  deleteMute,
  muteCount,
};
