/**
 * Windy Chat — SQLite Migration Runner
 *
 * Simple forward-only migration runner for better-sqlite3.
 * Reads .sql files from a migrations/ directory and applies them in order.
 *
 * Usage:
 *   const Database = require('better-sqlite3');
 *   const { runMigrations } = require('windy-chat-shared/migrate');
 *   const db = new Database('./data/myservice.db');
 *   runMigrations(db, path.join(__dirname, 'migrations'));
 */

const fs = require('fs');
const path = require('path');

/**
 * Run pending SQL migrations against a better-sqlite3 database.
 *
 * Migration files are sorted by filename (e.g. 001_initial.sql, 002_add_index.sql).
 * Each migration runs inside a transaction. Applied migrations are tracked in a
 * `_migrations` table so they are never re-applied.
 *
 * @param {import('better-sqlite3').Database} db - An open better-sqlite3 instance
 * @param {string} migrationsDir - Absolute path to the directory containing .sql files
 * @returns {{ applied: string[] }} List of migration filenames that were applied this run
 */
function runMigrations(db, migrationsDir) {
  // Ensure the tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      filename  TEXT    NOT NULL UNIQUE,
      applied   TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Discover migration files
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Determine which have already been applied
  const appliedSet = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map((r) => r.filename)
  );

  const pending = files.filter((f) => !appliedSet.has(f));
  const applied = [];

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    const runOne = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    });

    runOne();
    applied.push(file);
  }

  return { applied };
}

module.exports = { runMigrations };
