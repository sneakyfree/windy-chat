/**
 * Tests for Windy Chat — Social Service (K10)
 *
 * Run: node --test tests/social.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('../services/social/node_modules/jsonwebtoken');

process.env.CHAT_API_TOKEN = 'test-social-token';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

// Clear persisted data before loading the app
const fs = require('node:fs');
const path = require('node:path');
const dataDir = path.join(__dirname, '..', 'services', 'social', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../services/social/server');
const store = require('../services/social/lib/store');

let server;
let baseUrl;

function makeJwt(sub) {
  return jwt.sign({ sub }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

const userA = 'user_alice';
const userB = 'user_bob';
const userC = 'user_charlie';
const tokenA = makeJwt(userA);
const tokenB = makeJwt(userB);
const tokenC = makeJwt(userC);

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
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

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
}));

// ── Health ──

describe('GET /health', () => {
  it('returns service status', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'windy-chat-social');
  });
});

// ── 404 ──

describe('Unknown routes', () => {
  it('returns 404 JSON', async () => {
    const res = await request('GET', '/nonexistent');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});

// ── Presence ──

describe('GET /api/v1/social/presence/:userId', () => {
  it('returns presence info', async () => {
    const res = await request('GET', '/api/v1/social/presence/user123');
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, 'user123');
    assert.equal(res.body.status, 'online');
    assert.ok(res.body.lastSeen);
  });
});

// ── Posts ──

describe('Posts', () => {
  it('rejects unauthenticated post creation', async () => {
    const res = await request('POST', '/api/v1/social/posts', { content: 'hello' });
    assert.equal(res.status, 401);
  });

  it('rejects empty content', async () => {
    const res = await request('POST', '/api/v1/social/posts', { content: '' }, authed(tokenA));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /content/);
  });

  it('rejects missing content', async () => {
    const res = await request('POST', '/api/v1/social/posts', {}, authed(tokenA));
    assert.equal(res.status, 400);
  });

  it('rejects profanity', async () => {
    const res = await request('POST', '/api/v1/social/posts', { content: 'this is bullshit' }, authed(tokenA));
    assert.equal(res.status, 422);
    assert.match(res.body.error, /prohibited/);
    assert.ok(res.body.matched.includes('bullshit'));
  });

  it('rejects leet-speak profanity', async () => {
    const res = await request('POST', '/api/v1/social/posts', { content: 'you are an a55hole' }, authed(tokenA));
    assert.equal(res.status, 422);
  });

  it('rejects profanity in translated_versions', async () => {
    const res = await request('POST', '/api/v1/social/posts', {
      content: 'hello world',
      translated_versions: { es: 'this is shit' },
    }, authed(tokenA));
    assert.equal(res.status, 422);
    assert.match(res.body.error, /Translated version/);
  });

  it('rejects invalid translated_versions type', async () => {
    const res = await request('POST', '/api/v1/social/posts', {
      content: 'hello',
      translated_versions: 'not an object',
    }, authed(tokenA));
    assert.equal(res.status, 400);
  });

  it('rejects content over max length', async () => {
    const res = await request('POST', '/api/v1/social/posts', {
      content: 'x'.repeat(5001),
    }, authed(tokenA));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /max length/);
  });

  let createdPostId;

  it('creates a post successfully', async () => {
    const res = await request('POST', '/api/v1/social/posts', {
      content: 'Hello from Alice!',
      translated_versions: { es: 'Hola de Alice!', fr: 'Bonjour de Alice!' },
    }, authed(tokenA));
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.userId, userA);
    assert.equal(res.body.content, 'Hello from Alice!');
    assert.deepEqual(res.body.translated_versions, { es: 'Hola de Alice!', fr: 'Bonjour de Alice!' });
    assert.equal(res.body.likeCount, 0);
    assert.equal(res.body.verified, false);
    createdPostId = res.body.id;
  });

  it('gets a single post', async () => {
    const res = await request('GET', `/api/v1/social/posts/${createdPostId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, createdPostId);
    assert.equal(res.body.content, 'Hello from Alice!');
  });

  it('returns 404 for non-existent post', async () => {
    const res = await request('GET', '/api/v1/social/posts/nonexistent');
    assert.equal(res.status, 404);
  });

  it('gets user posts', async () => {
    const res = await request('GET', `/api/v1/social/posts/user/${userA}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.posts.length >= 1);
    assert.equal(res.body.posts[0].userId, userA);
  });

  it('returns empty for user with no posts', async () => {
    const res = await request('GET', `/api/v1/social/posts/user/nobody`);
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
  });
});

// ── Likes ──

describe('Likes', () => {
  let postId;

  before(async () => {
    const res = await request('POST', '/api/v1/social/posts', { content: 'Like this post' }, authed(tokenA));
    postId = res.body.id;
  });

  it('rejects unauthenticated like', async () => {
    const res = await request('POST', `/api/v1/social/posts/${postId}/like`, {});
    assert.equal(res.status, 401);
  });

  it('likes a post', async () => {
    const res = await request('POST', `/api/v1/social/posts/${postId}/like`, {}, authed(tokenB));
    assert.equal(res.status, 200);
    assert.equal(res.body.liked, true);
    assert.equal(res.body.likeCount, 1);
  });

  it('is idempotent for same user', async () => {
    const res = await request('POST', `/api/v1/social/posts/${postId}/like`, {}, authed(tokenB));
    assert.equal(res.body.likeCount, 1);
  });

  it('queues notification for post author on like', async () => {
    const res = await request('GET', '/api/v1/social/notifications?unread=true', null, authed(tokenA));
    const likeNotif = res.body.notifications.find(n => n.type === 'like' && n.postId === postId);
    assert.ok(likeNotif, 'Expected a like notification');
    assert.equal(likeNotif.fromUserId, userB);
  });

  it('unlikes a post', async () => {
    const res = await request('DELETE', `/api/v1/social/posts/${postId}/like`, {}, authed(tokenB));
    assert.equal(res.status, 200);
    assert.equal(res.body.liked, false);
    assert.equal(res.body.likeCount, 0);
  });

  it('returns 404 for liking non-existent post', async () => {
    const res = await request('POST', '/api/v1/social/posts/fake/like', {}, authed(tokenB));
    assert.equal(res.status, 404);
  });
});

// ── Follow ──

describe('Follow', () => {
  it('rejects unauthenticated follow', async () => {
    const res = await request('POST', `/api/v1/social/follow/${userB}`, {});
    assert.equal(res.status, 401);
  });

  it('rejects self-follow', async () => {
    const res = await request('POST', `/api/v1/social/follow/${userA}`, {}, authed(tokenA));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /yourself/);
  });

  it('follows a user', async () => {
    const res = await request('POST', `/api/v1/social/follow/${userB}`, {}, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.following, true);
  });

  it('queues notification for followed user', async () => {
    const res = await request('GET', '/api/v1/social/notifications?unread=true', null, authed(tokenB));
    const followNotif = res.body.notifications.find(n => n.type === 'follow' && n.fromUserId === userA);
    assert.ok(followNotif, 'Expected a follow notification');
  });

  it('lists followers', async () => {
    const res = await request('GET', `/api/v1/social/follow/followers/${userB}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.followers.includes(userA));
  });

  it('lists following', async () => {
    const res = await request('GET', `/api/v1/social/follow/following/${userA}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.following.includes(userB));
  });

  it('unfollows a user', async () => {
    const res = await request('DELETE', `/api/v1/social/follow/${userB}`, {}, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.following, false);
  });

  it('no longer in followers after unfollow', async () => {
    const res = await request('GET', `/api/v1/social/follow/followers/${userB}`);
    assert.ok(!res.body.followers.includes(userA));
  });
});

// ── Feed ──

describe('Feed', () => {
  before(async () => {
    // Alice follows Bob, Bob creates a post
    await request('POST', `/api/v1/social/follow/${userB}`, {}, authed(tokenA));
    await request('POST', '/api/v1/social/posts', { content: 'Post from Bob' }, authed(tokenB));
  });

  it('shows followed users posts in feed', async () => {
    const res = await request('GET', '/api/v1/social/posts', null, authed(tokenA));
    assert.equal(res.status, 200);
    const bobPost = res.body.posts.find(p => p.userId === userB);
    assert.ok(bobPost, 'Feed should include posts from followed users');
  });

  it('shows own posts in feed', async () => {
    const res = await request('GET', '/api/v1/social/posts', null, authed(tokenA));
    const ownPost = res.body.posts.find(p => p.userId === userA);
    assert.ok(ownPost, 'Feed should include own posts');
  });

  it('does not show unfollowed users', async () => {
    const res = await request('GET', '/api/v1/social/posts', null, authed(tokenC));
    // Charlie follows nobody, should only see own posts (none yet)
    assert.equal(res.body.count, 0);
  });
});

// ── Notifications ──

describe('Notifications', () => {
  it('rejects unauthenticated access', async () => {
    const res = await request('GET', '/api/v1/social/notifications');
    assert.equal(res.status, 401);
  });

  it('gets notifications', async () => {
    const res = await request('GET', '/api/v1/social/notifications', null, authed(tokenB));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.notifications));
    assert.ok(res.body.unreadCount >= 0);
  });

  it('filters unread notifications', async () => {
    const res = await request('GET', '/api/v1/social/notifications?unread=true', null, authed(tokenB));
    assert.equal(res.status, 200);
    for (const n of res.body.notifications) {
      assert.equal(n.read, false);
    }
  });

  it('marks notifications as read', async () => {
    // Get a notification ID first
    const get = await request('GET', '/api/v1/social/notifications?unread=true', null, authed(tokenB));
    if (get.body.notifications.length > 0) {
      const ids = [get.body.notifications[0].id];
      const res = await request('POST', '/api/v1/social/notifications/read', { notificationIds: ids }, authed(tokenB));
      assert.equal(res.status, 200);
      assert.equal(res.body.markedRead, 1);
    }
  });

  it('rejects invalid notificationIds', async () => {
    const res = await request('POST', '/api/v1/social/notifications/read', { notificationIds: 'not-array' }, authed(tokenB));
    assert.equal(res.status, 400);
  });
});

// ── Moderation / Reports ──

describe('Moderation', () => {
  let postId;

  before(async () => {
    const res = await request('POST', '/api/v1/social/posts', { content: 'Reportable post' }, authed(tokenA));
    postId = res.body.id;
  });

  it('rejects report with invalid reason', async () => {
    const res = await request('POST', `/api/v1/social/moderation/${postId}/report`, {
      reason: 'invalid_reason',
    }, authed(tokenB));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /reason/);
  });

  it('rejects report on non-existent post', async () => {
    const res = await request('POST', '/api/v1/social/moderation/fake/report', {
      reason: 'spam',
    }, authed(tokenB));
    assert.equal(res.status, 404);
  });

  it('reports a post', async () => {
    const res = await request('POST', `/api/v1/social/moderation/${postId}/report`, {
      reason: 'spam',
      description: 'This looks like spam to me',
    }, authed(tokenB));
    assert.equal(res.status, 201);
    assert.ok(res.body.reportId);
    assert.equal(res.body.status, 'pending');
  });

  it('prevents duplicate reports from same user', async () => {
    const res = await request('POST', `/api/v1/social/moderation/${postId}/report`, {
      reason: 'spam',
    }, authed(tokenB));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already reported/);
  });

  it('allows different users to report same post', async () => {
    const res = await request('POST', `/api/v1/social/moderation/${postId}/report`, {
      reason: 'harassment',
    }, authed(tokenC));
    assert.equal(res.status, 201);
  });
});

// ── Eternitas Verified Badge ──

describe('Eternitas Verified Badge', () => {
  it('marks account as verified', async () => {
    const res = await request('POST', '/api/v1/social/eternitas/verify', {
      userId: userA,
    }, { Authorization: `Bearer ${process.env.CHAT_API_TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
  });

  it('verified user posts show badge', async () => {
    const create = await request('POST', '/api/v1/social/posts', {
      content: 'Verified post!',
    }, authed(tokenA));
    assert.equal(create.status, 201);
    assert.equal(create.body.verified, true);

    const get = await request('GET', `/api/v1/social/posts/${create.body.id}`);
    assert.equal(get.body.verified, true);
  });

  it('verified user presence shows badge', async () => {
    const res = await request('GET', `/api/v1/social/presence/${userA}`);
    assert.equal(res.body.verified, true);
  });

  it('revokes verification', async () => {
    const res = await request('DELETE', '/api/v1/social/eternitas/verify', {
      userId: userA,
    }, { Authorization: `Bearer ${process.env.CHAT_API_TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, false);
  });

  it('unverified user posts no longer show badge', async () => {
    const create = await request('POST', '/api/v1/social/posts', {
      content: 'No longer verified',
    }, authed(tokenA));
    assert.equal(create.body.verified, false);
  });

  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/social/eternitas/verify', {}, {
      Authorization: `Bearer ${process.env.CHAT_API_TOKEN}`,
    });
    assert.equal(res.status, 400);
  });
});

// ── Translation Integration ──

describe('Translation Integration', () => {
  it('stores and returns translated_versions', async () => {
    const translations = { es: 'Hola mundo', ja: 'こんにちは世界', ar: 'مرحبا بالعالم' };
    const create = await request('POST', '/api/v1/social/posts', {
      content: 'Hello world',
      translated_versions: translations,
    }, authed(tokenB));
    assert.equal(create.status, 201);
    assert.deepEqual(create.body.translated_versions, translations);

    const get = await request('GET', `/api/v1/social/posts/${create.body.id}`);
    assert.deepEqual(get.body.translated_versions, translations);
  });

  it('allows posts without translations', async () => {
    const res = await request('POST', '/api/v1/social/posts', {
      content: 'No translations here',
    }, authed(tokenB));
    assert.equal(res.status, 201);
    assert.equal(res.body.translated_versions, null);
  });
});
