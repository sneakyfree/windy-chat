/**
 * Live Integration Test — Eternitas Trust API
 *
 * Proves the Chat → Trust API round trip against a real HTTP endpoint
 * emitting responses in the exact shape documented in
 * /Users/thewindstorm/eternitas/docs/trust-api.md.
 *
 * Structure:
 *   1. Live-probe: if a real Eternitas is reachable at ETERNITAS_URL
 *      (default http://localhost:8500), probe the 404 contract so we know
 *      the *actual* service behaves as documented.
 *   2. Scenario round-trip: a local stand-in HTTP server emits canonical
 *      contract responses for each required scenario. Trust client, gates,
 *      and webhook invalidation are exercised over real HTTP — no function
 *      mocks, only a scripted upstream.
 *
 * Required scenarios (per Wave 4 spec):
 *   - exceptional bot   → broadcast + mention + dm all pass, top multiplier
 *   - critical bot      → every gate denies regardless of actions
 *   - suspended passport → cache flushes on passport.revoked webhook
 *   - revoked passport   → cache flushes on passport.revoked webhook
 *   - human (no passport) → trust call skipped entirely
 *
 * Run: node --test tests/integration/test_trust_live.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// jsonwebtoken is a per-service dep (not installed at repo root). Grab
// whichever copy the directory service has.
const jwt = require('../../services/directory/node_modules/jsonwebtoken');

// ═════════════════════════════════════════════════════════════════════
// Stand-in Eternitas — HTTP server emitting trust-api.md contract shapes
// ═════════════════════════════════════════════════════════════════════

const standinProfiles = new Map();

function seed(passport, profile) {
  standinProfiles.set(passport, {
    passport_number: passport,
    status: 'active',
    integrity_score: 800,
    dimensions: { honesty: 900, reliability: 850, compliance: 800, safety: 780, reputation: 820 },
    band: 'good',
    clearance_level: 'cleared',
    tier_multiplier: 1.5,
    allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages'],
    denied_actions: ['commit_push', 'broadcast', 'mention_strangers', 'bypass_rate_caps'],
    cache_ttl_seconds: 300,
    evaluated_at: new Date().toISOString(),
    ...profile,
  });
}

let standinServer;
let standinPort;
let standinHits = []; // records every GET for assertion purposes

function startStandin() {
  return new Promise((resolve) => {
    standinServer = http.createServer((req, res) => {
      const match = req.url.match(/^\/api\/v1\/trust\/([^/?]+)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not found' }));
        return;
      }
      const passport = decodeURIComponent(match[1]);
      standinHits.push(passport);
      if (!passport.startsWith('ET') && !passport.startsWith('EH')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Passport must start with ET or EH' }));
        return;
      }
      const profile = standinProfiles.get(passport);
      if (!profile) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Passport not found' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'X-Trust-Cache': 'miss',
      });
      res.end(JSON.stringify(profile));
    });
    standinServer.listen(0, '127.0.0.1', () => {
      standinPort = standinServer.address().port;
      process.env.ETERNITAS_URL = `http://127.0.0.1:${standinPort}`;
      process.env.ETERNITAS_USE_MOCK = 'false';
      resolve();
    });
  });
}
function stopStandin() {
  if (standinServer && typeof standinServer.closeAllConnections === 'function') {
    standinServer.closeAllConnections();
  }
  return new Promise((resolve) => standinServer && standinServer.close(() => resolve()));
}

// ═════════════════════════════════════════════════════════════════════
// Directory + onboarding app wiring
// ═════════════════════════════════════════════════════════════════════

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'trust-live-jwt-secret';
process.env.CHAT_API_TOKEN = 'trust-live-api-token';
process.env.WINDY_IDENTITY_WEBHOOK_SECRET = 'trust-live-identity-secret';
process.env.ETERNITAS_WEBHOOK_SECRET = 'trust-live-eternitas-secret';

// Clean per-service data dirs so idempotency keys don't leak between runs
for (const svc of ['directory', 'onboarding']) {
  const dd = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(dd, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dd, { recursive: true });
}

const dirApp = require('../../services/directory/server');
const { app: onbApp } = require('../../services/onboarding/server');
const trustClient = require('../../services/shared/trust-client');

const JWT_SECRET = process.env.WINDY_JWT_SECRET;

function humanToken() {
  return jwt.sign({ sub: 'human-001', role: 'user' }, JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
}
function botToken(passport) {
  return jwt.sign({ sub: `bot-${passport}`, role: 'bot', passport_id: passport }, JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
}

let dirServer, dirUrl;
let onbServer, onbUrl;

function startServices() {
  return Promise.all([
    new Promise((r) => { dirServer = dirApp.listen(0, '127.0.0.1', () => {
      dirUrl = `http://127.0.0.1:${dirServer.address().port}`; r();
    }); }),
    new Promise((r) => { onbServer = onbApp.listen(0, '127.0.0.1', () => {
      onbUrl = `http://127.0.0.1:${onbServer.address().port}`; r();
    }); }),
  ]);
}
function stopServices() {
  // closeAllConnections() drops any lingering keep-alive sockets so close()'s
  // callback fires promptly instead of waiting on idle connections.
  for (const s of [dirServer, onbServer]) {
    if (s && typeof s.closeAllConnections === 'function') s.closeAllConnections();
  }
  return Promise.all([
    new Promise((r) => dirServer && dirServer.close(() => r())),
    new Promise((r) => onbServer && onbServer.close(() => r())),
  ]);
}

// The test exercises the apps over real HTTP via the global `fetch`. Node's
// built-in fetch (undici) holds outbound sockets in a keep-alive pool that
// otherwise lingers for seconds after the servers close — long enough to trip
// the file-level test timeout. Close the global dispatcher during teardown so
// the process exits cleanly.
async function closeFetchPool() {
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (dispatcher && typeof dispatcher.close === 'function') {
    try { await dispatcher.close(); } catch { /* already closed */ }
  }
}

