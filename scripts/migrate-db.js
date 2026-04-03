#!/usr/bin/env node
/**
 * Windy Chat — SQLite Database Migration Runner
 *
 * Manages schema migrations for all 8 microservice SQLite databases.
 * Each migration is a .js file in services/<svc>/migrations/ that exports
 * an `up(db)` function receiving the better-sqlite3 instance.
 *
 * Usage:
 *   node scripts/migrate-db.js                  # Run pending migrations (all services)
 *   node scripts/migrate-db.js --service social # Run for one service
 *   node scripts/migrate-db.js --status         # Show migration status
 *   node scripts/migrate-db.js --create social add_hashtags  # Create migration file
 */

const fs = require('fs');
const path = require('path');

const SERVICES = [
  'onboarding', 'directory', 'push-gateway', 'backup',
  'social', 'translation', 'media', 'call-history',
];

const ROOT = path.join(__dirname, '..');

function getDb(service) {
  const dbModule = require(path.join(ROOT, 'services', service, 'lib', 'db'));
  return dbModule.db;
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function getApplied(db) {
  ensureMigrationsTable(db);
  return new Set(
    db.prepare('SELECT name FROM _migrations ORDER BY id').all().map(r => r.name)
  );
}

function getMigrationFiles(service) {
  const dir = path.join(ROOT, 'services', service, 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .sort();
}

function runMigrations(service) {
  const files = getMigrationFiles(service);
  if (files.length === 0) return { service, applied: 0, total: 0 };

  const db = getDb(service);
  const applied = getApplied(db);
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;

    const migration = require(path.join(ROOT, 'services', service, 'migrations', file));
    if (typeof migration.up !== 'function') {
      console.error(`  [${service}] ${file}: missing up() export, skipping`);
      continue;
    }

    try {
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      })();
      console.log(`  [${service}] Applied: ${file}`);
      count++;
    } catch (err) {
      console.error(`  [${service}] FAILED: ${file} — ${err.message}`);
      process.exitCode = 1;
      return { service, applied: count, total: files.length, error: err.message };
    }
  }

  return { service, applied: count, total: files.length };
}

function showStatus() {
  console.log('Migration Status:\n');
  for (const svc of SERVICES) {
    const files = getMigrationFiles(svc);
    if (files.length === 0) {
      console.log(`  ${svc}: no migrations directory`);
      continue;
    }
    try {
      const db = getDb(svc);
      const applied = getApplied(db);
      const pending = files.filter(f => !applied.has(f));
      console.log(`  ${svc}: ${applied.size} applied, ${pending.length} pending`);
      for (const p of pending) console.log(`    pending: ${p}`);
    } catch (err) {
      console.log(`  ${svc}: error — ${err.message}`);
    }
  }
}

function createMigration(service, name) {
  if (!SERVICES.includes(service)) {
    console.error(`Unknown service: ${service}. Choose from: ${SERVICES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const dir = path.join(ROOT, 'services', service, 'migrations');
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `${timestamp}_${name.replace(/[^a-z0-9_]/gi, '_')}.js`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, `/**
 * Migration: ${name}
 * Service: ${service}
 * Created: ${new Date().toISOString()}
 */

module.exports = {
  up(db) {
    db.exec(\`
      -- Your migration SQL here
    \`);
  },
};
`);
  console.log(`Created: services/${service}/migrations/${filename}`);
}

// ── CLI ──
const args = process.argv.slice(2);

if (args.includes('--status')) {
  showStatus();
} else if (args.includes('--create')) {
  const idx = args.indexOf('--create');
  const service = args[idx + 1];
  const name = args[idx + 2];
  if (!service || !name) {
    console.error('Usage: migrate-db.js --create <service> <name>');
    process.exitCode = 1;
  } else {
    createMigration(service, name);
  }
} else {
  const serviceFilter = args.includes('--service') ? args[args.indexOf('--service') + 1] : null;
  const targets = serviceFilter ? [serviceFilter] : SERVICES;

  console.log('Running migrations...\n');
  let totalApplied = 0;

  for (const svc of targets) {
    if (!SERVICES.includes(svc)) {
      console.error(`Unknown service: ${svc}`);
      continue;
    }
    const result = runMigrations(svc);
    totalApplied += result.applied;
  }

  console.log(`\nDone. ${totalApplied} migration(s) applied.`);
}
