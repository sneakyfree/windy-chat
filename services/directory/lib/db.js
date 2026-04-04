/**
 * Directory Service — SQLite persistence layer
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'directory.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS hash_directory (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  registered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hash_directory_user_id ON hash_directory(user_id);

CREATE TABLE IF NOT EXISTS salt_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  current_salt TEXT NOT NULL,
  previous_salt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_directory (
  user_id TEXT PRIMARY KEY,
  windy_identity_id TEXT,
  display_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  languages TEXT,
  avatar_url TEXT,
  searchable INTEGER DEFAULT 1,
  registered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_directory_windy_identity_id ON user_directory(windy_identity_id);
CREATE INDEX IF NOT EXISTS idx_user_directory_email ON user_directory(email);
CREATE INDEX IF NOT EXISTS idx_user_directory_display_name ON user_directory(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_user_directory_searchable ON user_directory(searchable);

CREATE TABLE IF NOT EXISTS invite_tracker (
  user_id TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  reset_at INTEGER NOT NULL
);
`);

// Migrate: add previous_salt column if missing (for existing databases)
try {
  db.exec('ALTER TABLE salt_config ADD COLUMN previous_salt TEXT');
} catch (_e) {
  // Column already exists — ignore
}

// Hash directory
const getHash = db.prepare('SELECT * FROM hash_directory WHERE hash = ?');
const upsertHash = db.prepare(`
  INSERT OR REPLACE INTO hash_directory (hash, user_id, display_name, avatar_url, registered_at)
  VALUES (@hash, @user_id, @display_name, @avatar_url, @registered_at)
`);
const hashCount = db.prepare('SELECT COUNT(*) as cnt FROM hash_directory');

// Salt
const getSalt = db.prepare('SELECT * FROM salt_config WHERE id = 1');
const upsertSalt = db.prepare(`
  INSERT OR REPLACE INTO salt_config (id, current_salt, previous_salt, created_at) VALUES (1, ?, ?, ?)
`);

// User directory
const getUser = db.prepare('SELECT * FROM user_directory WHERE user_id = ?');
const upsertUser = db.prepare(`
  INSERT OR REPLACE INTO user_directory (user_id, windy_identity_id, display_name, email, phone, languages, avatar_url, searchable, registered_at)
  VALUES (@user_id, @windy_identity_id, @display_name, @email, @phone, @languages, @avatar_url, @searchable, @registered_at)
`);
const searchableUsers = db.prepare('SELECT * FROM user_directory WHERE searchable = 1');

// Invite tracker
const getInviteTracker = db.prepare('SELECT * FROM invite_tracker WHERE user_id = ?');
const upsertInviteTracker = db.prepare(`
  INSERT OR REPLACE INTO invite_tracker (user_id, count, reset_at) VALUES (?, ?, ?)
`);

// ── Blocked Users ──────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker ON blocked_users(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users(blocked_id);
`);

const blockUser = db.prepare(`
  INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id, created_at)
  VALUES (?, ?, ?)
`);
const unblockUser = db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?');
const isBlocked = db.prepare('SELECT 1 FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?');
const getBlockedList = db.prepare('SELECT blocked_id, created_at FROM blocked_users WHERE blocker_id = ? ORDER BY created_at DESC');

module.exports = {
  db,
  getHash,
  upsertHash,
  hashCount,
  getSalt,
  upsertSalt,
  getUser,
  upsertUser,
  searchableUsers,
  getInviteTracker,
  upsertInviteTracker,
  blockUser,
  unblockUser,
  isBlocked,
  getBlockedList,
};
