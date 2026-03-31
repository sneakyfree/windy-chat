/**
 * Hardening: Concurrent Access Tests
 *
 * Tests SQLite WAL mode under concurrent reads/writes.
 *
 * Run: node --test tests/hardening/test_concurrency.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-concurrency-token';
process.env.WINDY_JWT_SECRET = 'test-concurrency-jwt';
process.env.NODE_ENV = 'test';

const dataDir = path.join(__dirname, '..', '..', 'services', 'social', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const jwt = require('../../services/social/node_modules/jsonwebtoken');
const tokenA = jwt.sign({ sub: 'conc_user_a' }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const tokenB = jwt.sign({ sub: 'conc_user_b' }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const { app } = require('../../services/social/server');
let server, baseUrl;

before(async () => {
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
});
after(() => new Promise(r => { server.close(() => { setTimeout(() => process.exit(0), 100); r(); }); }));

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}), ...headers } };
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on('error', reject); if (bodyStr) r.write(bodyStr); r.end();
  });
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('Concurrent Post Creation', () => {
  it('10 simultaneous post creates all succeed', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      req('POST', '/api/v1/social/posts', { content: `Concurrent post ${i}` }, auth(tokenA))
    );
    const results = await Promise.all(promises);

    const successes = results.filter(r => r.status === 201);
    assert.equal(successes.length, 10, 'All 10 creates should succeed');

    // Verify no duplicate IDs
    const ids = successes.map(r => r.body.id);
    const unique = new Set(ids);
    assert.equal(unique.size, 10, 'All 10 posts should have unique IDs');
  });
});

describe('Concurrent Likes (Idempotent)', () => {
  let postId;

  before(async () => {
    const r = await req('POST', '/api/v1/social/posts', { content: 'Like target' }, auth(tokenA));
    postId = r.body.id;
  });

  it('10 simultaneous likes result in exactly 1 like', async () => {
    const promises = Array.from({ length: 10 }, () =>
      req('POST', `/api/v1/social/posts/${postId}/like`, {}, auth(tokenB))
    );
    const results = await Promise.all(promises);

    // All should succeed (200)
    for (const r of results) {
      assert.equal(r.status, 200);
    }

    // Final like count should be exactly 1
    const check = await req('GET', `/api/v1/social/posts/${postId}`);
    assert.equal(check.body.likeCount, 1, 'Like count should be exactly 1 despite 10 concurrent likes');
  });
});

describe('Concurrent Follows (Idempotent)', () => {
  it('10 simultaneous follows result in exactly 1 follow', async () => {
    const promises = Array.from({ length: 10 }, () =>
      req('POST', '/api/v1/social/follow/conc_user_a', {}, auth(tokenB))
    );
    const results = await Promise.all(promises);

    for (const r of results) {
      assert.equal(r.status, 200);
    }

    // Check followers list
    const followers = await req('GET', '/api/v1/social/follow/followers/conc_user_a');
    assert.equal(followers.body.followers.length, 1, 'Should have exactly 1 follower');
    assert.ok(followers.body.followers.includes('conc_user_b'));
  });
});

describe('Concurrent Reads and Writes', () => {
  it('mixed concurrent reads/writes dont crash SQLite WAL', async () => {
    // Create posts and read feed simultaneously
    const writes = Array.from({ length: 5 }, (_, i) =>
      req('POST', '/api/v1/social/posts', { content: `WAL test ${i}` }, auth(tokenA))
    );
    const reads = Array.from({ length: 5 }, () =>
      req('GET', '/api/v1/social/posts', null, auth(tokenA))
    );

    const results = await Promise.all([...writes, ...reads]);

    const writeResults = results.slice(0, 5);
    const readResults = results.slice(5);

    for (const w of writeResults) {
      assert.equal(w.status, 201, 'Write should succeed');
    }
    for (const r of readResults) {
      assert.equal(r.status, 200, 'Read should succeed');
    }
  });
});
