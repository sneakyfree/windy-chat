/**
 * Tests for Windy Chat — Directory Service (K3)
 *
 * Run: node --test tests/directory.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.CHAT_API_TOKEN = 'test-token-directory';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

const app = require('../services/directory/server');

let server;
let baseUrl;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CHAT_API_TOKEN}`,
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
    if (body) req.write(JSON.stringify(body));
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

// ── Health ──

describe('GET /health', () => {
  it('returns service status with uptime and dependencies', async () => {
    const res = await request('GET', '/health', null, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'windy-chat-directory');
    assert.ok(res.body.uptime);
    assert.ok(res.body.dependencies);
  });
});

// ── 404 ──

describe('Unknown routes', () => {
  it('returns 404 JSON', async () => {
    const res = await request('GET', '/api/v1/chat/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });
});

// ── Auth ──

describe('Auth', () => {
  it('rejects missing auth', async () => {
    const res = await request('GET', '/api/v1/chat/directory/salt', null, { Authorization: '' });
    assert.equal(res.status, 401);
  });
});

// ── Salt (K3.1) ──

describe('GET /api/v1/chat/directory/salt', () => {
  it('returns salt and rotation info', async () => {
    const res = await request('GET', '/api/v1/chat/directory/salt');
    assert.equal(res.status, 200);
    assert.ok(res.body.salt);
    assert.equal(res.body.salt.length, 64); // 32 bytes hex
    assert.equal(res.body.algorithm, 'SHA256');
    assert.ok(res.body.createdAt);
    assert.ok(res.body.rotatesAt);
  });
});

// ── Lookup (K3.1) ──

describe('POST /api/v1/chat/directory/lookup', () => {
  it('rejects missing hashes', async () => {
    const res = await request('POST', '/api/v1/chat/directory/lookup', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /hashes/);
  });

  it('rejects non-array hashes', async () => {
    const res = await request('POST', '/api/v1/chat/directory/lookup', { hashes: 'not-array' });
    assert.equal(res.status, 400);
  });

  it('rejects invalid hash format', async () => {
    const res = await request('POST', '/api/v1/chat/directory/lookup', { hashes: ['short', 'invalid'] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /SHA256/);
  });

  it('rejects more than 1000 hashes', async () => {
    const hashes = Array(1001).fill('a'.repeat(64));
    const res = await request('POST', '/api/v1/chat/directory/lookup', { hashes });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /1000/);
  });

  it('returns empty matches for unknown hashes', async () => {
    const hash = 'a'.repeat(64);
    const res = await request('POST', '/api/v1/chat/directory/lookup', { hashes: [hash] });
    assert.equal(res.status, 200);
    assert.equal(res.body.submitted, 1);
    assert.equal(res.body.matchCount, 0);
    assert.deepEqual(res.body.matches, []);
  });
});

// ── Register Hash (K3.1) ──

describe('POST /api/v1/chat/directory/register-hash', () => {
  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register-hash', {
      displayName: 'Test',
      identifierHash: 'a'.repeat(64),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId/);
  });

  it('rejects missing displayName', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register-hash', {
      userId: 'user1',
      identifierHash: 'a'.repeat(64),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /displayName/);
  });

  it('rejects invalid hash format', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register-hash', {
      userId: 'user1',
      displayName: 'Test',
      identifierHash: 'tooshort',
    });
    assert.equal(res.status, 400);
  });

  it('registers a valid hash', async () => {
    const hash = 'b'.repeat(64);
    const res = await request('POST', '/api/v1/chat/directory/register-hash', {
      userId: 'user_hash_test',
      displayName: 'Hash User',
      identifierHash: hash,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.registeredCount, 1);
  });

  it('finds registered hash via lookup', async () => {
    const hash = 'b'.repeat(64);
    const res = await request('POST', '/api/v1/chat/directory/lookup', { hashes: [hash] });
    assert.equal(res.status, 200);
    assert.equal(res.body.matchCount, 1);
    assert.equal(res.body.matches[0].userId, 'user_hash_test');
    assert.equal(res.body.matches[0].displayName, 'Hash User');
  });

  it('registers hashes from identifiers array', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register-hash', {
      userId: 'user_ids_test',
      displayName: 'Ids User',
      identifiers: ['+15551234567'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.registeredCount, 1);
  });

  it('rejects when neither hash nor identifiers provided', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register-hash', {
      userId: 'user1',
      displayName: 'Test',
    });
    assert.equal(res.status, 400);
  });
});

// ── Stats (K3.1) ──

describe('GET /api/v1/chat/directory/stats', () => {
  it('returns directory statistics', async () => {
    const res = await request('GET', '/api/v1/chat/directory/stats');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.totalHashes === 'number');
    assert.ok(res.body.saltAge);
    assert.ok(res.body.nextRotation);
  });
});

// ── Register in Directory (K3.2) ──

describe('POST /api/v1/chat/directory/register', () => {
  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register', {
      displayName: 'Test',
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing displayName', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register', {
      userId: 'user1',
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid email', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register', {
      userId: 'user1',
      displayName: 'Test',
      email: 'not-email',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /email/i);
  });

  it('registers a user in directory', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register', {
      userId: 'search_user_1',
      displayName: 'Alice Smith',
      email: 'alice@example.com',
      languages: ['en', 'es'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.searchable, true);
  });

  it('registers a non-searchable user', async () => {
    const res = await request('POST', '/api/v1/chat/directory/register', {
      userId: 'private_user',
      displayName: 'Bob Private',
      searchable: false,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.searchable, false);
  });
});

// ── Search (K3.2) ──

describe('GET /api/v1/chat/directory/search', () => {
  it('rejects query shorter than 2 chars', async () => {
    const res = await request('GET', '/api/v1/chat/directory/search?q=A');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /2 characters/);
  });

  it('rejects missing query', async () => {
    const res = await request('GET', '/api/v1/chat/directory/search');
    assert.equal(res.status, 400);
  });

  it('finds user by name prefix', async () => {
    const res = await request('GET', '/api/v1/chat/directory/search?q=Alice');
    assert.equal(res.status, 200);
    assert.ok(res.body.results.length > 0);
    const alice = res.body.results.find(r => r.displayName === 'Alice Smith');
    assert.ok(alice, 'Expected Alice Smith in results');
    assert.equal(alice.matchType, 'name');
  });

  it('finds user by exact email', async () => {
    const res = await request('GET', '/api/v1/chat/directory/search?q=alice@example.com');
    assert.equal(res.status, 200);
    assert.ok(res.body.results.length > 0);
    assert.equal(res.body.results[0].matchType, 'email');
  });

  it('does not return non-searchable users', async () => {
    const res = await request('GET', '/api/v1/chat/directory/search?q=Bob');
    assert.equal(res.status, 200);
    const found = res.body.results.find(r => r.userId === 'private_user');
    assert.equal(found, undefined);
  });

  it('returns empty for no matches', async () => {
    const res = await request('GET', '/api/v1/chat/directory/search?q=zzzznonexistent');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
  });
});

// ── Invite (K3.2) ──

describe('POST /api/v1/chat/directory/invite', () => {
  it('rejects missing fromUserId', async () => {
    const res = await request('POST', '/api/v1/chat/directory/invite', {
      type: 'email',
      identifier: 'friend@example.com',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /fromUserId/);
  });

  it('rejects invalid type', async () => {
    const res = await request('POST', '/api/v1/chat/directory/invite', {
      fromUserId: 'user1',
      type: 'fax',
      identifier: 'friend@example.com',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /type/);
  });

  it('rejects invalid email for email invite', async () => {
    const res = await request('POST', '/api/v1/chat/directory/invite', {
      fromUserId: 'user1',
      type: 'email',
      identifier: 'not-email',
    });
    assert.equal(res.status, 400);
  });

  it('sends email invite (dev stub)', async () => {
    const res = await request('POST', '/api/v1/chat/directory/invite', {
      fromUserId: 'user1',
      fromDisplayName: 'Test User',
      type: 'email',
      identifier: 'friend@example.com',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.referralCode);
    assert.ok(res.body.deepLink);
    assert.ok(typeof res.body.invitesRemaining === 'number');
  });

  it('sends sms invite (dev stub)', async () => {
    const res = await request('POST', '/api/v1/chat/directory/invite', {
      fromUserId: 'sms_user',
      type: 'sms',
      identifier: '+15551234567',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});
