/**
 * Localpart unification tests — services/shared/localpart.js
 *
 * Covers the fresh-design (kit-army-config/docs/windy-chat-localpart-fresh-design-2026-05-17.md)
 * Option A guarantees:
 *   1. First-writer-wins (race-safe): same windyIdentityId always returns
 *      the same chat_user_id regardless of which path fires first.
 *   2. Mail-aligned for new users (preserves Mail ↔ Chat handle parity).
 *   3. Hardened fallback regex (no double-dots from pathological displayNames).
 *   4. Idempotency on repeat calls.
 *
 * Uses an in-memory better-sqlite3 DB to avoid touching real onboarding state.
 */

const Database = require('better-sqlite3');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveLocalpartForWindyId,
  mailAlignedLocalpart,
  resolveUniqueLocalpart,
} = require('../../shared/localpart');

function makeFreshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_profiles (
      chat_user_id TEXT PRIMARY KEY,
      windy_identity_id TEXT,
      display_name TEXT NOT NULL,
      languages TEXT,
      primary_language TEXT NOT NULL DEFAULT 'en',
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      onboarding_complete INTEGER DEFAULT 0
    );
    CREATE INDEX idx_user_profiles_windy_identity_id ON user_profiles(windy_identity_id);
  `);
  return db;
}

function insertProfile(db, { chat_user_id, windy_identity_id, display_name = 'x' }) {
  db.prepare(`
    INSERT INTO user_profiles (chat_user_id, windy_identity_id, display_name, created_at)
    VALUES (?, ?, ?, ?)
  `).run(chat_user_id, windy_identity_id, display_name, new Date().toISOString());
}

// ─── mailAlignedLocalpart unit tests ──────────────────────────────

test('mailAlignedLocalpart: firstName + lastName preferred', () => {
  assert.equal(
    mailAlignedLocalpart({ firstName: 'Grant', lastName: 'Whitmer' }),
    'grant.whitmer'
  );
});

test('mailAlignedLocalpart: username when no first/last', () => {
  assert.equal(
    mailAlignedLocalpart({ username: 'gwhitmer' }),
    'gwhitmer'
  );
});

test('mailAlignedLocalpart: email local-part fallback', () => {
  assert.equal(
    mailAlignedLocalpart({ email: 'grant.whitmer@example.com' }),
    'grant.whitmer'
  );
});

test('mailAlignedLocalpart: displayName fallback', () => {
  assert.equal(
    mailAlignedLocalpart({ displayName: 'Grant Whitmer' }),
    'grant.whitmer'
  );
});

test('mailAlignedLocalpart: hardened against double dots (J. middle initial)', () => {
  // Pathological case the original webhooks.js inline version produced
  // 'grant.j..whitmer'. The hardened shared version collapses to single dot.
  assert.equal(
    mailAlignedLocalpart({ displayName: 'Grant J. Whitmer' }),
    'grant.j.whitmer'
  );
});

test('mailAlignedLocalpart: strips leading/trailing dots', () => {
  assert.equal(
    mailAlignedLocalpart({ displayName: '.Grant.' }),
    'grant'
  );
});

test('mailAlignedLocalpart: random fallback when nothing usable', () => {
  const result = mailAlignedLocalpart({});
  assert.match(result, /^user-[0-9a-f]{6}$/);
});

test('mailAlignedLocalpart: random fallback when only non-alphanumeric', () => {
  const result = mailAlignedLocalpart({ displayName: '!@#$%' });
  assert.match(result, /^user-[0-9a-f]{6}$/);
});

test('mailAlignedLocalpart: lowercase + Matrix-safe charset', () => {
  assert.equal(
    mailAlignedLocalpart({ firstName: 'Grant', lastName: 'O\'Whitmer' }),
    'grant.owhitmer'
  );
});

test('mailAlignedLocalpart: max length 32', () => {
  const result = mailAlignedLocalpart({
    firstName: 'Verylongfirstnamefortest',
    lastName: 'Equallylonglastnameforfun',
  });
  assert.ok(result.length <= 32);
});

// ─── resolveUniqueLocalpart unit tests ────────────────────────────

test('resolveUniqueLocalpart: base returned when not taken', () => {
  const db = makeFreshDb();
  assert.equal(resolveUniqueLocalpart(db, 'grant.whitmer'), 'grant.whitmer');
});

test('resolveUniqueLocalpart: suffix appended on collision', () => {
  const db = makeFreshDb();
  insertProfile(db, { chat_user_id: 'grant.whitmer', windy_identity_id: 'OTHER_USER' });
  const result = resolveUniqueLocalpart(db, 'grant.whitmer');
  assert.match(result, /^grant\.whitmer-[0-9a-f]{4}$/);
});

// ─── deriveLocalpartForWindyId — the unified entry point ──────────

test('deriveLocalpartForWindyId: returns existing chat_user_id when windyId already provisioned', () => {
  const db = makeFreshDb();
  insertProfile(db, {
    chat_user_id: 'windy_grant_whitmer',  // legacy-prefix user
    windy_identity_id: 'windyid-123',
  });
  const result = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-123',
    displayName: 'Grant Whitmer',  // displayName fresh-derive would give 'grant.whitmer'
  });
  assert.equal(result.chatUserId, 'windy_grant_whitmer', 'must return existing legacy handle');
  assert.equal(result.existing, true);
});

test('deriveLocalpartForWindyId: race scenario — same windyId from BOTH paths yields same handle', () => {
  const db = makeFreshDb();

  // Path A — webhook fires first, derives mail-aligned, inserts.
  const fromWebhook = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-race-test',
    firstName: 'Grant',
    lastName: 'Whitmer',
  });
  // Simulate the webhook's downstream insert
  insertProfile(db, {
    chat_user_id: fromWebhook.chatUserId,
    windy_identity_id: 'windyid-race-test',
  });

  // Path B — /provision fires later with only displayName.
  const fromProvision = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-race-test',
    displayName: 'Grant Whitmer',
  });

  assert.equal(fromProvision.chatUserId, fromWebhook.chatUserId);
  assert.equal(fromProvision.existing, true);
  assert.equal(fromWebhook.existing, false);
});

test('deriveLocalpartForWindyId: NEW user gets mail-aligned (not legacy) handle', () => {
  const db = makeFreshDb();
  const result = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-new',
    firstName: 'Grant',
    lastName: 'Whitmer',
  });
  assert.equal(result.chatUserId, 'grant.whitmer');
  assert.equal(result.existing, false);
  assert.ok(!result.chatUserId.startsWith('windy_'), 'should not have legacy windy_ prefix');
});

test('deriveLocalpartForWindyId: NEW user with displayName-only gets mail-aligned fallback', () => {
  const db = makeFreshDb();
  const result = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-displayname',
    displayName: 'Grant Whitmer',
  });
  assert.equal(result.chatUserId, 'grant.whitmer');
});

test('deriveLocalpartForWindyId: throws on missing db', () => {
  assert.throws(
    () => deriveLocalpartForWindyId({ windyIdentityId: 'x', displayName: 'y' }),
    /db is required/
  );
});

test('deriveLocalpartForWindyId: throws on missing windyIdentityId', () => {
  const db = makeFreshDb();
  assert.throws(
    () => deriveLocalpartForWindyId({ db, displayName: 'y' }),
    /windyIdentityId is required/
  );
});

test('deriveLocalpartForWindyId: idempotent on repeated calls', () => {
  const db = makeFreshDb();
  // First call (new user): inserts via downstream path
  const first = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-idempotent',
    displayName: 'Grant Whitmer',
  });
  insertProfile(db, {
    chat_user_id: first.chatUserId,
    windy_identity_id: 'windyid-idempotent',
  });

  // Subsequent calls: all return same chat_user_id
  for (let i = 0; i < 5; i++) {
    const next = deriveLocalpartForWindyId({
      db,
      windyIdentityId: 'windyid-idempotent',
      displayName: 'Grant Whitmer',
    });
    assert.equal(next.chatUserId, first.chatUserId);
    assert.equal(next.existing, true);
  }
});

test('deriveLocalpartForWindyId: different users with same display name get suffix-disambiguated', () => {
  const db = makeFreshDb();
  // First Grant Whitmer
  const first = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-grant-1',
    displayName: 'Grant Whitmer',
  });
  insertProfile(db, {
    chat_user_id: first.chatUserId,
    windy_identity_id: 'windyid-grant-1',
  });

  // Second Grant Whitmer (different windy_identity_id)
  const second = deriveLocalpartForWindyId({
    db,
    windyIdentityId: 'windyid-grant-2',
    displayName: 'Grant Whitmer',
  });

  assert.notEqual(first.chatUserId, second.chatUserId);
  assert.equal(first.chatUserId, 'grant.whitmer');
  assert.match(second.chatUserId, /^grant\.whitmer-[0-9a-f]{4}$/);
});
