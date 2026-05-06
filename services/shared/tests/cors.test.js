/**
 * Unit tests for services/shared/cors.js — pins the Wave 13 Phase 4 P1-1 fix.
 *
 * Run with:  node --test services/shared/tests/cors.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createCorsMiddleware,
  createCorsOptions,
  getAllowedOrigins,
  isOriginAllowed,
  DEFAULT_ORIGINS,
} = require('../cors');

// ── helpers ────────────────────────────────────────────────────────────

function mockReqRes(overrides = {}) {
  const headersSent = {};
  const res = {
    _status: 200,
    _headers: headersSent,
    _body: undefined,
    _ended: false,
    setHeader(k, v) { headersSent[k.toLowerCase()] = v; },
    getHeader(k) { return headersSent[k.toLowerCase()]; },
    status(c) { this._status = c; return this; },
    json(body) { this._body = body; this._ended = true; return this; },
    end() { this._ended = true; return this; },
  };
  const req = {
    method: 'GET',
    headers: {},
    ...overrides,
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return {
    req,
    res,
    next,
    get nextCalled() { return nextCalled; },
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── isOriginAllowed ────────────────────────────────────────────────────

test('isOriginAllowed: no origin is allowed (server-to-server)', () => {
  assert.equal(isOriginAllowed(undefined), true);
  assert.equal(isOriginAllowed(''), true);
});

test('isOriginAllowed: prod domain chat.windychat.ai is in DEFAULT_ORIGINS', () => {
  assert.ok(DEFAULT_ORIGINS.includes('https://chat.windychat.ai'));
  assert.equal(isOriginAllowed('https://chat.windychat.ai'), true);
});

test('isOriginAllowed: windychat.ai apex (no subdomain) is allowed', () => {
  assert.equal(isOriginAllowed('https://windychat.ai'), true);
});

test('isOriginAllowed: every sibling product apex is allowed', () => {
  const apexes = [
    'https://mail.windymail.ai',
    'https://windyclone.ai',
    'https://windyfly.ai',
    'https://windycode.org',
    'https://cloud.windycloud.com',
    'https://eternitas.ai',
    'https://windyword.ai',
  ];
  for (const origin of apexes) {
    assert.equal(isOriginAllowed(origin), true, origin);
  }
});

test('isOriginAllowed: attacker origin is rejected', () => {
  assert.equal(isOriginAllowed('https://attacker.example'), false);
  assert.equal(isOriginAllowed('https://evil.chat.windychat.ai.attacker.example'), false);
});

test('isOriginAllowed: localhost allowed in non-production only', () => {
  withEnv({ NODE_ENV: 'development' }, () => {
    assert.equal(isOriginAllowed('http://localhost:5173'), true);
    assert.equal(isOriginAllowed('http://localhost:9999'), true);
  });
  withEnv({ NODE_ENV: 'production' }, () => {
    // 5173 and 4173 are in DEFAULT_ORIGINS anyway (dev vite), so use 9999.
    assert.equal(isOriginAllowed('http://localhost:9999'), false);
  });
});

test('getAllowedOrigins honours CORS_ALLOWED_ORIGINS env var', () => {
  withEnv(
    { CORS_ALLOWED_ORIGINS: 'https://extra.example, https://another.example' },
    () => {
      const list = getAllowedOrigins();
      assert.ok(list.includes('https://extra.example'));
      assert.ok(list.includes('https://another.example'));
      assert.ok(list.includes('https://chat.windychat.ai'));  // defaults kept
    },
  );
});

// ── createCorsMiddleware — allowed origins ─────────────────────────────

test('middleware: no Origin header → next() called, no CORS headers set', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes();
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, true);
  assert.equal(ctx.res._headers['access-control-allow-origin'], undefined);
});

test('middleware: allowed prod origin → ACAO echoes origin, next() called', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes({ headers: { origin: 'https://chat.windychat.ai' } });
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, true);
  assert.equal(
    ctx.res._headers['access-control-allow-origin'],
    'https://chat.windychat.ai',
  );
  assert.equal(ctx.res._headers['access-control-allow-credentials'], 'true');
  assert.equal(ctx.res._headers['vary'], 'Origin');
});

test('middleware: windychat.ai apex still allowed', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes({ headers: { origin: 'https://windychat.ai' } });
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, true);
  assert.equal(
    ctx.res._headers['access-control-allow-origin'],
    'https://windychat.ai',
  );
});

// ── createCorsMiddleware — disallowed origins ──────────────────────────

test('middleware: disallowed origin → 403 JSON envelope, NO ACAO, next() NOT called', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes({ headers: { origin: 'https://attacker.example' } });
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, false);
  assert.equal(ctx.res._status, 403);
  assert.deepEqual(ctx.res._body, {
    error: 'Origin not allowed',
    code: 'CORS_ORIGIN_DENIED',
  });
  // Critical: disallowed origin must NOT get ACAO.
  assert.equal(ctx.res._headers['access-control-allow-origin'], undefined);
});

test('middleware: never throws — no 500 cascade even on hostile input', () => {
  const mw = createCorsMiddleware();
  const inputs = [
    'null',
    'file://',
    'https://',
    'https://a.b.c.d.e.f.g.h',
    'https://attacker.example',
    'http://localhost:9999',  // prod blocks non-allowlisted localhost
  ];
  withEnv({ NODE_ENV: 'production' }, () => {
    for (const origin of inputs) {
      const ctx = mockReqRes({ headers: { origin } });
      // Wrap in assert.doesNotThrow to pin the invariant.
      assert.doesNotThrow(() => mw(ctx.req, ctx.res, ctx.next), origin);
      assert.equal(ctx.res._status, 403, origin);
    }
  });
});

// ── OPTIONS preflight ──────────────────────────────────────────────────

test('middleware: OPTIONS preflight from allowed origin → 204 + headers', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes({
    method: 'OPTIONS',
    headers: {
      origin: 'https://chat.windychat.ai',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'Authorization,Content-Type',
    },
  });
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, false);  // preflight short-circuits
  assert.equal(ctx.res._status, 204);
  assert.equal(ctx.res._ended, true);
  assert.equal(
    ctx.res._headers['access-control-allow-origin'],
    'https://chat.windychat.ai',
  );
  assert.equal(ctx.res._headers['access-control-allow-methods'], 'POST');
  assert.equal(
    ctx.res._headers['access-control-allow-headers'],
    'Authorization,Content-Type',
  );
  assert.equal(ctx.res._headers['access-control-max-age'], '600');
});

test('middleware: OPTIONS preflight from disallowed origin → 403 JSON', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes({
    method: 'OPTIONS',
    headers: {
      origin: 'https://attacker.example',
      'access-control-request-method': 'POST',
    },
  });
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.nextCalled, false);
  assert.equal(ctx.res._status, 403);
  assert.deepEqual(ctx.res._body, {
    error: 'Origin not allowed',
    code: 'CORS_ORIGIN_DENIED',
  });
});

// ── createCorsOptions legacy surface ───────────────────────────────────

test('createCorsOptions: disallowed miss path resolves (null, false) — never throws', () => {
  const opts = createCorsOptions();
  let captured;
  opts.origin('https://attacker.example', (err, allow) => {
    captured = { err, allow };
  });
  assert.equal(captured.err, null);
  assert.equal(captured.allow, false);
});

test('createCorsOptions: allowed prod origin resolves (null, true)', () => {
  const opts = createCorsOptions();
  let captured;
  opts.origin('https://chat.windychat.ai', (err, allow) => {
    captured = { err, allow };
  });
  assert.equal(captured.err, null);
  assert.equal(captured.allow, true);
});

test('createCorsOptions: credentials: true is preserved', () => {
  const opts = createCorsOptions();
  assert.equal(opts.credentials, true);
});

test('createCorsOptions: no-origin (server-to-server) is allowed', () => {
  const opts = createCorsOptions();
  let captured;
  opts.origin(undefined, (err, allow) => { captured = { err, allow }; });
  assert.equal(captured.allow, true);
});

// ── Vary header stacking ───────────────────────────────────────────────

test('middleware: preserves pre-existing Vary header and appends Origin', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes({ headers: { origin: 'https://chat.windychat.ai' } });
  ctx.res.setHeader('Vary', 'Authorization');
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.res._headers['vary'], 'Authorization, Origin');
});

test('middleware: does not duplicate Origin in Vary', () => {
  const mw = createCorsMiddleware();
  const ctx = mockReqRes({ headers: { origin: 'https://chat.windychat.ai' } });
  ctx.res.setHeader('Vary', 'Origin');
  mw(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.res._headers['vary'], 'Origin');
});
