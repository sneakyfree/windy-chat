/**
 * Backup Service — SQLite persistence layer
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'backup.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS backup_registry (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  windy_identity_id TEXT,
  timestamp TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_backup_registry_windy_identity_id ON backup_registry(windy_identity_id);
CREATE INDEX IF NOT EXISTS idx_backup_registry_user_id ON backup_registry(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_registry_user_timestamp ON backup_registry(user_id, timestamp DESC);
`);

// Prepared statements
const getUserBackups = db.prepare('SELECT * FROM backup_registry WHERE user_id = ? ORDER BY timestamp DESC');
const getBackup = db.prepare('SELECT * FROM backup_registry WHERE user_id = ? AND id = ?');
const insertBackup = db.prepare(`
  INSERT INTO backup_registry (id, user_id, windy_identity_id, timestamp, size, path, metadata)
  VALUES (@id, @user_id, @windy_identity_id, @timestamp, @size, @path, @metadata)
`);
const deleteBackup = db.prepare('DELETE FROM backup_registry WHERE user_id = ? AND id = ?');
const countUserBackups = db.prepare('SELECT COUNT(*) as cnt FROM backup_registry WHERE user_id = ?');
const getOldestBackups = db.prepare('SELECT * FROM backup_registry WHERE user_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET ?');
const deleteOldBackups = db.prepare('DELETE FROM backup_registry WHERE user_id = ? AND id IN (SELECT id FROM backup_registry WHERE user_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET ?)');
const countDistinctUsers = db.prepare('SELECT COUNT(DISTINCT user_id) as cnt FROM backup_registry');

// JSON migration
function migrateFromJson() {
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM backup_registry').get().cnt;
  if (cnt > 0) return;

  const jsonFile = path.join(DATA_DIR, 'backup-registry.json');
  if (!fs.existsSync(jsonFile)) return;

  try {
    const raw = fs.readFileSync(jsonFile, 'utf-8');
    const data = JSON.parse(raw);

    if (data.registry) {
      const migrate = db.transaction(() => {
        for (const [userId, backups] of Object.entries(data.registry)) {
          for (const b of backups) {
            insertBackup.run({
              id: b.id,
              user_id: userId,
              windy_identity_id: b.windy_identity_id || null,
              timestamp: b.timestamp,
              size: b.size,
              path: b.path,
              metadata: JSON.stringify(b.metadata || {}),
            });
          }
        }
      });
      migrate();
      console.log('[Backup] Migrated data from backup-registry.json to SQLite');
    }
  } catch (err) {
    console.error('[Backup] JSON migration failed:', err.message);
  }
}

migrateFromJson();

function rowToBackup(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    size: row.size,
    path: row.path,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

module.exports = {
  db,
  getUserBackups,
  getBackup,
  insertBackup,
  deleteBackup,
  countUserBackups,
  getOldestBackups,
  deleteOldBackups,
  countDistinctUsers,
  rowToBackup,
};
