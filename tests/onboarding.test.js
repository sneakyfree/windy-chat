/**
 * Tests for Windy Chat — Onboarding Service (K2)
 *
 * Run: node --test tests/onboarding.test.js
 * Requires: Node 20+ (uses built-in test runner)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Set env before requiring the app
process.env.CHAT_API_TOKEN = 'test-token-onboarding';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

const { app } = require('../services/onboarding/server');

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
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

before(() => {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  return new Promise((resolve) => {
    server.close(() => {
      // Force exit to clean up timers (pair.js session cleanup interval)
      setTimeout(() => process.exit(0), 100);
      resolve();
    });
  });
});

// ── Health Check ──

describe('GET /health', () => {
  it('returns service status with uptime and dependencies', async () => {
    const res = await request('GET', '/health', null, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'windy-chat-onboarding');
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.version, '1.0.0');
    assert.ok(res.body.uptime);
    assert.ok(res.body.uptimeMs >= 0);
    assert.ok(res.body.timestamp);
    assert.ok(res.body.dependencies);
  });
});

// ── 404 ──

describe('Unknown routes', () => {
  it('returns 404 JSON for unknown paths', async () => {
    const res = await request('GET', '/api/v1/chat/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });
});

// ── Auth ──

describe('Auth middleware', () => {
  it('rejects requests without Authorization header', async () => {
    const res = await request('POST', '/api/v1/chat/verify/send', { type: 'email', identifier: 'a@b.com' }, { Authorization: '' });
    assert.equal(res.status, 401);
    assert.ok(res.body.error);
  });

  it('accepts valid service token', async () => {
    // Even if the body is invalid, we should get past auth (400, not 401)
    const res = await request('POST', '/api/v1/chat/verify/send', {});
    assert.notEqual(res.status, 401);
  });
});

// ── Verify Routes (K2.1) ──

describe('POST /api/v1/chat/verify/send', () => {
  it('rejects missing type', async () => {
    const res = await request('POST', '/api/v1/chat/verify/send', { identifier: 'test@example.com' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /type/);
  });

  it('rejects invalid type', async () => {
    const res = await request('POST', '/api/v1/chat/verify/send', { type: 'fax', identifier: 'test@example.com' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /type/);
  });

  it('rejects missing identifier', async () => {
    const res = await request('POST', '/api/v1/chat/verify/send', { type: 'email' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /identifier/);
  });

  it('rejects invalid email format', async () => {
    const res = await request('POST', '/api/v1/chat/verify/send', { type: 'email', identifier: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /email/i);
  });

  it('sends OTP for valid email (dev stub)', async () => {
    const res = await request('POST', '/api/v1/chat/verify/send', { type: 'email', identifier: 'test@example.com' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.type, 'email');
    assert.equal(res.body.expiresInSeconds, 600);
  });

  it('rejects invalid phone number', async () => {
    const res = await request('POST', '/api/v1/chat/verify/send', { type: 'phone', identifier: 'xyz' });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/v1/chat/verify/check', () => {
  it('rejects missing identifier', async () => {
    const res = await request('POST', '/api/v1/chat/verify/check', { code: '123456' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /identifier/);
  });

  it('rejects missing code', async () => {
    const res = await request('POST', '/api/v1/chat/verify/check', { identifier: 'test@example.com' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /code/);
  });

  it('rejects non-existent OTP', async () => {
    const res = await request('POST', '/api/v1/chat/verify/check', { identifier: 'nobody@example.com', code: '000000' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No verification code/);
  });
});

describe('GET /api/v1/chat/verify/status', () => {
  it('rejects missing identifier query param', async () => {
    const res = await request('GET', '/api/v1/chat/verify/status');
    assert.equal(res.status, 400);
  });

  it('returns not verified for unknown identifier', async () => {
    const res = await request('GET', '/api/v1/chat/verify/status?identifier=nobody@example.com');
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, false);
  });
});

// ── Profile Routes (K2.2) ──

describe('GET /api/v1/chat/profile/check-name', () => {
  it('rejects missing name query param', async () => {
    const res = await request('GET', '/api/v1/chat/profile/check-name');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /name/);
  });

  it('checks name availability', async () => {
    const res = await request('GET', '/api/v1/chat/profile/check-name?name=TestUser');
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'TestUser');
    assert.equal(typeof res.body.available, 'boolean');
  });

  it('rejects names that are too long', async () => {
    const name = 'a'.repeat(101);
    const res = await request('GET', `/api/v1/chat/profile/check-name?name=${name}`);
    assert.equal(res.status, 400);
  });
});

describe('POST /api/v1/chat/profile/setup', () => {
  it('rejects missing verificationToken', async () => {
    const res = await request('POST', '/api/v1/chat/profile/setup', {
      displayName: 'TestUser',
    });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /[Vv]erification/);
  });

  it('rejects missing displayName', async () => {
    const res = await request('POST', '/api/v1/chat/profile/setup', {
      verificationToken: 'some-token',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /displayName/);
  });

  it('rejects too-short displayName', async () => {
    const res = await request('POST', '/api/v1/chat/profile/setup', {
      verificationToken: 'some-token',
      displayName: 'A',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /2 characters/);
  });

  it('creates profile with valid input', async () => {
    const name = `TestUser_${Date.now()}`;
    const res = await request('POST', '/api/v1/chat/profile/setup', {
      verificationToken: 'some-token',
      displayName: name,
      languages: ['en', 'es'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.profile.displayName, name);
    assert.deepEqual(res.body.profile.languages, ['en', 'es']);
    assert.equal(res.body.nextStep, 'provision');
  });

  it('rejects invalid languages array', async () => {
    const res = await request('POST', '/api/v1/chat/profile/setup', {
      verificationToken: 'some-token',
      displayName: `TestUser2_${Date.now()}`,
      languages: 'not-an-array',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /languages/);
  });
});

// ── Pair Routes (K2.3) ──

describe('POST /api/v1/chat/pair/generate', () => {
  it('generates a pairing session', async () => {
    const res = await request('POST', '/api/v1/chat/pair/generate', {});
    assert.equal(res.status, 200);
    assert.ok(res.body.sessionId);
    assert.ok(res.body.qrPayload);
    assert.ok(res.body.qrPayload.session);
    assert.ok(res.body.qrPayload.pubkey);
    assert.equal(res.body.qrPayload.version, 1);
    assert.equal(res.body.ttlSeconds, 120);
  });
});

describe('POST /api/v1/chat/pair/confirm', () => {
  it('rejects missing sessionId', async () => {
    const res = await request('POST', '/api/v1/chat/pair/confirm', {
      authToken: 'tok',
      userId: 'user1',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /sessionId/);
  });

  it('rejects missing authToken', async () => {
    const res = await request('POST', '/api/v1/chat/pair/confirm', {
      sessionId: 'some-id',
      userId: 'user1',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /authToken/);
  });

  it('returns 404 for non-existent session', async () => {
    const res = await request('POST', '/api/v1/chat/pair/confirm', {
      sessionId: 'nonexistent',
      authToken: 'tok',
      userId: 'user1',
    });
    assert.equal(res.status, 404);
  });

  it('confirms a valid pairing session', async () => {
    // Generate first
    const gen = await request('POST', '/api/v1/chat/pair/generate', {});
    const sessionId = gen.body.sessionId;

    // Confirm — use CHAT_API_TOKEN as authToken (service-to-service validation)
    const res = await request('POST', '/api/v1/chat/pair/confirm', {
      sessionId,
      authToken: process.env.CHAT_API_TOKEN,
      userId: 'test_user',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.paired, true);
    assert.ok(res.body.deviceId);
  });
});

describe('GET /api/v1/chat/pair/status/:sessionId', () => {
  it('returns 404 for non-existent session', async () => {
    const res = await request('GET', '/api/v1/chat/pair/status/nonexistent');
    assert.equal(res.status, 404);
  });

  it('returns pending status for new session', async () => {
    const gen = await request('POST', '/api/v1/chat/pair/generate', {});
    const res = await request('GET', `/api/v1/chat/pair/status/${gen.body.sessionId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending');
  });
});

// ── Provision Routes (K2.4) ──

describe('POST /api/v1/chat/provision', () => {
  it('rejects missing chatUserId', async () => {
    const res = await request('POST', '/api/v1/chat/provision', {
      displayName: 'Test',
      verificationToken: 'tok',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /chatUserId/);
  });

  it('rejects missing displayName', async () => {
    const res = await request('POST', '/api/v1/chat/provision', {
      chatUserId: 'windy_abc123',
      verificationToken: 'tok',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /displayName/);
  });

  it('rejects missing verificationToken', async () => {
    const res = await request('POST', '/api/v1/chat/provision', {
      chatUserId: 'windy_abc123',
      displayName: 'Test User',
    });
    assert.equal(res.status, 401);
  });

  it('provisions with dev stub credentials', async () => {
    const res = await request('POST', '/api/v1/chat/provision', {
      chatUserId: 'windy_test123',
      displayName: 'Test User',
      verificationToken: 'test-token',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.matrix);
    assert.ok(res.body.matrix.matrixUserId);
    assert.ok(res.body.matrix.accessToken);
    assert.equal(res.body.onboarding.complete, true);
  });
});

describe('GET /api/v1/chat/provision/onboarding/status', () => {
  it('rejects missing chatUserId', async () => {
    const res = await request('GET', '/api/v1/chat/provision/onboarding/status');
    assert.equal(res.status, 400);
  });

  it('returns incomplete for unknown user', async () => {
    const res = await request('GET', '/api/v1/chat/provision/onboarding/status?chatUserId=unknown_user');
    assert.equal(res.status, 200);
    assert.equal(res.body.complete, false);
    assert.equal(res.body.nextStep, 'verify');
  });
});
