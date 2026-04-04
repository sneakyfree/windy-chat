/**
 * Tests for new features: blocked users, privacy, media posts, repost, hashtags
 *
 * Run: node --test tests/unit/test-new-features.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.CHAT_API_TOKEN = 'test-features-token';
process.env.WINDY_JWT_SECRET = 'test-features-jwt-secret';
process.env.NODE_ENV = 'test';

const jwt = require('../../services/social/node_modules/jsonwebtoken');

function makeJwt(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId || sub },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const tokenA = makeJwt('user_alpha', 'windy_alpha');
const tokenB = makeJwt('user_beta', 'windy_beta');

// ── Social Service Tests ──

const { app: socialApp } = require('../../services/social/server');
let socialServer, socialUrl;

// ── Directory Service Tests ──
const directoryApp = require('../../services/directory/server');
let directoryServer, directoryUrl;

function request(baseUrl, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

before(async () => {
  socialServer = await new Promise(r => { const s = socialApp.listen(0, () => r(s)); });
  socialUrl = `http://localhost:${socialServer.address().port}`;
  directoryServer = await new Promise(r => { const s = directoryApp.listen(0, () => r(s)); });
  directoryUrl = `http://localhost:${directoryServer.address().port}`;
});

after(() => new Promise((resolve) => {
  let closed = 0;
  const done = () => { closed++; if (closed >= 2) { setTimeout(() => process.exit(0), 100); resolve(); } };
  socialServer.close(done);
  directoryServer.close(done);
}));

// ═══════════════════════════════════════════
//  Blocked Users (K3)
// ═══════════════════════════════════════════

describe('Blocked Users', () => {
  it('blocks a user', async () => {
    const res = await request(directoryUrl, 'POST', '/api/v1/chat/directory/block',
      { targetUserId: 'user_blocked_1' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, true);
    assert.equal(res.body.targetUserId, 'user_blocked_1');
  });

  it('lists blocked users', async () => {
    const res = await request(directoryUrl, 'GET', '/api/v1/chat/directory/blocked', null,
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.blockedUsers));
    assert.ok(res.body.blockedUsers.some(b => b.userId === 'user_blocked_1'));
  });

  it('unblocks a user', async () => {
    const res = await request(directoryUrl, 'DELETE', '/api/v1/chat/directory/block',
      { targetUserId: 'user_blocked_1' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, false);
  });

  it('rejects missing targetUserId', async () => {
    const res = await request(directoryUrl, 'POST', '/api/v1/chat/directory/block',
      {},
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 400);
  });
});

// ═══════════════════════════════════════════
//  Privacy Controls (K10)
// ═══════════════════════════════════════════

describe('Privacy Controls', () => {
  let publicPostId, followersPostId, privatePostId;

  it('creates a public post (default)', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Public post for privacy test' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 201);
    assert.equal(res.body.visibility || 'public', 'public');
    publicPostId = res.body.id;
  });

  it('creates a followers-only post', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Followers only post', visibility: 'followers' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 201);
    followersPostId = res.body.id;
  });

  it('creates a private post', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Private post', visibility: 'private' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 201);
    privatePostId = res.body.id;
  });

  it('rejects invalid visibility value', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Invalid visibility', visibility: 'everyone' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 400);
  });
});

// ═══════════════════════════════════════════
//  Media in Posts (K10)
// ═══════════════════════════════════════════

describe('Media in Posts', () => {
  it('creates a post with media_ids', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Post with images', media_ids: ['media-001', 'media-002'] },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.mediaIds || res.body.media_ids, ['media-001', 'media-002']);
  });

  it('rejects more than 4 media_ids', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Too many', media_ids: ['1', '2', '3', '4', '5'] },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 400);
  });

  it('rejects non-array media_ids', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Bad media', media_ids: 'not-array' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 400);
  });
});

// ═══════════════════════════════════════════
//  Repost/Share (K10)
// ═══════════════════════════════════════════

describe('Repost/Share', () => {
  let originalPostId;

  it('creates original post to repost', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
      { content: 'Original post for repost test' },
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 201);
    originalPostId = res.body.id;
  });

  it('reposts a post', async () => {
    const res = await request(socialUrl, 'POST', `/api/v1/social/posts/${originalPostId}/repost`,
      {},
      { Authorization: `Bearer ${tokenB}` });
    assert.equal(res.status, 201);
    assert.ok(res.body.repostOf || res.body.repost_of);
  });

  it('reposts with quote text', async () => {
    const res = await request(socialUrl, 'POST', `/api/v1/social/posts/${originalPostId}/repost`,
      { content: 'Check this out!' },
      { Authorization: `Bearer ${tokenB}` });
    assert.equal(res.status, 201);
    assert.ok(res.body.content.includes('Check this out'));
  });

  it('rejects repost of non-existent post', async () => {
    const res = await request(socialUrl, 'POST', '/api/v1/social/posts/nonexistent-id/repost',
      {},
      { Authorization: `Bearer ${tokenB}` });
    assert.equal(res.status, 404);
  });
});

// ═══════════════════════════════════════════
//  Hashtags + Trending (K10)
// ═══════════════════════════════════════════

describe('Hashtags + Trending', () => {
  it('creates posts with hashtags', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(socialUrl, 'POST', '/api/v1/social/posts',
        { content: `Post about #windychat and #testing number ${i}` },
        { Authorization: `Bearer ${tokenA}` });
      assert.equal(res.status, 201);
    }
  });

  it('gets trending hashtags', async () => {
    const res = await request(socialUrl, 'GET', '/api/v1/social/posts/trending', null,
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.hashtags));
    const windychat = res.body.hashtags.find(t => t.tag === 'windychat');
    assert.ok(windychat, 'Expected #windychat in trending');
    assert.ok(windychat.postCount >= 3);
  });

  it('gets posts by hashtag', async () => {
    const res = await request(socialUrl, 'GET', '/api/v1/social/posts/hashtag/windychat', null,
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.posts));
    assert.ok(res.body.posts.length >= 3);
  });

  it('returns empty for unknown hashtag', async () => {
    const res = await request(socialUrl, 'GET', '/api/v1/social/posts/hashtag/zzzznonexistent', null,
      { Authorization: `Bearer ${tokenA}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.posts.length, 0);
  });
});
