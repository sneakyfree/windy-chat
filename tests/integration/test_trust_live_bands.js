/**
 * Live-Band Integration Test — against the real Eternitas at localhost:8500
 *
 * Exercises the directory gate layer end-to-end with the five seeded test
 * passports Grant provisioned for Wave 5:
 *   ET26-TEST-EXCP  (band=exceptional, status=active)
 *   ET26-TEST-GOOD  (band=good,        status=active)
 *   ET26-TEST-FAIR  (band=fair,        status=active)
 *   ET26-TEST-POOR  (band=poor,        status=active)
 *   ET26-TEST-REVD  (band=critical,    status=revoked)
 *
 * NOTE on band semantics (discovered via live probe, matches trust-api.md):
 * The first five seeds (EXCP/GOOD/FAIR/POOR/REVD) all share the same
 * ETERNAL-clearance test operator, so their Trust API projections all
 * report `clearance_level=eternal`. The Trust API derives `allowed_actions`
 * from **clearance**, and the **band** modulates `tier_multiplier`. So
 * EXCP/GOOD/FAIR/POOR all have identical `allowed_actions` — only their
 * tier_multipliers differ (5.0 / 2.0 / 1.0 / 0.5).
 *
 * That means status+band gating PASSES for all four active bands and only
 * DENIES for REVD. Which is correct per the contract — downstream rate
 * limiting is what differentiates exceptional vs. poor bots at this level.
 *
 * ET26-TEST-VERIFIED is the Wave-6 addition — it sits under a separate
 * VERIFIED-clearance operator, so its `allowed_actions = ["read","send"]`.
 * This is what exercises **clearance-based** denial (broadcast / dm_bots /
 * mention_strangers) that the top-five bots can't demonstrate.
 *
 * If Eternitas is not reachable at localhost:8500 the entire suite SKIPs.
 *
 * Run: node --test tests/integration/test_trust_live_bands.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('../../services/directory/node_modules/jsonwebtoken');

// Point at LIVE Eternitas before requiring trust-client
const LIVE_URL = process.env.ETERNITAS_URL || 'http://localhost:8500';
process.env.ETERNITAS_URL = LIVE_URL;
process.env.ETERNITAS_USE_MOCK = 'false';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'trust-live-band-jwt';
process.env.CHAT_API_TOKEN = 'trust-live-band-token';

const dataDir = path.join(__dirname, '..', '..', 'services', 'directory', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const dirApp = require('../../services/directory/server');
const trustClient = require('../../services/shared/trust-client');

const JWT_SECRET = process.env.WINDY_JWT_SECRET;
function botToken(passport) {
  return jwt.sign({ sub: `bot-${passport}`, role: 'bot', passport_id: passport }, JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
}
function humanToken() {
  return jwt.sign({ sub: 'human-001', role: 'user' }, JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
}

let server, baseUrl;
async function checkEternitasReachable() {
  try {
    const res = await fetch(`${LIVE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
function startServer() {
  return new Promise((resolve) => {
    server = dirApp.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}
function stopServer() {
  return new Promise((resolve) => server && server.close(() => resolve()));
}
async function post(pathname, body, token) {
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

describe('Live bands (real Eternitas)', { concurrency: false }, () => {
  let live = false;

  before(async () => {
    live = await checkEternitasReachable();
    if (live) await startServer();
  });
  after(async () => { if (live) await stopServer(); });

  // Clear local cache between scenarios so we get a fresh fetch each time
  // (Eternitas itself caches server-side for 5 min — that's a different
  // cache and doesn't affect correctness).
  beforeEach(() => trustClient._clearCacheForTest());

  it('directly fetches and shape-validates each seeded passport', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }

    const expected = {
      'ET26-TEST-EXCP': { status: 'active', band: 'exceptional' },
      'ET26-TEST-GOOD': { status: 'active', band: 'good' },
      'ET26-TEST-FAIR': { status: 'active', band: 'fair' },
      'ET26-TEST-POOR': { status: 'active', band: 'poor' },
      'ET26-TEST-REVD': { status: 'revoked', band: 'critical' },
    };
    for (const [passport, want] of Object.entries(expected)) {
      const profile = await trustClient.getTrustProfile(passport);
      assert.ok(profile, `null profile for ${passport}`);
      assert.equal(profile.passport_number, passport);
      assert.equal(profile.status, want.status, `${passport} status`);
      assert.equal(profile.band, want.band, `${passport} band`);
      assert.ok(Array.isArray(profile.allowed_actions));
      assert.ok(Array.isArray(profile.denied_actions));
      assert.ok(typeof profile.tier_multiplier === 'number');
    }
  });

  it('EXCP — broadcast allowed (exceptional band + top_secret clearance)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {},
      botToken('ET26-TEST-EXCP'));
    assert.equal(res.status, 200, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.allowed, true);
  });

  it('EXCP — dm_bots both sides allowed (EXCP → GOOD)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/dm',
      { recipient_passport: 'ET26-TEST-GOOD' }, botToken('ET26-TEST-EXCP'));
    assert.equal(res.status, 200, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.allowed, true);
  });

  it('EXCP — disconnected mention allowed (clearance_level=eternal)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/mention',
      { is_connected: false }, botToken('ET26-TEST-EXCP'));
    assert.equal(res.status, 200, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.allowed, true);
    // Eternitas seeded operator is ETERNAL so derived bot clearance is 'eternal'
    assert.equal(res.body.clearance_level, 'eternal');
  });

  it('GOOD — broadcast allowed (good band, top_secret clearance)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {},
      botToken('ET26-TEST-GOOD'));
    assert.equal(res.status, 200, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.allowed, true);
  });

  it('FAIR — broadcast allowed (fair band, top_secret clearance)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {},
      botToken('ET26-TEST-FAIR'));
    assert.equal(res.status, 200, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.allowed, true);
  });

  it('POOR — broadcast allowed (poor is NOT critical — actions still derived from clearance)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {},
      botToken('ET26-TEST-POOR'));
    assert.equal(res.status, 200, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.allowed, true);
    // Tier multiplier IS reduced for POOR — surface it for downstream rate limiting
    const profile = await trustClient.getTrustProfile('ET26-TEST-POOR');
    assert.equal(profile.tier_multiplier, 0.5, 'POOR tier_multiplier');
  });

  it('REVD — broadcast DENIED (status=revoked)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {},
      botToken('ET26-TEST-REVD'));
    assert.equal(res.status, 403, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'passport_not_active');
    assert.equal(res.body.status, 'revoked');
  });

  it('REVD — dm DENIED (sender side, even with any recipient)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/dm',
      { recipient_passport: 'ET26-TEST-EXCP' }, botToken('ET26-TEST-REVD'));
    assert.equal(res.status, 403);
    assert.equal(res.body.side, 'sender');
  });

  it('REVD — mention DENIED regardless of connection state', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/mention',
      { is_connected: false }, botToken('ET26-TEST-REVD'));
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'passport_not_active');
  });

  it('dm with EXCP sender but REVD recipient → denied on recipient side', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/dm',
      { recipient_passport: 'ET26-TEST-REVD' }, botToken('ET26-TEST-EXCP'));
    assert.equal(res.status, 403, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.side, 'recipient');
  });

  it('human (Pro JWT) bypasses — zero Eternitas calls', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {}, humanToken());
    assert.equal(res.status, 200);
    assert.equal(res.body.caller, 'human');
  });

  it('VERIFIED — broadcast DENIED (clearance=verified, no broadcast in allowed_actions)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const profile = await trustClient.getTrustProfile('ET26-TEST-VERIFIED');
    assert.ok(profile, 'ET26-TEST-VERIFIED not seeded — run eternitas/scripts/seed-test-passports.py');
    assert.equal(profile.clearance_level, 'verified');
    assert.deepEqual(profile.allowed_actions, ['read', 'send']);

    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {},
      botToken('ET26-TEST-VERIFIED'));
    assert.equal(res.status, 403, `body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'missing_allowed_action');
    assert.equal(res.body.required, 'broadcast');
  });

  it('VERIFIED — dm_bots DENIED on sender side (clearance too low)', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/dm',
      { recipient_passport: 'ET26-TEST-EXCP' }, botToken('ET26-TEST-VERIFIED'));
    assert.equal(res.status, 403);
    assert.equal(res.body.side, 'sender');
    assert.equal(res.body.required, 'dm_bots');
  });

  it('VERIFIED — disconnected mention DENIED with insufficient_clearance', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/mention',
      { is_connected: false }, botToken('ET26-TEST-VERIFIED'));
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'insufficient_clearance');
    assert.equal(res.body.required, 'top_secret');
    assert.equal(res.body.actual, 'verified');
  });

  it('unknown passport (never seeded) → 404 from Eternitas → passport_not_found', async (t) => {
    if (!live) { t.skip(`Eternitas unreachable at ${LIVE_URL}`); return; }
    const res = await post('/api/v1/chat/directory/agents/gate/broadcast', {},
      botToken(`ET26-NEVER-SEEN-${Date.now()}`));
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'passport_not_found');
  });
});
