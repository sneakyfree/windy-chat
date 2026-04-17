/**
 * Integration Test: Directory Trust Gates (live-contract fixtures)
 *
 * Exercises the three Wave 3 gates against the Eternitas Trust API
 * contract as documented in
 * /Users/thewindstorm/eternitas/docs/trust-api.md.
 *
 *   POST /api/v1/chat/directory/agents/gate/dm
 *   POST /api/v1/chat/directory/agents/gate/broadcast
 *   POST /api/v1/chat/directory/agents/gate/mention
 *
 * Run: node --test services/directory/tests/trust-gates.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'trust-gate-test-secret';
process.env.CHAT_API_TOKEN = 'trust-gate-static-token';
process.env.ETERNITAS_USE_MOCK = 'false'; // exercise live cache seeding

const dataDir = path.join(__dirname, '..', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const app = require('../server');
const trustClient = require('../../shared/trust-client');

const JWT_SECRET = process.env.WINDY_JWT_SECRET;

function humanToken() {
  // Pro JWT for a human — no passport_id claim
  return jwt.sign({ sub: 'user-001', role: 'user' }, JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
}
function botToken(passport) {
  return jwt.sign({ sub: `bot-${passport}`, role: 'bot', passport_id: passport }, JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
}

// Helper to build a valid Trust API profile — every field from the live
// contract, callers override whatever they need.
function profile(overrides = {}) {
  return {
    passport_number: overrides.passport_number || 'ET26-TEST-0001',
    status: 'active',
    integrity_score: 820,
    dimensions: { honesty: 900, reliability: 850, compliance: 800, safety: 780, reputation: 820 },
    band: 'good',
    clearance_level: 'cleared',
    tier_multiplier: 1.5,
    allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages'],
    denied_actions: ['commit_push', 'broadcast', 'mention_strangers', 'bypass_rate_caps'],
    cache_ttl_seconds: 300,
    evaluated_at: new Date().toISOString(),
    ...overrides,
  };
}

let server;
let baseUrl;
function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}
function stopServer() {
  return new Promise((resolve) => server && server.close(() => resolve()));
}

async function postJson(pathname, body, token) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

describe('Trust Gates', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);
  beforeEach(() => trustClient._clearCacheForTest());

  // ── DM gate ──────────────────────────────────────────────────

  describe('gate/dm', () => {
    it('humans bypass', async () => {
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/dm',
        { recipient_passport: 'ET26-ANY' },
        humanToken(),
      );
      assert.equal(status, 200);
      assert.equal(body.allowed, true);
      assert.equal(body.caller, 'human');
    });

    it('allows bot→bot when both sides have dm_bots', async () => {
      trustClient._setCacheForTest('ET26-SENDER', profile({ passport_number: 'ET26-SENDER' }));
      trustClient._setCacheForTest('ET26-RECIPIENT', profile({ passport_number: 'ET26-RECIPIENT' }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/dm',
        { recipient_passport: 'ET26-RECIPIENT' },
        botToken('ET26-SENDER'),
      );
      assert.equal(status, 200);
      assert.equal(body.allowed, true);
    });

    it('denies when sender lacks dm_bots', async () => {
      trustClient._setCacheForTest('ET26-SENDER-NODM', profile({
        passport_number: 'ET26-SENDER-NODM',
        clearance_level: 'verified',
        allowed_actions: ['read', 'send'],
      }));
      trustClient._setCacheForTest('ET26-RECIPIENT', profile({ passport_number: 'ET26-RECIPIENT' }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/dm',
        { recipient_passport: 'ET26-RECIPIENT' },
        botToken('ET26-SENDER-NODM'),
      );
      assert.equal(status, 403);
      assert.equal(body.side, 'sender');
      assert.equal(body.required, 'dm_bots');
    });

    it('denies when recipient lacks dm_bots', async () => {
      trustClient._setCacheForTest('ET26-SENDER-OK', profile({ passport_number: 'ET26-SENDER-OK' }));
      trustClient._setCacheForTest('ET26-RECIP-NODM', profile({
        passport_number: 'ET26-RECIP-NODM',
        clearance_level: 'verified',
        allowed_actions: ['read', 'send'],
      }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/dm',
        { recipient_passport: 'ET26-RECIP-NODM' },
        botToken('ET26-SENDER-OK'),
      );
      assert.equal(status, 403);
      assert.equal(body.side, 'recipient');
    });

    it('denies suspended sender even with dm_bots allowed', async () => {
      trustClient._setCacheForTest('ET26-SUSPENDED', profile({
        passport_number: 'ET26-SUSPENDED',
        status: 'suspended',
        allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages'],
      }));
      trustClient._setCacheForTest('ET26-RECIPIENT', profile({ passport_number: 'ET26-RECIPIENT' }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/dm',
        { recipient_passport: 'ET26-RECIPIENT' },
        botToken('ET26-SUSPENDED'),
      );
      assert.equal(status, 403);
      assert.equal(body.reason, 'passport_not_active');
      assert.equal(body.status, 'suspended');
    });

    it('denies critical-band sender even with status=active', async () => {
      trustClient._setCacheForTest('ET26-CRITICAL', profile({
        passport_number: 'ET26-CRITICAL',
        status: 'active',
        band: 'critical',
        allowed_actions: [],
      }));
      trustClient._setCacheForTest('ET26-RECIPIENT', profile({ passport_number: 'ET26-RECIPIENT' }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/dm',
        { recipient_passport: 'ET26-RECIPIENT' },
        botToken('ET26-CRITICAL'),
      );
      assert.equal(status, 403);
      assert.equal(body.band, 'critical');
    });

    it('400s on missing recipient_passport', async () => {
      trustClient._setCacheForTest('ET26-SENDER-OK', profile({ passport_number: 'ET26-SENDER-OK' }));
      const { status } = await postJson(
        '/api/v1/chat/directory/agents/gate/dm',
        {},
        botToken('ET26-SENDER-OK'),
      );
      assert.equal(status, 400);
    });
  });

  // ── Broadcast gate ───────────────────────────────────────────

  describe('gate/broadcast', () => {
    it('humans bypass', async () => {
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/broadcast', {}, humanToken());
      assert.equal(status, 200);
      assert.equal(body.allowed, true);
    });

    it('allows bot with broadcast', async () => {
      trustClient._setCacheForTest('ET26-BROADCASTER', profile({
        passport_number: 'ET26-BROADCASTER',
        clearance_level: 'top_secret',
        allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages', 'commit_push', 'broadcast', 'mention_strangers'],
      }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/broadcast',
        {},
        botToken('ET26-BROADCASTER'),
      );
      assert.equal(status, 200);
      assert.equal(body.allowed, true);
    });

    it('denies bot without broadcast', async () => {
      trustClient._setCacheForTest('ET26-QUIET-BOT', profile({ passport_number: 'ET26-QUIET-BOT' }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/broadcast',
        {},
        botToken('ET26-QUIET-BOT'),
      );
      assert.equal(status, 403);
      assert.equal(body.required, 'broadcast');
    });
  });

  // ── Mention gate ─────────────────────────────────────────────

  describe('gate/mention', () => {
    it('humans bypass', async () => {
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/mention',
        { is_connected: false },
        humanToken(),
      );
      assert.equal(status, 200);
      assert.equal(body.allowed, true);
    });

    it('connected mentions pass automatically', async () => {
      trustClient._setCacheForTest('ET26-LOW-CLEARANCE', profile({
        passport_number: 'ET26-LOW-CLEARANCE',
        clearance_level: 'verified',
      }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/mention',
        { target_matrix_id: '@grant.whitmer:chat.windyword.ai', is_connected: true },
        botToken('ET26-LOW-CLEARANCE'),
      );
      assert.equal(status, 200);
      assert.equal(body.reason, 'already_connected');
    });

    it('disconnected mention allowed when clearance = top_secret', async () => {
      trustClient._setCacheForTest('ET26-TOP', profile({
        passport_number: 'ET26-TOP',
        clearance_level: 'top_secret',
      }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/mention',
        { is_connected: false },
        botToken('ET26-TOP'),
      );
      assert.equal(status, 200);
      assert.equal(body.allowed, true);
      assert.equal(body.clearance_level, 'top_secret');
    });

    it('disconnected mention allowed when clearance = eternal', async () => {
      trustClient._setCacheForTest('ET26-ETERNAL', profile({
        passport_number: 'ET26-ETERNAL',
        clearance_level: 'eternal',
      }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/mention',
        { is_connected: false },
        botToken('ET26-ETERNAL'),
      );
      assert.equal(status, 200);
      assert.equal(body.clearance_level, 'eternal');
    });

    it('disconnected mention denied when clearance = cleared', async () => {
      trustClient._setCacheForTest('ET26-CLEARED', profile({
        passport_number: 'ET26-CLEARED',
        clearance_level: 'cleared',
      }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/mention',
        { is_connected: false },
        botToken('ET26-CLEARED'),
      );
      assert.equal(status, 403);
      assert.equal(body.reason, 'insufficient_clearance');
      assert.equal(body.required, 'top_secret');
      assert.equal(body.actual, 'cleared');
    });

    it('suspended passport denied regardless of clearance', async () => {
      trustClient._setCacheForTest('ET26-SUSP-TOP', profile({
        passport_number: 'ET26-SUSP-TOP',
        status: 'suspended',
        clearance_level: 'eternal',
      }));
      const { status, body } = await postJson(
        '/api/v1/chat/directory/agents/gate/mention',
        { is_connected: false },
        botToken('ET26-SUSP-TOP'),
      );
      assert.equal(status, 403);
      assert.equal(body.reason, 'passport_not_active');
    });

    it('400s on missing is_connected', async () => {
      trustClient._setCacheForTest('ET26-ANY', profile({ passport_number: 'ET26-ANY', clearance_level: 'top_secret' }));
      const { status } = await postJson(
        '/api/v1/chat/directory/agents/gate/mention',
        {},
        botToken('ET26-ANY'),
      );
      assert.equal(status, 400);
    });
  });
});
