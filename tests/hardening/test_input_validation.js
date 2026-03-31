/**
 * Hardening: Input Validation Across All Services
 *
 * Tests every input boundary and rejection case for K2-K10.
 *
 * Run: node --test tests/hardening/test_input_validation.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-validation-token';
process.env.WINDY_JWT_SECRET = 'test-validation-jwt';
process.env.NODE_ENV = 'test';

// Clean data dirs
for (const svc of ['onboarding','directory','social','translation','media','call-history','push-gateway','backup']) {
  const d = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(d, { recursive: true });
}
fs.mkdirSync(path.join(__dirname, '..', '..', 'services', 'media', 'data', 'media', 'thumbnails'), { recursive: true });

const jwt = require('../../services/social/node_modules/jsonwebtoken');
const tokenA = jwt.sign({ sub: 'val_user_a', windy_identity_id: 'val-uuid-a' }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const tokenB = jwt.sign({ sub: 'val_user_b', windy_identity_id: 'val-uuid-b' }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

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
  await startManual('../../services/social/server', 'social');
  await startManual('../../services/media/server', 'media');
  await startManual('../../services/translation/server', 'translation');
  await startManual('../../services/call-history/server', 'call-history');
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

function upload(svc, urlPath, fieldName, fileName, buf, mime, headers = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----B' + crypto.randomBytes(8).toString('hex');
    const url = new URL(urlPath, urls[svc]);
    const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`];
    const start = Buffer.from(parts.join('')); const end = Buffer.from(`\r\n--${boundary}--\r\n`);
    const full = Buffer.concat([start, buf, end]);
    const opts = { method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': full.length, ...headers } };
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on('error', reject); r.write(full); r.end();
  });
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

// ═══════════════════════════════════════
// K2 — Onboarding
// ═══════════════════════════════════════

describe('K2 Onboarding Input Validation', () => {
  it('rejects empty phone', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/chat/verify/send', { type: 'phone', identifier: '' }, auth(tokenA));
    assert.equal(r.status, 400);
  });

  it('rejects non-E164 phone "abc"', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/chat/verify/send', { type: 'phone', identifier: 'abc' }, auth(tokenA));
    assert.equal(r.status, 400);
  });

  it('rejects display name over 64 chars', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/chat/profile/setup', {
      verificationToken: 'dummy', displayName: 'x'.repeat(100), languages: ['en'],
    }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /64|characters|length/i);
  });

  it('rejects display name with profanity', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/chat/profile/setup', {
      verificationToken: 'dummy', displayName: 'shithead', languages: ['en'],
    }, auth(tokenA));
    assert.equal(r.status, 400);
  });

  it('handles SQL injection in display name safely', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/chat/profile/setup', {
      verificationToken: 'dummy', displayName: "Robert'; DROP TABLE users;--", languages: ['en'],
    }, auth(tokenA));
    // Should either accept (parameterized) or reject (profanity/invalid chars) — NOT crash
    assert.ok([201, 400].includes(r.status), `Expected 201 or 400, got ${r.status}`);
  });

  it('rejects display name of 1 char', async () => {
    const r = await req('POST', 'onboarding', '/api/v1/chat/profile/setup', {
      verificationToken: 'dummy', displayName: 'A', languages: ['en'],
    }, auth(tokenA));
    assert.equal(r.status, 400);
  });
});

// ═══════════════════════════════════════
// K3 — Directory
// ═══════════════════════════════════════

describe('K3 Directory Input Validation', () => {
  it('rejects empty hashes array', async () => {
    const r = await req('POST', 'directory', '/api/v1/chat/directory/lookup', { hashes: [] }, auth(tokenA));
    assert.equal(r.status, 400);
  });

  it('rejects over 1000 hashes', async () => {
    const hashes = Array.from({ length: 1001 }, () => crypto.randomBytes(32).toString('hex'));
    const r = await req('POST', 'directory', '/api/v1/chat/directory/lookup', { hashes }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /1000/);
  });

  it('rejects search with empty query', async () => {
    const r = await req('GET', 'directory', '/api/v1/chat/directory/search?q=', null, auth(tokenA));
    assert.equal(r.status, 400);
  });

  it('strips XSS from search query', async () => {
    const r = await req('GET', 'directory', '/api/v1/chat/directory/search?q=<script>alert(1)</script>', null, auth(tokenA));
    // Should return 200 with empty results or 400 — NOT execute script
    assert.ok([200, 400].includes(r.status));
    if (r.status === 200) {
      const body = JSON.stringify(r.body);
      assert.ok(!body.includes('<script>'), 'Response must not contain raw script tags');
    }
  });

  it('rejects search with query under 2 chars', async () => {
    const r = await req('GET', 'directory', '/api/v1/chat/directory/search?q=A', null, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /2 characters/i);
  });
});

// ═══════════════════════════════════════
// K10 — Social
// ═══════════════════════════════════════

describe('K10 Social Input Validation', () => {
  let postId;

  it('rejects post with empty content', async () => {
    const r = await req('POST', 'social', '/api/v1/social/posts', { content: '' }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /content/);
  });

  it('rejects post with content over 5000 chars', async () => {
    const r = await req('POST', 'social', '/api/v1/social/posts', { content: 'x'.repeat(5001) }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /max length/);
  });

  it('rejects post with profanity', async () => {
    const r = await req('POST', 'social', '/api/v1/social/posts', { content: 'this is bullshit' }, auth(tokenA));
    assert.equal(r.status, 422);
    assert.match(r.body.error, /prohibited/);
  });

  it('rejects self-follow', async () => {
    const r = await req('POST', 'social', `/api/v1/social/follow/val_user_a`, {}, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /yourself/);
  });

  it('handles idempotent double-like', async () => {
    const create = await req('POST', 'social', '/api/v1/social/posts', { content: 'Likeable post' }, auth(tokenA));
    postId = create.body.id;

    const like1 = await req('POST', 'social', `/api/v1/social/posts/${postId}/like`, {}, auth(tokenB));
    assert.equal(like1.status, 200);
    assert.equal(like1.body.likeCount, 1);

    const like2 = await req('POST', 'social', `/api/v1/social/posts/${postId}/like`, {}, auth(tokenB));
    assert.equal(like2.status, 200);
    assert.equal(like2.body.likeCount, 1); // Still 1, not 2
  });

  it('rejects report with invalid reason', async () => {
    const r = await req('POST', 'social', `/api/v1/social/moderation/${postId}/report`, { reason: 'invalid_reason' }, auth(tokenB));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /reason/);
  });

  it('rejects post with invalid translated_versions type', async () => {
    const r = await req('POST', 'social', '/api/v1/social/posts', { content: 'hello', translated_versions: 'not-object' }, auth(tokenA));
    assert.equal(r.status, 400);
  });
});

// ═══════════════════════════════════════
// K4 — Media
// ═══════════════════════════════════════

describe('K4 Media Input Validation', () => {
  it('rejects upload with no file', async () => {
    const r = await req('POST', 'media', '/api/v1/media/upload', {}, auth(tokenA));
    assert.equal(r.status, 400);
  });

  it('rejects disallowed file type (.exe)', async () => {
    const r = await upload('media', '/api/v1/media/upload', 'file', 'virus.exe', Buffer.from('MZ'), 'application/x-msdownload', auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not allowed/i);
  });

  it('returns 404 for non-existent media ID', async () => {
    const r = await req('GET', 'media', '/api/v1/media/nonexistent-id-12345');
    assert.equal(r.status, 404);
  });

  it('returns 404 for non-existent thumbnail', async () => {
    const r = await req('GET', 'media', '/api/v1/media/nonexistent-id-12345/thumbnail');
    assert.equal(r.status, 404);
  });
});

// ═══════════════════════════════════════
// K9 — Translation
// ═══════════════════════════════════════

describe('K9 Translation Input Validation', () => {
  it('rejects empty text', async () => {
    const r = await req('POST', 'translation', '/api/v1/translate', { text: '', source_lang: 'en', target_lang: 'es' }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /text/);
  });

  it('rejects missing source_lang', async () => {
    const r = await req('POST', 'translation', '/api/v1/translate', { text: 'hello', target_lang: 'es' }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /source_lang/);
  });

  it('rejects missing target_lang', async () => {
    const r = await req('POST', 'translation', '/api/v1/translate', { text: 'hello', source_lang: 'en' }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /target_lang/);
  });

  it('rejects invalid preference language code', async () => {
    const r = await req('POST', 'translation', '/api/v1/translate/preferences', { preferred_language: 'x' }, auth(tokenA));
    assert.equal(r.status, 400);
  });
});

// ═══════════════════════════════════════
// K5 — Call History
// ═══════════════════════════════════════

describe('K5 Call History Input Validation', () => {
  it('rejects missing room_id', async () => {
    const r = await req('POST', 'call-history', '/api/v1/calls/log', {
      caller_id: 'a', callee_id: 'b', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), duration_seconds: 10, call_type: 'voice',
    }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /room_id/);
  });

  it('rejects invalid call_type "hologram"', async () => {
    const r = await req('POST', 'call-history', '/api/v1/calls/log', {
      room_id: '!r:t', caller_id: 'a', callee_id: 'b', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), duration_seconds: 10, call_type: 'hologram',
    }, auth(tokenA));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /call_type/);
  });

  it('rejects negative duration', async () => {
    const r = await req('POST', 'call-history', '/api/v1/calls/log', {
      room_id: '!r:t', caller_id: 'a', callee_id: 'b', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), duration_seconds: -5, call_type: 'voice',
    }, auth(tokenA));
    assert.equal(r.status, 400);
  });

  it('rejects quality_score over 5', async () => {
    const r = await req('POST', 'call-history', '/api/v1/calls/log', {
      room_id: '!r:t', caller_id: 'a', callee_id: 'b', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), duration_seconds: 10, call_type: 'voice', quality_score: 11,
    }, auth(tokenA));
    assert.equal(r.status, 400);
  });
});
