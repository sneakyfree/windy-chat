/**
 * Integration Test: Identity & Passport Webhooks
 *
 * Exercises the push-side onboarding contracts:
 *   POST /api/v1/webhooks/identity/created
 *   POST /api/v1/webhooks/passport/revoked
 *
 * Uses node's built-in test runner (matches integration-pro.test.js).
 *
 * Run: node --test services/onboarding/tests/webhooks.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ─── Environment (set before requiring app) ─────────────────────────
const IDENTITY_SECRET = 'webhook-test-identity-secret';
const ETERNITAS_SECRET = 'webhook-test-eternitas-secret';

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'webhook-test-jwt-secret';
process.env.CHAT_API_TOKEN = 'webhook-test-api-token';
process.env.WINDY_IDENTITY_WEBHOOK_SECRET = IDENTITY_SECRET;
process.env.ETERNITAS_WEBHOOK_SECRET = ETERNITAS_SECRET;
process.env.SYNAPSE_REGISTRATION_SECRET = ''; // force dev-stub provisioning
process.env.SYNAPSE_URL = 'http://127.0.0.1:1'; // unreachable — deactivate returns false

// Fresh data dir so idempotency assertions don't depend on prior runs
const dataDir = path.join(__dirname, '..', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../server');
const onboardingDb = require('../lib/db');
const trustClient = require('../../shared/trust-client');

// ─── Helpers ────────────────────────────────────────────────────────
let server;
let baseUrl;

function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => server && server.close(() => resolve()));
}

function signHmac(bodyStr, secret) {
  return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

async function postJson(pathname, body, headers = {}) {
  const bodyStr = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyStr,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Webhook: identity/created', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);

  it('rejects missing signature header', async () => {
    const { status } = await postJson('/api/v1/webhooks/identity/created', {
      windy_identity_id: 'id_no_sig',
      first_name: 'A',
      last_name: 'B',
    });
    assert.equal(status, 401);
  });

  it('rejects invalid signature', async () => {
    const { status } = await postJson('/api/v1/webhooks/identity/created', {
      windy_identity_id: 'id_bad_sig',
      first_name: 'A',
      last_name: 'B',
    }, { 'x-windy-signature': 'deadbeef' });
    assert.equal(status, 401);
  });

  it('provisions a new identity and returns matrix_user_id', async () => {
    const payload = {
      windy_identity_id: 'id_webhook_grant_001',
      first_name: 'Grant',
      last_name: 'Whitmer',
      display_name: 'Grant Whitmer',
    };
    const sig = signHmac(JSON.stringify(payload), IDENTITY_SECRET);
    const { status, body } = await postJson(
      '/api/v1/webhooks/identity/created', payload, { 'x-windy-signature': sig });
    assert.equal(status, 200);
    assert.equal(body.status, 'provisioned');
    assert.equal(body.display_name, 'Grant Whitmer');
    // Mail-aligned handle — expect grant.whitmer (or collision suffix)
    assert.match(body.matrix_user_id, /^@grant\.whitmer(-[a-f0-9]+)?:chat\.windyword\.ai$/);
  });

  it('is idempotent — replay returns already_existed', async () => {
    const payload = {
      windy_identity_id: 'id_webhook_ada_001',
      first_name: 'Ada',
      last_name: 'Lovelace',
    };
    const sig = signHmac(JSON.stringify(payload), IDENTITY_SECRET);

    const first = await postJson(
      '/api/v1/webhooks/identity/created', payload, { 'x-windy-signature': sig });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'provisioned');

    const replay = await postJson(
      '/api/v1/webhooks/identity/created', payload, { 'x-windy-signature': sig });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, 'already_existed');
    assert.equal(replay.body.matrix_user_id, first.body.matrix_user_id);
  });

  it('persists onboarding state for provisioned user', async () => {
    const payload = {
      windy_identity_id: 'id_webhook_persist_001',
      first_name: 'Per',
      last_name: 'Sist',
      passport_id: 'ET-PERSIST-001',
    };
    const sig = signHmac(JSON.stringify(payload), IDENTITY_SECRET);
    const { status } = await postJson(
      '/api/v1/webhooks/identity/created', payload, { 'x-windy-signature': sig });
    assert.equal(status, 200);

    const profile = onboardingDb.getProfileByWindyId.get(payload.windy_identity_id);
    assert.ok(profile, 'profile row exists');
    const state = onboardingDb.getOnboardingState.get(profile.chat_user_id);
    assert.ok(state, 'onboarding_state row exists');
    assert.equal(state.matrix_provisioned, 1);
    assert.equal(state.passport_id, 'ET-PERSIST-001');
  });

  it('rejects missing windy_identity_id', async () => {
    const payload = { first_name: 'X' };
    const sig = signHmac(JSON.stringify(payload), IDENTITY_SECRET);
    const { status } = await postJson(
      '/api/v1/webhooks/identity/created', payload, { 'x-windy-signature': sig });
    assert.equal(status, 400);
  });
});

describe('Webhook: passport/revoked', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);

  it('rejects invalid signature', async () => {
    const { status } = await postJson('/api/v1/webhooks/passport/revoked', {
      passport: 'ET-BAD-SIG',
    }, { 'x-eternitas-signature': 'deadbeef' });
    assert.equal(status, 401);
  });

  it('returns 404 for unknown passport', async () => {
    const payload = { passport: 'ET-unknown-xyz' };
    const sig = signHmac(JSON.stringify(payload), ETERNITAS_SECRET);
    const { status } = await postJson(
      '/api/v1/webhooks/passport/revoked', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 404);
  });

  it('deactivates a provisioned passport', async () => {
    const identityPayload = {
      windy_identity_id: 'id_webhook_revoke_001',
      first_name: 'Rev',
      last_name: 'Oke',
      passport_id: 'ET-REVOKE-001',
    };
    const isig = signHmac(JSON.stringify(identityPayload), IDENTITY_SECRET);
    const prov = await postJson(
      '/api/v1/webhooks/identity/created', identityPayload, { 'x-windy-signature': isig });
    assert.equal(prov.status, 200);

    const revPayload = { passport: 'ET-REVOKE-001' };
    const rsig = signHmac(JSON.stringify(revPayload), ETERNITAS_SECRET);
    const { status, body } = await postJson(
      '/api/v1/webhooks/passport/revoked', revPayload, { 'x-eternitas-signature': rsig });
    assert.equal(status, 200);
    assert.equal(body.status, 'deactivated');
    assert.equal(body.matrix_user_id, prov.body.matrix_user_id);
  });

  it('flushes the trust cache for the revoked passport', async () => {
    // Provision first so the revoke handler finds a matrix_user_id
    const identityPayload = {
      windy_identity_id: 'id_cache_flush_001',
      first_name: 'Ca',
      last_name: 'Che',
      passport_id: 'ET-CACHE-FLUSH-001',
    };
    const isig = signHmac(JSON.stringify(identityPayload), IDENTITY_SECRET);
    const prov = await postJson(
      '/api/v1/webhooks/identity/created', identityPayload, { 'x-windy-signature': isig });
    assert.equal(prov.status, 200);

    // Seed the trust cache as if we'd looked this passport up recently.
    // Shape matches the live Trust API contract (trust-api.md).
    trustClient._setCacheForTest('ET-CACHE-FLUSH-001', {
      passport_number: 'ET-CACHE-FLUSH-001',
      status: 'active',
      band: 'exceptional',
      clearance_level: 'top_secret',
      allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages', 'commit_push', 'broadcast', 'mention_strangers'],
      denied_actions: ['bypass_rate_caps'],
      tier_multiplier: 3.0,
      integrity_score: 950,
    });
    assert.ok(
      trustClient._getCacheForTest('ET-CACHE-FLUSH-001'),
      'trust cache seeded before revoke',
    );

    const revPayload = { passport: 'ET-CACHE-FLUSH-001' };
    const rsig = signHmac(JSON.stringify(revPayload), ETERNITAS_SECRET);
    const { status, body } = await postJson(
      '/api/v1/webhooks/passport/revoked', revPayload, { 'x-eternitas-signature': rsig });
    assert.equal(status, 200);
    assert.equal(body.trust_cache_flushed, true);

    assert.equal(
      trustClient._getCacheForTest('ET-CACHE-FLUSH-001'),
      null,
      'trust cache entry removed after revoke',
    );
  });

  it('trust_cache_flushed=false when nothing was cached', async () => {
    // Provision but never touch the trust cache
    const identityPayload = {
      windy_identity_id: 'id_no_cache_001',
      first_name: 'No',
      last_name: 'Cache',
      passport_id: 'ET-NO-CACHE-001',
    };
    const isig = signHmac(JSON.stringify(identityPayload), IDENTITY_SECRET);
    const prov = await postJson(
      '/api/v1/webhooks/identity/created', identityPayload, { 'x-windy-signature': isig });
    assert.equal(prov.status, 200);

    assert.equal(trustClient._getCacheForTest('ET-NO-CACHE-001'), null);

    const revPayload = { passport: 'ET-NO-CACHE-001' };
    const rsig = signHmac(JSON.stringify(revPayload), ETERNITAS_SECRET);
    const { body } = await postJson(
      '/api/v1/webhooks/passport/revoked', revPayload, { 'x-eternitas-signature': rsig });
    assert.equal(body.trust_cache_flushed, false);
  });
});

describe('HMAC signature — accepts both prefixed and bare hex', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);

  it('accepts bare <hex> signature (legacy producers)', async () => {
    const payload = { passport: 'ET26-HMAC-BARE' };
    const sig = signHmac(JSON.stringify(payload), ETERNITAS_SECRET);
    assert.doesNotMatch(sig, /^sha256=/, 'sanity: bare hex fixture');
    const { status } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 200, `bare hex should verify, got ${status}`);
  });

  it('accepts sha256=<hex> signature (live Eternitas format)', async () => {
    const payload = { passport: 'ET26-HMAC-PREFIXED' };
    const sig = `sha256=${signHmac(JSON.stringify(payload), ETERNITAS_SECRET)}`;
    const { status } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 200, `prefixed signature should verify, got ${status}`);
  });

  it('accepts SHA256= prefix (case-insensitive)', async () => {
    const payload = { passport: 'ET26-HMAC-UPPER' };
    const sig = `SHA256=${signHmac(JSON.stringify(payload), ETERNITAS_SECRET)}`;
    const { status } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 200, `uppercase prefix should verify, got ${status}`);
  });

  it('rejects signature with wrong prefix (md5=...)', async () => {
    const payload = { passport: 'ET26-HMAC-WRONG' };
    const sig = `md5=${signHmac(JSON.stringify(payload), ETERNITAS_SECRET)}`;
    const { status } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 401);
  });

  it('rejects prefixed signature with wrong hex', async () => {
    const payload = { passport: 'ET26-HMAC-BAD' };
    const sig = `sha256=${'0'.repeat(64)}`;
    const { status } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 401);
  });
});

describe('Webhook: trust/changed', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);

  it('rejects invalid signature', async () => {
    const { status } = await postJson('/api/v1/webhooks/trust/changed', {
      passport: 'ET-ANY',
    }, { 'x-eternitas-signature': 'deadbeef' });
    assert.equal(status, 401);
  });

  it('400s on missing passport', async () => {
    const payload = {};
    const sig = signHmac(JSON.stringify(payload), ETERNITAS_SECRET);
    const { status } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 400);
  });

  it('flushes cache and returns flushed=true when entry existed', async () => {
    trustClient._setCacheForTest('ET-CHANGED-001', {
      passport_number: 'ET-CHANGED-001', status: 'active',
      band: 'good', clearance_level: 'cleared',
      allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages'],
      denied_actions: ['commit_push', 'broadcast', 'mention_strangers', 'bypass_rate_caps'],
      tier_multiplier: 1.5, integrity_score: 700,
    });
    assert.ok(trustClient._getCacheForTest('ET-CHANGED-001'));

    const payload = { passport: 'ET-CHANGED-001' };
    const sig = signHmac(JSON.stringify(payload), ETERNITAS_SECRET);
    const { status, body } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 200);
    assert.equal(body.status, 'cache_flushed');
    assert.equal(body.flushed, true);
    assert.equal(trustClient._getCacheForTest('ET-CHANGED-001'), null);
  });

  it('returns flushed=false when no cache entry exists (idempotent)', async () => {
    const payload = { passport: 'ET-NEVER-CACHED' };
    const sig = signHmac(JSON.stringify(payload), ETERNITAS_SECRET);
    const { status, body } = await postJson(
      '/api/v1/webhooks/trust/changed', payload, { 'x-eternitas-signature': sig });
    assert.equal(status, 200);
    assert.equal(body.flushed, false);
  });
});
