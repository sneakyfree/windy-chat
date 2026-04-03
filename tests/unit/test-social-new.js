/**
 * Tests for Windy Chat — Social Service NEW Features
 * Post deletion, full-text search, and comments.
 *
 * Run: node --test tests/unit/test-social-new.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-token-social-new';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

// Clean data dir before loading the service
const dataDir = path.join(__dirname, '..', '..', 'services', 'social', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../../services/social/server');
const jwt = require('../../services/social/node_modules/jsonwebtoken');

let server;
let baseUrl;

function makeJwt(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId || sub },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const TOKEN_A = makeJwt('social-user-a', 'wid-social-a');
const TOKEN_B = makeJwt('social-user-b', 'wid-social-b');

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
    };
    if (token !== null && token !== undefined) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
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

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
}));

// ── Helper: create a post as user A ──

async function createPost(content, token) {
  return request('POST', '/api/v1/social/posts', { content }, token || TOKEN_A);
}

// ── Post Deletion ──

describe('DELETE /api/v1/social/posts/:postId', () => {
  it('requires auth (401 without token)', async () => {
    const post = await createPost('Post to test auth on delete');
    const res = await request('DELETE', `/api/v1/social/posts/${post.body.id}`, null, null);
    assert.equal(res.status, 401);
  });

  it('returns 404 for non-existent post', async () => {
    const res = await request('DELETE', '/api/v1/social/posts/non-existent-id-12345', null, TOKEN_A);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
  });

  it('returns 403 when trying to delete another user\'s post', async () => {
    const post = await createPost('User A post that B cannot delete');
    assert.equal(post.status, 201);

    const res = await request('DELETE', `/api/v1/social/posts/${post.body.id}`, null, TOKEN_B);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /own/i);
  });

  it('successfully deletes own post (returns { deleted: true, postId })', async () => {
    const post = await createPost('Post to be deleted by owner');
    assert.equal(post.status, 201);
    const postId = post.body.id;

    const res = await request('DELETE', `/api/v1/social/posts/${postId}`, null, TOKEN_A);
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    assert.equal(res.body.postId, postId);
  });

  it('deleted post returns 404 on subsequent GET', async () => {
    const post = await createPost('Post that will disappear');
    assert.equal(post.status, 201);
    const postId = post.body.id;

    // Delete it
    const del = await request('DELETE', `/api/v1/social/posts/${postId}`, null, TOKEN_A);
    assert.equal(del.status, 200);

    // GET should now 404
    const get = await request('GET', `/api/v1/social/posts/${postId}`, null, TOKEN_A);
    assert.equal(get.status, 404);
  });
});

// ── Full-Text Search ──

describe('GET /api/v1/social/posts/search', () => {
  // Seed some posts for searching
  before(async () => {
    await createPost('The quick brown fox jumps over the lazy dog');
    await createPost('Windy Chat is the best messaging platform');
    await createPost('Foxes are beautiful animals in the wild');
  });

  it('returns 400 when q is missing', async () => {
    const res = await request('GET', '/api/v1/social/posts/search', null, TOKEN_A);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /q/);
  });

  it('returns 400 when q is empty string', async () => {
    const res = await request('GET', '/api/v1/social/posts/search?q=', null, TOKEN_A);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /q/);
  });

  it('finds posts matching search term', async () => {
    const res = await request('GET', '/api/v1/social/posts/search?q=fox', null, TOKEN_A);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.posts));
    assert.ok(res.body.posts.length >= 1, 'should find at least one matching post');
    assert.equal(res.body.query, 'fox');
    // Every returned post should contain the search term
    for (const p of res.body.posts) {
      assert.ok(p.content.toLowerCase().includes('fox'), `post should contain "fox": ${p.content}`);
    }
  });

  it('returns empty array for no matches', async () => {
    const res = await request('GET', '/api/v1/social/posts/search?q=xyznonexistent999', null, TOKEN_A);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.posts));
    assert.equal(res.body.posts.length, 0);
    assert.equal(res.body.count, 0);
  });

  it('respects limit parameter', async () => {
    const res = await request('GET', '/api/v1/social/posts/search?q=fox&limit=1', null, TOKEN_A);
    assert.equal(res.status, 200);
    assert.ok(res.body.posts.length <= 1);
  });
});

// ── Comments ──

describe('POST /api/v1/social/posts/:postId/comments', () => {
  let testPostId;

  before(async () => {
    const post = await createPost('Post for comment testing');
    testPostId = post.body.id;
  });

  it('requires auth (401 without token)', async () => {
    const res = await request('POST', `/api/v1/social/posts/${testPostId}/comments`, { content: 'hello' }, null);
    assert.equal(res.status, 401);
  });

  it('returns 404 for non-existent post', async () => {
    const res = await request('POST', '/api/v1/social/posts/nonexistent-post-999/comments', { content: 'hello' }, TOKEN_A);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
  });

  it('rejects empty content (400)', async () => {
    const res = await request('POST', `/api/v1/social/posts/${testPostId}/comments`, { content: '' }, TOKEN_A);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /content/i);
  });

  it('rejects content over 2000 chars (400)', async () => {
    const longContent = 'a'.repeat(2001);
    const res = await request('POST', `/api/v1/social/posts/${testPostId}/comments`, { content: longContent }, TOKEN_A);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /2000/);
  });

  it('rejects profanity (422)', async () => {
    const res = await request('POST', `/api/v1/social/posts/${testPostId}/comments`, { content: 'this is bullshit' }, TOKEN_A);
    assert.equal(res.status, 422);
    assert.match(res.body.error, /prohibited/i);
  });

  it('successfully creates a comment (201)', async () => {
    const res = await request('POST', `/api/v1/social/posts/${testPostId}/comments`, { content: 'Great post!' }, TOKEN_B);
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.postId, testPostId);
    assert.equal(res.body.userId, 'social-user-b');
    assert.equal(res.body.content, 'Great post!');
    assert.ok(res.body.createdAt);
  });
});

describe('GET /api/v1/social/posts/:postId/comments', () => {
  let testPostId;

  before(async () => {
    const post = await createPost('Post with comments to retrieve');
    testPostId = post.body.id;
    // Add a couple of comments
    await request('POST', `/api/v1/social/posts/${testPostId}/comments`, { content: 'First comment' }, TOKEN_A);
    await request('POST', `/api/v1/social/posts/${testPostId}/comments`, { content: 'Second comment' }, TOKEN_B);
  });

  it('returns comments for a post', async () => {
    const res = await request('GET', `/api/v1/social/posts/${testPostId}/comments`, null, TOKEN_A);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.comments));
    assert.equal(res.body.comments.length, 2);
    assert.equal(res.body.count, 2);

    const contents = res.body.comments.map(c => c.content);
    assert.ok(contents.includes('First comment'));
    assert.ok(contents.includes('Second comment'));
  });

  it('returns 404 for non-existent post on GET', async () => {
    const res = await request('GET', '/api/v1/social/posts/nonexistent-post-888/comments', null, TOKEN_A);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
  });
});
