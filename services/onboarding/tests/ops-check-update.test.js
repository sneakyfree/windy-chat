/**
 * check_for_update (Steamroller, ADR-060 §5) — GET /api/v1/ops/check-update.
 * Resolves the onboarding service version against admin's fleet-version
 * manifest. fetch is mocked BY URL so the test's own requests to baseURL
 * still reach the real server.
 *
 * node:test — run with: node --test tests/ops-check-update.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'test-secret-ci-only';
process.env.SYNAPSE_REGISTRATION_SECRET = 'test-reg-secret';
process.env.CHAT_API_TOKEN = 'test-service-token';

const { app } = require('../server');
const pkgVersion = require('../package.json').version;

let server;
let baseURL;
const AUTH = { authorization: 'Bearer test-service-token' };

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

function withFleet(manifestOrError, fn) {
  return async () => {
    const orig = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('/v1/fleet-versions')) {
        if (manifestOrError instanceof Error) throw manifestOrError;
        return { status: 200, json: async () => manifestOrError };
      }
      return orig(url, opts);
    };
    try { await fn(orig); } finally { global.fetch = orig; }
  };
}

function fleetDoc(current, minimum) {
  const stable = { current, kind: 'image', source: 'windy-chat', notes: 't' };
  if (minimum) stable.minimum = minimum;
  return { schema_version: 'fleet-version.v1', products: { 'windy-chat': { channels: { stable } } } };
}

test('check-update requires auth', async () => {
  const res = await fetch(`${baseURL}/api/v1/ops/check-update`);
  assert.strictEqual(res.status, 401);
});

test('check-update current when fleet == running version', withFleet(fleetDoc(pkgVersion), async (realFetch) => {
  const body = await (await realFetch(`${baseURL}/api/v1/ops/check-update`, { headers: AUTH })).json();
  assert.strictEqual(body.status, 'current');
  assert.ok(!('remediation' in body));
}));

test('check-update update-available with remediation', withFleet(fleetDoc('99.0.0'), async (realFetch) => {
  const body = await (await realFetch(`${baseURL}/api/v1/ops/check-update`, { headers: AUTH })).json();
  assert.strictEqual(body.status, 'update-available');
  assert.match(body.remediation, /redeploy the affected Windy Chat service/);
}));

test('check-update must-update below minimum', withFleet(fleetDoc('99.0.0', '99.0.0'), async (realFetch) => {
  const body = await (await realFetch(`${baseURL}/api/v1/ops/check-update`, { headers: AUTH })).json();
  assert.strictEqual(body.status, 'must-update');
}));

test('check-update unreachable manifest is honest', withFleet(new Error('boom'), async (realFetch) => {
  const body = await (await realFetch(`${baseURL}/api/v1/ops/check-update`, { headers: AUTH })).json();
  assert.strictEqual(body.status, 'unknown');
  assert.match(body.detail, /unreachable/);
}));
