/**
 * Integration Test: Unified Login Flow
 *
 * Tests the "one click and you're in Chat" experience:
 *   1. JWT with windy_identity_id → auto-provision
 *   2. Idempotent second call → returns existing
 *   3. Expired JWT → 401
 *   4. Ecosystem status endpoint
 *   5. Enriched profile endpoint
 *
 * Run: node --test tests/integration/test_unified_login.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-unified-token';
process.env.WINDY_JWT_SECRET = 'test-unified-jwt';
process.env.NODE_ENV = 'test';

// Clean data
for (const svc of ['onboarding', 'social']) {
  const d = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(d, { recursive: true });
}

const jwt = require('../../services/social/node_modules/jsonwebtoken');

const WINDY_ID = 'unified-test-uuid-1234-5678-abcdef';
const USER_EMAIL = 'grant@windyword.ai';
const USER_NAME = 'Grant Whitmer';

const validToken = jwt.sign({
  sub: 'unified_test_user',
  windy_identity_id: WINDY_ID,
  email: USER_EMAIL,
  display_name: USER_NAME,
}, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const expiredToken = jwt.sign({
  sub: 'unified_test_user',
  windy_identity_id: WINDY_ID,
}, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '-1s' });

const noIdentityToken = jwt.sign({
  sub: 'no_identity_user',
}, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const servers = [];
const urls = {};

function loadAutoListen(modPath, name) {
  const orig = process.env.PORT; process.env.PORT = '0';
  const origListen = http.Server.prototype.listen;
  let cap = null;
  http.Server.prototype.listen = function(...a) { cap = this; a[0] = 0; return origListen.apply(this, a); };
  const mod = require(modPath);
  http.Server.prototype.listen = origListen;
  if (orig) process.env.PORT = orig; else delete process.env.PORT;
  return new Promise(r => {
    if (cap) { const c = () => { const a = cap.address(); if (a) { servers.push(cap); urls[name] = `http://localhost:${a.port}`; r(); } else cap.once('listening', () => { servers.push(cap); urls[name] = `http://localhost:${cap.address().port}`; r(); }); }; c(); }
    else { const app = mod.app || mod; const s = app.listen(0, () => { servers.push(s); urls[name] = `http://localhost:${s.address().port}`; r(); }); }
  });
}
function startManual(modPath, name) {
  const mod = require(modPath); const app = mod.app || mod;
  return new Promise(r => { const s = app.listen(0, () => { servers.push(s); urls[name] = `http://localhost:${s.address().port}`; r(); }); });
}

before(async () => {
  await loadAutoListen('../../services/onboarding/server', 'onboarding');
  await startManual('../../services/social/server', 'social');
});
after(() => new Promise(r => { let c = 0; const t = servers.length; if (!t) r(); const f = () => { c++; if (c >= t) { setTimeout(() => process.exit(0), 100); r(); } }; for (const s of servers) s.close(f); }));

function req(method, svc, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, urls[svc]);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}), ...headers } };
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on('error', reject); if (bodyStr) r.write(bodyStr); r.end();
  });
}

const authed = (t) => ({ Authorization: `Bearer ${t}` });

// ═══════════════════════════════════════
// Unified Login
// ═══════════════════════════════════════

describe('Unified Login: First-time provisioning', () => {
  let firstResponse;

  it('provisions new user from JWT', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/onboarding/unified-login', {}, authed(validToken));
    assert.equal(r.status, 201);
    assert.ok(r.body.matrix_user_id, 'Should return matrix_user_id');
    assert.ok(r.body.access_token, 'Should return access_token');
    assert.equal(r.body.already_existed, false);
    assert.equal(r.body.display_name, USER_NAME);
    assert.equal(r.body.windy_identity_id, WINDY_ID);
    assert.ok(r.body.chat_user_id);
    firstResponse = r.body;
  });

  it('returns existing user on second call (idempotent)', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/onboarding/unified-login', {}, authed(validToken));
    assert.equal(r.status, 200);
    assert.equal(r.body.already_existed, true);
    assert.equal(r.body.windy_identity_id, WINDY_ID);
    assert.equal(r.body.display_name, USER_NAME);
    assert.equal(r.body.chat_user_id, firstResponse.chat_user_id);
  });

  it('rejects expired JWT', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/onboarding/unified-login', {}, authed(expiredToken));
    assert.equal(r.status, 401);
  });

  it('rejects JWT without windy_identity_id', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/onboarding/unified-login', {}, authed(noIdentityToken));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /windy_identity_id/);
  });

  it('rejects request with no JWT', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/onboarding/unified-login', {});
    assert.equal(r.status, 401);
  });
});

// ═══════════════════════════════════════
// Ecosystem Status
// ═══════════════════════════════════════

describe('Ecosystem Status', () => {
  it('returns ecosystem status with chat info', async () => {
    const r = await req('GET', 'social', '/api/v1/social/ecosystem-status', null, authed(validToken));
    assert.equal(r.status, 200);
    assert.equal(r.body.windy_identity_id, WINDY_ID);
    assert.ok(r.body.chat, 'Should have chat section');
    assert.equal(typeof r.body.chat.posts_count, 'number');
    assert.equal(typeof r.body.chat.following_count, 'number');
    assert.ok(r.body.ecosystem, 'Should have ecosystem section');
  });

  it('rejects unauthenticated request', async () => {
    const r = await req('GET', 'social', '/api/v1/social/ecosystem-status', null);
    assert.equal(r.status, 401);
  });
});

// ═══════════════════════════════════════
// Enriched Profile
// ═══════════════════════════════════════

describe('Enriched Profile', () => {
  it('returns enriched profile for a user', async () => {
    const r = await req('GET', 'social', '/api/v1/social/profile/unified_test_user', null, authed(validToken));
    assert.equal(r.status, 200);
    assert.equal(r.body.user_id, 'unified_test_user');
    assert.equal(typeof r.body.verified, 'boolean');
    assert.equal(typeof r.body.posts_count, 'number');
    assert.equal(typeof r.body.followers_count, 'number');
    assert.equal(typeof r.body.following_count, 'number');
    // Cross-product fields present (null for now)
    assert.ok('windy_mail_address' in r.body);
    assert.ok('windy_fly_status' in r.body);
    assert.ok('eternitas_passport' in r.body);
  });
});
