/**
 * Tests for the blacklist-aware token check (launch P0: logged-out Pro
 * tokens were honored for their full 15-min TTL at Chat).
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  ensureTokenActive,
  resetCache,
  TokenRevokedError,
  RevocationUnavailableError,
} = require('../token-revocation');

function fetchReturning(status, calls) {
  return async (url, opts) => {
    if (calls) calls.push({ url, opts });
    return { status };
  };
}

function fetchThrowing() {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test.beforeEach(() => resetCache());

// ---- verdict mapping --------------------------------------------------

test('active token passes and forwards the bearer', async () => {
  const calls = [];
  await ensureTokenActive('tok-active', { fetchImpl: fetchReturning(200, calls) });
  assert.ok(calls[0].url.endsWith('/api/v1/identity/validate-token'));
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok-active');
});

test('revoked token throws TokenRevokedError', async () => {
  await assert.rejects(
    ensureTokenActive('tok-revoked', { fetchImpl: fetchReturning(401) }),
    TokenRevokedError
  );
});

test('404 (no identity row) treated as active', async () => {
  await ensureTokenActive('tok-agent', { fetchImpl: fetchReturning(404) });
});

// ---- caching ------------------------------------------------------------

test('positive verdict cached within TTL', async () => {
  const calls = [];
  const fetchImpl = fetchReturning(200, calls);
  await ensureTokenActive('tok-cached', { fetchImpl });
  await ensureTokenActive('tok-cached', { fetchImpl });
  assert.strictEqual(calls.length, 1);
});

test('negative verdict cached within TTL', async () => {
  const calls = [];
  const fetchImpl = fetchReturning(401, calls);
  await assert.rejects(ensureTokenActive('tok-dead', { fetchImpl }), TokenRevokedError);
  await assert.rejects(ensureTokenActive('tok-dead', { fetchImpl }), TokenRevokedError);
  assert.strictEqual(calls.length, 1);
});

// ---- failure semantics ----------------------------------------------------

test('unreachable with no cache fails CLOSED in production', async () => {
  await withEnv({ NODE_ENV: 'production' }, async () => {
    await assert.rejects(
      ensureTokenActive('tok-cold', { fetchImpl: fetchThrowing() }),
      RevocationUnavailableError
    );
  });
});

test('unreachable with fresh-ish positive serves stale grace in production', async () => {
  await withEnv(
    { NODE_ENV: 'production', IDENTITY_VALIDATE_TTL_SECONDS: '0' },
    async () => {
      // TTL=0 forces revalidation on the second call while the entry is
      // still well inside the 300s stale allowance.
      await ensureTokenActive('tok-grace', { fetchImpl: fetchReturning(200) });
      await ensureTokenActive('tok-grace', { fetchImpl: fetchThrowing() }); // no throw
    }
  );
});

test('unreachable past max-stale fails CLOSED in production', async () => {
  await withEnv(
    {
      NODE_ENV: 'production',
      IDENTITY_VALIDATE_TTL_SECONDS: '0',
      IDENTITY_VALIDATE_MAX_STALE_SECONDS: '0',
    },
    async () => {
      await ensureTokenActive('tok-too-stale', { fetchImpl: fetchReturning(200) });
      await assert.rejects(
        ensureTokenActive('tok-too-stale', { fetchImpl: fetchThrowing() }),
        RevocationUnavailableError
      );
    }
  );
});

test('unreachable fails OPEN outside production', async () => {
  await withEnv({ NODE_ENV: 'test' }, async () => {
    await ensureTokenActive('tok-dev', { fetchImpl: fetchThrowing() }); // no throw
  });
});

test('5xx from the authority treated as outage (fail closed in prod)', async () => {
  await withEnv({ NODE_ENV: 'production' }, async () => {
    await assert.rejects(
      ensureTokenActive('tok-5xx', { fetchImpl: fetchReturning(500) }),
      RevocationUnavailableError
    );
  });
});

test('kill-switch disables the check entirely', async () => {
  await withEnv({ IDENTITY_VALIDATE_ENABLED: 'false' }, async () => {
    await ensureTokenActive('tok-disabled', { fetchImpl: fetchThrowing() }); // no call, no throw
  });
});