async function post(url, pathname, body, headers = {}) {
  const res = await fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

function signEternitasHmac(body) {
  return crypto
    .createHmac('sha256', process.env.ETERNITAS_WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

// ═════════════════════════════════════════════════════════════════════
// Live-probe — hit the real Eternitas if it's running
// ═════════════════════════════════════════════════════════════════════

describe('Live Eternitas probe (optional)', { concurrency: false }, () => {
  const liveUrl = process.env.LIVE_ETERNITAS_URL || 'http://localhost:8500';

  it('if reachable, returns contract-shaped 404 for a bogus passport', async (t) => {
    let res;
    try {
      res = await fetch(`${liveUrl}/api/v1/trust/ET-DOES-NOT-EXIST-${Date.now()}`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      t.skip(`Live Eternitas not reachable at ${liveUrl}: ${err.message}`);
      return;
    }
    assert.equal(res.status, 404, `expected 404 for unknown passport, got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    // Contract allows either FastAPI's default {detail:...} or {error:...}
    assert.ok(
      typeof body.detail === 'string' || typeof body.error === 'string',
      `expected error body, got ${JSON.stringify(body)}`,
    );
  });

  it('if reachable, rejects bogus-prefix passport with 400', async (t) => {
    let res;
    try {
      res = await fetch(`${liveUrl}/api/v1/trust/XX-not-a-real-prefix`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      t.skip(`Live Eternitas not reachable at ${liveUrl}: ${err.message}`);
      return;
    }
    assert.equal(res.status, 400, `expected 400 for bad prefix, got ${res.status}`);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Scenario round-trip via stand-in contract server
// ═════════════════════════════════════════════════════════════════════

describe('Trust contract round-trip (stand-in HTTP)', { concurrency: false }, () => {
  before(async () => {
    await startStandin();
    await startServices();
  });
  after(async () => {
    await stopServices();
    await stopStandin();
    await closeFetchPool();
  });
  beforeEach(() => {
    trustClient._clearCacheForTest();
    standinHits = [];
    standinProfiles.clear();
  });

  it('exceptional bot → every gate passes with max privileges', async () => {
    seed('ET26-EXCEPT-001', {
      status: 'active',
      integrity_score: 950,
      band: 'exceptional',
      clearance_level: 'eternal',
      tier_multiplier: 5.0,
      allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages', 'commit_push', 'broadcast', 'mention_strangers', 'bypass_rate_caps'],
      denied_actions: [],
    });
    seed('ET26-PEER', {
      allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages'],
    });

    const dm = await post(dirUrl, '/api/v1/chat/directory/agents/gate/dm',
      { recipient_passport: 'ET26-PEER' }, { 'Authorization': `Bearer ${botToken('ET26-EXCEPT-001')}` });
    assert.equal(dm.status, 200, `dm got ${dm.status}: ${JSON.stringify(dm.body)}`);
    assert.equal(dm.body.allowed, true);

    const bc = await post(dirUrl, '/api/v1/chat/directory/agents/gate/broadcast',
      {}, { 'Authorization': `Bearer ${botToken('ET26-EXCEPT-001')}` });
    assert.equal(bc.status, 200);
    assert.equal(bc.body.allowed, true);

    const mn = await post(dirUrl, '/api/v1/chat/directory/agents/gate/mention',
      { is_connected: false }, { 'Authorization': `Bearer ${botToken('ET26-EXCEPT-001')}` });
    assert.equal(mn.status, 200);
    assert.equal(mn.body.allowed, true);
    assert.equal(mn.body.clearance_level, 'eternal');

    // Stand-in recorded real GETs — proves no mocking at the client
    assert.ok(standinHits.includes('ET26-EXCEPT-001'), `expected GET for sender, hits=${JSON.stringify(standinHits)}`);
  });

  it('critical bot → every gate denies even though status=active', async () => {
    seed('ET26-CRIT-001', {
      status: 'active',
      band: 'critical',
      clearance_level: 'eternal', // doesn't matter — band critical overrides
      tier_multiplier: 0,
      allowed_actions: [],
      denied_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages', 'commit_push', 'broadcast', 'mention_strangers', 'bypass_rate_caps'],
    });
    seed('ET26-PEER', { allowed_actions: ['dm_bots'] });

    const dm = await post(dirUrl, '/api/v1/chat/directory/agents/gate/dm',
      { recipient_passport: 'ET26-PEER' }, { 'Authorization': `Bearer ${botToken('ET26-CRIT-001')}` });
    assert.equal(dm.status, 403);
    assert.equal(dm.body.band, 'critical');

    const bc = await post(dirUrl, '/api/v1/chat/directory/agents/gate/broadcast',
      {}, { 'Authorization': `Bearer ${botToken('ET26-CRIT-001')}` });
    assert.equal(bc.status, 403);

    const mn = await post(dirUrl, '/api/v1/chat/directory/agents/gate/mention',
      { is_connected: false }, { 'Authorization': `Bearer ${botToken('ET26-CRIT-001')}` });
    assert.equal(mn.status, 403);
    assert.equal(mn.body.reason, 'passport_not_active');
  });

  it('suspended bot → gate denies AND passport.revoked webhook flushes cache', async () => {
    seed('ET26-SUSP-001', {
      status: 'suspended',
      clearance_level: 'top_secret',
      allowed_actions: [], // suspended bots have no actions regardless
    });
    // First gate call populates cache and records a GET
    const firstGate = await post(dirUrl, '/api/v1/chat/directory/agents/gate/broadcast',
      {}, { 'Authorization': `Bearer ${botToken('ET26-SUSP-001')}` });
    assert.equal(firstGate.status, 403);
    assert.equal(firstGate.body.reason, 'passport_not_active');
    assert.equal(firstGate.body.status, 'suspended');
    assert.ok(standinHits.includes('ET26-SUSP-001'));

    // Provision an onboarding record so the passport.revoked handler has
    // something to deactivate; otherwise it 404s before flushing the cache
    const idBody = {
      windy_identity_id: 'id_susp_001',
      first_name: 'Su', last_name: 'Sp',
      passport_id: 'ET26-SUSP-001',
    };
    const idSig = crypto.createHmac('sha256', process.env.WINDY_IDENTITY_WEBHOOK_SECRET)
      .update(JSON.stringify(idBody)).digest('hex');
    const prov = await post(onbUrl, '/api/v1/webhooks/identity/created', idBody, {
      'x-windy-signature': idSig,
    });
    assert.equal(prov.status, 200);

    // Seed cache manually so we can observe the flush
    trustClient._setCacheForTest('ET26-SUSP-001', { passport_number: 'ET26-SUSP-001', status: 'suspended' });
    assert.ok(trustClient._getCacheForTest('ET26-SUSP-001'));

    const revBody = { passport: 'ET26-SUSP-001' };
    const rev = await post(onbUrl, '/api/v1/webhooks/passport/revoked', revBody, {
      'x-eternitas-signature': signEternitasHmac(revBody),
    });
    assert.equal(rev.status, 200);
    assert.equal(rev.body.trust_cache_flushed, true);
    assert.equal(trustClient._getCacheForTest('ET26-SUSP-001'), null);
  });

  it('revoked bot → trust/changed webhook flushes cache', async () => {
    seed('ET26-REV-001', {
      status: 'revoked',
      band: 'critical',
      allowed_actions: [],
    });

    // Populate cache via a gate call (real HTTP to stand-in)
    await post(dirUrl, '/api/v1/chat/directory/agents/gate/broadcast',
      {}, { 'Authorization': `Bearer ${botToken('ET26-REV-001')}` });
    assert.ok(trustClient._getCacheForTest('ET26-REV-001'),
      'cache populated after first gate check');

    const chBody = { passport: 'ET26-REV-001', event: 'trust.changed', new_band: 'critical' };
    const ch = await post(onbUrl, '/api/v1/webhooks/trust/changed', chBody, {
      'x-eternitas-signature': signEternitasHmac(chBody),
    });
    assert.equal(ch.status, 200);
    assert.equal(ch.body.flushed, true);
    assert.equal(trustClient._getCacheForTest('ET26-REV-001'), null);
  });

  it('human (Pro JWT, no passport) → gate bypasses without hitting Eternitas', async () => {
    const hitsBefore = standinHits.length;

    const dm = await post(dirUrl, '/api/v1/chat/directory/agents/gate/dm',
      { recipient_passport: 'ET26-ANYTHING' }, { 'Authorization': `Bearer ${humanToken()}` });
    assert.equal(dm.status, 200);
    assert.equal(dm.body.allowed, true);
    assert.equal(dm.body.caller, 'human');

    const bc = await post(dirUrl, '/api/v1/chat/directory/agents/gate/broadcast',
      {}, { 'Authorization': `Bearer ${humanToken()}` });
    assert.equal(bc.status, 200);
    assert.equal(bc.body.caller, 'human');

    const mn = await post(dirUrl, '/api/v1/chat/directory/agents/gate/mention',
      { is_connected: false }, { 'Authorization': `Bearer ${humanToken()}` });
    assert.equal(mn.status, 200);
    assert.equal(mn.body.caller, 'human');

    // Crucial contract assertion: zero upstream GETs for human callers
    assert.equal(standinHits.length, hitsBefore,
      `expected 0 Eternitas calls for human, saw ${standinHits.length - hitsBefore}: ${JSON.stringify(standinHits)}`);
  });

  it('404 from Eternitas → gate denies with passport_not_found', async () => {
    // No seed for this passport — stand-in returns 404
    const gate = await post(dirUrl, '/api/v1/chat/directory/agents/gate/broadcast',
      {}, { 'Authorization': `Bearer ${botToken('ET26-UNKNOWN-001')}` });
    assert.equal(gate.status, 403);
    assert.equal(gate.body.reason, 'passport_not_found');
  });
});
