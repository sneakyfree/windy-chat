/**
 * Hardening: JWT Rejection Tests Across All Services
 *
 * For every service, tests:
 *   - No JWT → 401
 *   - Expired JWT → 401
 *   - Wrong-key JWT → 401
 *   - Error responses don't leak internal details
 *
 * Run: node --test tests/hardening/test_auth_hardening.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-auth-hardening-token';
process.env.WINDY_JWT_SECRET = 'test-auth-hardening-jwt';
process.env.NODE_ENV = 'test';

for (const svc of ['onboarding','directory','social','translation','media','call-history','push-gateway','backup']) {
  const d = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(d, { recursive: true });
}
fs.mkdirSync(path.join(__dirname, '..', '..', 'services', 'media', 'data', 'media', 'thumbnails'), { recursive: true });

const jwt = require('../../services/social/node_modules/jsonwebtoken');

// Valid token
const validToken = jwt.sign({ sub: 'auth_user' }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
// Expired token
const expiredToken = jwt.sign({ sub: 'auth_user' }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '-1s' });
// Wrong key token
const wrongKeyToken = jwt.sign({ sub: 'auth_user' }, 'completely-wrong-secret', { algorithm: 'HS256', expiresIn: '1h' });
// Malformed token
const malformedToken = 'not.a.valid.jwt.token';

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
  await loadAutoListen('../../services/directory/server', 'directory');
  await loadAutoListen('../../services/push-gateway/server', 'push-gateway');
  await loadAutoListen('../../services/backup/server', 'backup');
  await startManual('../../services/social/server', 'social');
  await startManual('../../services/translation/server', 'translation');
  await startManual('../../services/media/server', 'media');
  await startManual('../../services/call-history/server', 'call-history');
});
after(() => new Promise(r => { let c = 0; const t = servers.length; if (!t) r(); const f = () => { c++; if (c >= t) { setTimeout(() => process.exit(0), 100); r(); } }; for (const s of servers) s.close(f); }));

function req(method, svc, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, urls[svc]);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}), ...headers } };
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on('error', reject); if (bodyStr) r.write(bodyStr); r.end();
  });
}

// Protected endpoints for each service
const protectedEndpoints = [
  { svc: 'onboarding', method: 'POST', path: '/api/v1/chat/verify/send', body: { type: 'email', identifier: 'test@test.com' }, name: 'K2 Onboarding' },
  { svc: 'directory', method: 'POST', path: '/api/v1/chat/directory/lookup', body: { hashes: ['abc'] }, name: 'K3 Directory' },
  { svc: 'social', method: 'POST', path: '/api/v1/social/posts', body: { content: 'test' }, name: 'K10 Social' },
  { svc: 'translation', method: 'POST', path: '/api/v1/translate', body: { text: 'hi', source_lang: 'en', target_lang: 'es' }, name: 'K9 Translation' },
  { svc: 'media', method: 'POST', path: '/api/v1/media/upload', body: null, name: 'K4 Media' },
  { svc: 'call-history', method: 'GET', path: '/api/v1/calls/history', body: null, name: 'K5 Call History' },
  { svc: 'push-gateway', method: 'POST', path: '/api/v1/chat/push/register', body: { pushkey: 't', userId: 'u', platform: 'android' }, name: 'K6 Push' },
  { svc: 'backup', method: 'POST', path: '/api/v1/chat/backup/create', body: { userId: 'u', encryptedData: 'x' }, name: 'K8 Backup' },
];

for (const ep of protectedEndpoints) {
  describe(`${ep.name} — Auth rejection`, () => {
    it('rejects request with no JWT → 401', async () => {
      const r = await req(ep.method, ep.svc, ep.path, ep.body, {});
      assert.equal(r.status, 401, `${ep.name} should return 401 without JWT`);
    });

    it('rejects expired JWT → 401', async () => {
      const r = await req(ep.method, ep.svc, ep.path, ep.body, { Authorization: `Bearer ${expiredToken}` });
      assert.equal(r.status, 401, `${ep.name} should reject expired JWT`);
    });

    it('rejects wrong-key JWT → 401', async () => {
      const r = await req(ep.method, ep.svc, ep.path, ep.body, { Authorization: `Bearer ${wrongKeyToken}` });
      assert.equal(r.status, 401, `${ep.name} should reject wrong-key JWT`);
    });

    it('rejects malformed JWT → 401', async () => {
      const r = await req(ep.method, ep.svc, ep.path, ep.body, { Authorization: `Bearer ${malformedToken}` });
      assert.equal(r.status, 401, `${ep.name} should reject malformed JWT`);
    });

    it('error response does not leak stack traces', async () => {
      const r = await req(ep.method, ep.svc, ep.path, ep.body, { Authorization: `Bearer ${wrongKeyToken}` });
      const bodyStr = JSON.stringify(r.body);
      assert.ok(!bodyStr.includes('node_modules'), 'Error should not contain node_modules paths');
      assert.ok(!bodyStr.includes('at '), 'Error should not contain stack trace lines');
      assert.ok(!bodyStr.includes('.js:'), 'Error should not contain file:line references');
    });
  });
}
