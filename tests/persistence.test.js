/**
 * Persistence Tests — Verify data survives DB close/reopen
 *
 * For each service, this test:
 *   1. Writes data to the SQLite DB
 *   2. Closes the DB connection
 *   3. Reopens the DB
 *   4. Verifies the data survived
 *
 * Run: node --test tests/persistence.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../services/social/node_modules/better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Use temp directories to avoid polluting service data
const TEMP_DIR = path.join(__dirname, '.persistence-test-data');

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
}

// ── Onboarding Persistence ──

describe('Onboarding persistence', () => {
  const dbPath = path.join(TEMP_DIR, 'onboarding.db');

  it('display names and profiles survive DB close/reopen', () => {
    cleanDir(TEMP_DIR);

    // Write phase
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS display_names (
        name_lower TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        display_name TEXT NOT NULL, languages TEXT,
        avatar_url TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_profiles (
        chat_user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
        languages TEXT, primary_language TEXT NOT NULL DEFAULT 'en',
        avatar_url TEXT, created_at TEXT NOT NULL,
        onboarding_complete INTEGER DEFAULT 0
      );
    `);

    db1.prepare(`INSERT INTO display_names (name_lower, user_id, display_name, languages, avatar_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('test user', 'uid_123', 'Test User', '["en"]', null, '2024-01-01T00:00:00Z');
    db1.prepare(`INSERT INTO user_profiles (chat_user_id, display_name, languages, primary_language, avatar_url, created_at, onboarding_complete)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('uid_123', 'Test User', '["en","es"]', 'en', null, '2024-01-01T00:00:00Z', 0);

    db1.close();

    // Read phase (new connection)
    const db2 = new Database(dbPath);
    const name = db2.prepare('SELECT * FROM display_names WHERE name_lower = ?').get('test user');
    assert.ok(name, 'Display name should exist after reopen');
    assert.equal(name.user_id, 'uid_123');
    assert.equal(name.display_name, 'Test User');

    const profile = db2.prepare('SELECT * FROM user_profiles WHERE chat_user_id = ?').get('uid_123');
    assert.ok(profile, 'Profile should exist after reopen');
    assert.equal(profile.display_name, 'Test User');
    assert.deepEqual(JSON.parse(profile.languages), ['en', 'es']);

    db2.close();
    cleanDir(TEMP_DIR);
  });

  it('pairing sessions and onboarding state survive restart', () => {
    cleanDir(TEMP_DIR);

    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS pairing_sessions (
        session_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL,
        private_key BLOB, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, status TEXT DEFAULT 'pending',
        linked_account TEXT
      );
      CREATE TABLE IF NOT EXISTS onboarding_state (
        windy_user_id TEXT PRIMARY KEY, verified INTEGER DEFAULT 0,
        profile_setup INTEGER DEFAULT 0, matrix_provisioned INTEGER DEFAULT 0,
        matrix_user_id TEXT, provisioned_at TEXT
      );
    `);

    db1.prepare(`INSERT INTO pairing_sessions (session_id, pubkey, private_key, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?)`).run('sess_1', 'pubkey123', null, Date.now(), Date.now() + 120000, 'paired');
    db1.prepare(`INSERT INTO onboarding_state (windy_user_id, verified, profile_setup, matrix_provisioned, matrix_user_id, provisioned_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('windy_abc', 1, 1, 1, '@windy_abc:chat.windypro.com', '2024-01-01T00:00:00Z');

    db1.close();

    const db2 = new Database(dbPath);
    const session = db2.prepare('SELECT * FROM pairing_sessions WHERE session_id = ?').get('sess_1');
    assert.ok(session, 'Pairing session should survive restart');
    assert.equal(session.status, 'paired');

    const state = db2.prepare('SELECT * FROM onboarding_state WHERE windy_user_id = ?').get('windy_abc');
    assert.ok(state, 'Onboarding state should survive restart');
    assert.equal(state.matrix_provisioned, 1);
    assert.equal(state.matrix_user_id, '@windy_abc:chat.windypro.com');

    db2.close();
    cleanDir(TEMP_DIR);
  });
});

// ── Directory Persistence ──

describe('Directory persistence', () => {
  const dbPath = path.join(TEMP_DIR, 'directory.db');

  it('hash directory and salt survive restart', () => {
    cleanDir(TEMP_DIR);

    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS hash_directory (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        display_name TEXT NOT NULL, avatar_url TEXT,
        registered_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS salt_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        current_salt TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);

    const testHash = crypto.createHash('sha256').update('test').digest('hex');
    db1.prepare('INSERT INTO hash_directory (hash, user_id, display_name, avatar_url, registered_at) VALUES (?, ?, ?, ?, ?)')
      .run(testHash, 'user_1', 'Test User', null, Date.now());
    db1.prepare('INSERT INTO salt_config (id, current_salt, created_at) VALUES (1, ?, ?)')
      .run('abc123salt', Date.now());

    db1.close();

    const db2 = new Database(dbPath);
    const entry = db2.prepare('SELECT * FROM hash_directory WHERE hash = ?').get(testHash);
    assert.ok(entry, 'Hash entry should survive restart');
    assert.equal(entry.user_id, 'user_1');

    const salt = db2.prepare('SELECT * FROM salt_config WHERE id = 1').get();
    assert.ok(salt, 'Salt should survive restart');
    assert.equal(salt.current_salt, 'abc123salt');

    db2.close();
    cleanDir(TEMP_DIR);
  });

  it('user directory entries survive restart', () => {
    cleanDir(TEMP_DIR);

    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS user_directory (
        user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
        email TEXT, phone TEXT, languages TEXT,
        avatar_url TEXT, searchable INTEGER DEFAULT 1,
        registered_at TEXT NOT NULL
      );
    `);

    db1.prepare(`INSERT INTO user_directory (user_id, display_name, email, phone, languages, avatar_url, searchable, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('user_dir_1', 'Alice', 'alice@example.com', '+15551234567', '["en"]', null, 1, new Date().toISOString());

    db1.close();

    const db2 = new Database(dbPath);
    const user = db2.prepare('SELECT * FROM user_directory WHERE user_id = ?').get('user_dir_1');
    assert.ok(user, 'User directory entry should survive restart');
    assert.equal(user.display_name, 'Alice');
    assert.equal(user.email, 'alice@example.com');
    assert.equal(user.searchable, 1);

    db2.close();
    cleanDir(TEMP_DIR);
  });
});

// ── Push Gateway Persistence ──

describe('Push Gateway persistence', () => {
  const dbPath = path.join(TEMP_DIR, 'push-gateway.db');

  it('push tokens and mute settings survive restart', () => {
    cleanDir(TEMP_DIR);

    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        pushkey TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        platform TEXT NOT NULL, app_id TEXT,
        device_name TEXT, registered_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mute_settings (
        user_id TEXT NOT NULL, room_id TEXT NOT NULL,
        muted_until INTEGER NOT NULL, mention_override INTEGER DEFAULT 1,
        PRIMARY KEY (user_id, room_id)
      );
    `);

    db1.prepare('INSERT INTO push_tokens (pushkey, user_id, platform, app_id, device_name, registered_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('fcm-token-xyz', 'user_push_1', 'android', 'com.windypro.chat', 'Pixel 8', Date.now());
    db1.prepare('INSERT INTO mute_settings (user_id, room_id, muted_until, mention_override) VALUES (?, ?, ?, ?)')
      .run('user_push_1', '!room:chat.windypro.com', Date.now() + 3600000, 1);

    db1.close();

    const db2 = new Database(dbPath);
    const token = db2.prepare('SELECT * FROM push_tokens WHERE pushkey = ?').get('fcm-token-xyz');
    assert.ok(token, 'Push token should survive restart');
    assert.equal(token.user_id, 'user_push_1');
    assert.equal(token.platform, 'android');

    const mute = db2.prepare('SELECT * FROM mute_settings WHERE user_id = ? AND room_id = ?')
      .get('user_push_1', '!room:chat.windypro.com');
    assert.ok(mute, 'Mute setting should survive restart');
    assert.equal(mute.mention_override, 1);

    db2.close();
    cleanDir(TEMP_DIR);
  });
});

// ── Backup Persistence ──

describe('Backup persistence', () => {
  const dbPath = path.join(TEMP_DIR, 'backup.db');

  it('backup registry entries survive restart', () => {
    cleanDir(TEMP_DIR);

    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS backup_registry (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        timestamp TEXT NOT NULL, size INTEGER NOT NULL,
        path TEXT NOT NULL, metadata TEXT DEFAULT '{}'
      );
    `);

    db1.prepare('INSERT INTO backup_registry (id, user_id, timestamp, size, path, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run('backup_1', 'user_bk_1', '2024-01-01T00:00:00Z', 1024, 'backups/user_bk_1/2024-01-01.enc', '{"messageCount":42}');
    db1.prepare('INSERT INTO backup_registry (id, user_id, timestamp, size, path, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run('backup_2', 'user_bk_1', '2024-01-02T00:00:00Z', 2048, 'backups/user_bk_1/2024-01-02.enc', '{}');

    db1.close();

    const db2 = new Database(dbPath);
    const backups = db2.prepare('SELECT * FROM backup_registry WHERE user_id = ? ORDER BY timestamp DESC').all('user_bk_1');
    assert.equal(backups.length, 2, 'Both backups should survive restart');
    assert.equal(backups[0].id, 'backup_2');
    assert.equal(backups[0].size, 2048);
    assert.deepEqual(JSON.parse(backups[1].metadata), { messageCount: 42 });

    db2.close();
    cleanDir(TEMP_DIR);
  });
});

// ── Social Persistence ──

describe('Social persistence', () => {
  const dbPath = path.join(TEMP_DIR, 'social.db');

  it('posts, follows, likes, notifications, and verified accounts survive restart', () => {
    cleanDir(TEMP_DIR);

    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        content TEXT NOT NULL, translated_versions TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        like_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS follows (
        follower_id TEXT NOT NULL, followed_id TEXT NOT NULL,
        PRIMARY KEY (follower_id, followed_id)
      );
      CREATE TABLE IF NOT EXISTS likes (
        user_id TEXT NOT NULL, post_id TEXT NOT NULL,
        PRIMARY KEY (user_id, post_id)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        type TEXT NOT NULL, from_user_id TEXT NOT NULL,
        post_id TEXT, read INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verified_accounts (
        user_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, post_id TEXT NOT NULL,
        post_author_id TEXT NOT NULL, reported_by TEXT NOT NULL,
        reason TEXT NOT NULL, description TEXT,
        status TEXT DEFAULT 'pending', created_at TEXT NOT NULL
      );
    `);

    const now = new Date().toISOString();

    // Insert data
    db1.prepare('INSERT INTO posts (id, user_id, content, translated_versions, created_at, updated_at, like_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('post_1', 'alice', 'Hello world', '{"es":"Hola mundo"}', now, now, 1);
    db1.prepare('INSERT INTO follows (follower_id, followed_id) VALUES (?, ?)').run('alice', 'bob');
    db1.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run('bob', 'post_1');
    db1.prepare('INSERT INTO notifications (id, user_id, type, from_user_id, post_id, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('notif_1', 'alice', 'like', 'bob', 'post_1', 0, now);
    db1.prepare('INSERT INTO verified_accounts (user_id) VALUES (?)').run('alice');
    db1.prepare('INSERT INTO reports (id, post_id, post_author_id, reported_by, reason, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('report_1', 'post_1', 'alice', 'charlie', 'spam', 'looks spammy', 'pending', now);

    db1.close();

    // Verify after reopen
    const db2 = new Database(dbPath);

    const post = db2.prepare('SELECT * FROM posts WHERE id = ?').get('post_1');
    assert.ok(post, 'Post should survive restart');
    assert.equal(post.content, 'Hello world');
    assert.deepEqual(JSON.parse(post.translated_versions), { es: 'Hola mundo' });

    const follows = db2.prepare('SELECT * FROM follows WHERE follower_id = ?').all('alice');
    assert.equal(follows.length, 1);
    assert.equal(follows[0].followed_id, 'bob');

    const likes = db2.prepare('SELECT * FROM likes WHERE post_id = ?').all('post_1');
    assert.equal(likes.length, 1);
    assert.equal(likes[0].user_id, 'bob');

    const notif = db2.prepare('SELECT * FROM notifications WHERE id = ?').get('notif_1');
    assert.ok(notif, 'Notification should survive restart');
    assert.equal(notif.type, 'like');
    assert.equal(notif.read, 0);

    const verified = db2.prepare('SELECT * FROM verified_accounts WHERE user_id = ?').get('alice');
    assert.ok(verified, 'Verified account should survive restart');

    const report = db2.prepare('SELECT * FROM reports WHERE id = ?').get('report_1');
    assert.ok(report, 'Report should survive restart');
    assert.equal(report.reason, 'spam');

    db2.close();
    cleanDir(TEMP_DIR);
  });
});
