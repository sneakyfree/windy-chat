/**
 * Translation Service — SQLite persistence layer
 * Caches translations and stores user language preferences.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'translation.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  confidence REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_created_at ON translation_cache(created_at);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  windy_identity_id TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  auto_translate INTEGER DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prefs_windy_identity_id ON user_preferences(windy_identity_id);
`);

// Translation cache
const getCache = db.prepare('SELECT * FROM translation_cache WHERE cache_key = ? AND created_at > ?');
const upsertCache = db.prepare(`
  INSERT OR REPLACE INTO translation_cache (cache_key, source_text, source_lang, target_lang, translated_text, confidence, created_at)
  VALUES (@cache_key, @source_text, @source_lang, @target_lang, @translated_text, @confidence, @created_at)
`);
const pruneCache = db.prepare('DELETE FROM translation_cache WHERE created_at < ?');

// User preferences
const getPreferences = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?');
const upsertPreferences = db.prepare(`
  INSERT OR REPLACE INTO user_preferences (user_id, windy_identity_id, preferred_language, auto_translate, updated_at)
  VALUES (@user_id, @windy_identity_id, @preferred_language, @auto_translate, @updated_at)
`);

module.exports = {
  db,
  getCache,
  upsertCache,
  pruneCache,
  getPreferences,
  upsertPreferences,
};
