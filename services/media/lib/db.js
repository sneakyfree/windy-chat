/**
 * Media Service — SQLite persistence layer
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'media.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  windy_identity_id TEXT,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  thumbnail_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_user_id ON media(user_id);
CREATE INDEX IF NOT EXISTS idx_media_created_at ON media(created_at DESC);
`);

const getMedia = db.prepare('SELECT * FROM media WHERE id = ?');
const insertMedia = db.prepare(`
  INSERT INTO media (id, user_id, windy_identity_id, original_name, mime_type, size, file_path, thumbnail_path, created_at)
  VALUES (@id, @user_id, @windy_identity_id, @original_name, @mime_type, @size, @file_path, @thumbnail_path, @created_at)
`);
const getUserMedia = db.prepare('SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');

module.exports = {
  db,
  getMedia,
  insertMedia,
  getUserMedia,
};
