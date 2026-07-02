/**
 * Tests for Windy Chat — Shared Utilities
 *
 * Run: node --test tests/unit/test-shared.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Set env vars BEFORE requiring modules (they read env at require time)
process.env.WINDY_JWT_SECRET = 'test-shared-secret';
process.env.CHAT_API_TOKEN = 'test-shared-api-token';
process.env.NODE_ENV = 'test';

const { asyncHandler } = require('../../services/shared/async-handler');
const { createCorsOptions, getAllowedOrigins, DEFAULT_ORIGINS } = require('../../services/shared/cors');
const { createHealthHandler } = require('../../services/shared/health');
const { createAuthMiddleware, verifyToken } = require('../../services/shared/jwt-verify');
const jwt = require('../../services/shared/node_modules/jsonwebtoken');

// ── Helpers ──────────────────────────────────────────────────────────

function mockReq(headers = {}) {
  return { headers };
}

function mockRes() {
  const res = {
    statusCode: 200,
    _body: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res._body = body; return res; },
  };
  return res;
}

function makeJwt(payload = {}, opts = {}) {
  const defaults = { sub: 'user-1', windy_identity_id: 'wid-1' };
  return jwt.sign(
    { ...defaults, ...payload },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h', ...opts },
  );
}

// ── async-handler.js ─────────────────────────────────────────────────

describe('asyncHandler', () => {
  it('wraps a sync handler and calls next normally', async () => {
    let nextCalled = false;
    const handler = asyncHandler((req, res, next) => { next(); });
    const req = mockReq();
    const res = mockRes();
    await handler(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('catches rejected promises and forwards to next(err)', async () => {
    const error = new Error('boom');
    let capturedErr = null;
    const handler = asyncHandler(async () => { throw error; });
    // Give the microtask a tick to resolve
    await handler(mockReq(), mockRes(), (err) => { capturedErr = err; });
    // The catch is async via Promise.resolve().catch(), so wait a tick
    await new Promise(r => setTimeout(r, 10));
    assert.equal(capturedErr, error);
  });

  it('passes through successful async handlers', async () => {
    const res = mockRes();
    const handler = asyncHandler(async (_req, r) => { r.status(200).json({ ok: true }); });
    await handler(mockReq(), res, () => {});
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res._body, { ok: true });
  });
});

// ── cors.js ──────────────────────────────────────────────────────────

describe('cors', () => {
  it('DEFAULT_ORIGINS includes windyword.ai domains', () => {
    assert.ok(DEFAULT_ORIGINS.includes('https://windyword.ai'));
    assert.ok(DEFAULT_ORIGINS.includes('https://windyword.ai'));
    assert.ok(DEFAULT_ORIGINS.includes('https://windyword.ai'));
  });

  it('getAllowedOrigins() returns defaults when no env var set', () => {
    const saved = process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    const origins = getAllowedOrigins();
    assert.deepEqual(origins, DEFAULT_ORIGINS);
    if (saved !== undefined) process.env.CORS_ALLOWED_ORIGINS = saved;
  });

  it('getAllowedOrigins() includes CORS_ALLOWED_ORIGINS env var entries', () => {
    const saved = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = 'https://extra1.com, https://extra2.com';
    const origins = getAllowedOrigins();
    assert.ok(origins.includes('https://extra1.com'));
    assert.ok(origins.includes('https://extra2.com'));
    // defaults still present
    assert.ok(origins.includes('https://windyword.ai'));
    if (saved !== undefined) process.env.CORS_ALLOWED_ORIGINS = saved;
    else delete process.env.CORS_ALLOWED_ORIGINS;
  });

  it('createCorsOptions() returns object with origin function and credentials: true', () => {
    const opts = createCorsOptions();
    assert.equal(typeof opts.origin, 'function');
    assert.equal(opts.credentials, true);
  });

  it('origin function allows null origin (server-to-server)', (_, done) => {
    const opts = createCorsOptions();
    opts.origin(null, (err, allowed) => {
      assert.equal(err, null);
      assert.equal(allowed, true);
      done();
    });
  });

  it('origin function allows undefined origin (server-to-server)', (_, done) => {
    const opts = createCorsOptions();
    opts.origin(undefined, (err, allowed) => {
      assert.equal(err, null);
      assert.equal(allowed, true);
      done();
    });
  });

  it('origin function allows listed origins', (_, done) => {
    const opts = createCorsOptions();
    opts.origin('https://windyword.ai', (err, allowed) => {
      assert.equal(err, null);
      assert.equal(allowed, true);
      done();
    });
  });

  it('origin function allows localhost in non-production', (_, done) => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const opts = createCorsOptions();
    opts.origin('http://localhost:9999', (err, allowed) => {
      assert.equal(err, null);
      assert.equal(allowed, true);
      process.env.NODE_ENV = saved;
      done();
    });
  });

  // Miss-path behavior changed in Wave 14: createCorsOptions() used to
  // resolve callback(new Error('CORS: origin not allowed')) on rejection,
  // which cascaded to Express's default error handler and surfaced as a
  // 500 Internal Server Error (Wave 13 Phase 4 P1-1). The fix is to
  // resolve (null, false) instead — the cors package omits the ACAO
  // header, and the browser enforces the block. Callers that want an
  // explicit 403 JSON envelope should prefer createCorsMiddleware().
  it('origin function rejects unlisted origins in production without throwing', (_, done) => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const opts = createCorsOptions();
    opts.origin('https://evil.com', (err, allowed) => {
      assert.equal(err, null);
      assert.equal(allowed, false);
      process.env.NODE_ENV = saved;
      done();
    });
  });

  it('DEFAULT_ORIGINS includes the Wave 13 Phase 4 prod domain chat.windychat.ai', () => {
    assert.ok(DEFAULT_ORIGINS.includes('https://chat.windychat.ai'));
  });
});

// ── health.js ────────────────────────────────────────────────────────

describe('createHealthHandler', () => {
  it('returns a function (route handler)', () => {
    const handler = createHealthHandler({ service: 'test-svc' });
    assert.equal(typeof handler, 'function');
  });

  it('handler returns 200 with service name, status, uptime, timestamp', async () => {
    const handler = createHealthHandler({ service: 'test-svc' });
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._body.service, 'test-svc');
    assert.equal(res._body.status, 'ok');
    assert.ok(typeof res._body.uptime === 'string');
    assert.ok(typeof res._body.timestamp === 'string');
  });

  it('handler includes version', async () => {
    const handler = createHealthHandler({ service: 'test-svc', version: '2.3.4' });
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._body.version, '2.3.4');
  });

  it('when checks function provided, includes dependencies', async () => {
    const handler = createHealthHandler({
      service: 'test-svc',
      checks: async () => ({ db: true, cache: true }),
    });
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res._body.dependencies, { db: true, cache: true });
  });

  it('when checks throws, returns status: degraded with 503', async () => {
    const handler = createHealthHandler({
      service: 'test-svc',
      checks: async () => { throw new Error('db down'); },
    });
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res._body.status, 'degraded');
    assert.ok(res._body.dependencies.error);
  });
});

// ── jwt-verify.js ────────────────────────────────────────────────────

describe('verifyToken', () => {
  it('validates HS256 JWT signed with WINDY_JWT_SECRET', async () => {
    const token = makeJwt({ sub: 'user-42' });
    const decoded = await verifyToken(token);
    assert.equal(decoded.sub, 'user-42');
  });

  it('rejects invalid tokens', async () => {
    await assert.rejects(() => verifyToken('not.a.jwt'), /Invalid token/);
  });

  it('rejects expired tokens', async () => {
    const token = jwt.sign(
      { sub: 'expired-user' },
      process.env.WINDY_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '-1s' },
    );
    await assert.rejects(() => verifyToken(token), /expired/i);
  });

  it('rejects HS256 tokens in production (RS256/JWKS is the only trust root)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // Signed with the very secret the hosts set to an "unused" placeholder —
      // in prod this must NOT be a valid forgery key.
      const token = makeJwt({ sub: 'attacker' });
      await assert.rejects(() => verifyToken(token), /production/i);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('still accepts HS256 outside production (dev/test convenience)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const token = makeJwt({ sub: 'dev-user' });
      const decoded = await verifyToken(token);
      assert.equal(decoded.sub, 'dev-user');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('createAuthMiddleware', () => {
  it('returns 401 for missing Authorization header', async () => {
    const mw = createAuthMiddleware();
    const res = mockRes();
    await mw(mockReq(), res, () => {});
    assert.equal(res.statusCode, 401);
    assert.match(res._body.error, /Missing/i);
  });

  it('returns 401 for invalid token', async () => {
    const mw = createAuthMiddleware();
    const res = mockRes();
    await mw(mockReq({ authorization: 'Bearer garbage' }), res, () => {});
    // verifyToken is async, give it a tick
    await new Promise(r => setTimeout(r, 10));
    assert.equal(res.statusCode, 401);
  });

  it('passes for valid JWT and sets req.user', async () => {
    const mw = createAuthMiddleware();
    const token = makeJwt({ sub: 'user-99', role: 'member' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const res = mockRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.sub, 'user-99');
  });

  it('passes for static CHAT_API_TOKEN', async () => {
    const mw = createAuthMiddleware();
    const req = mockReq({ authorization: `Bearer ${process.env.CHAT_API_TOKEN}` });
    const res = mockRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.sub, 'service');
    assert.equal(req.user.role, 'service');
  });

  it('with optional: true allows missing auth', async () => {
    const mw = createAuthMiddleware({ optional: true });
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200); // not 401
  });
});
