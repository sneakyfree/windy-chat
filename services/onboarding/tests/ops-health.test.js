/**
 * Ops fleet-health aggregator (ADR-060 / MULTI-SERVICE-OPS) tests.
 *
 * Spins up stub fleet members on ephemeral ports (one healthy, one degraded,
 * one Synapse-shaped, one dead) and drives GET /api/v1/ops/health end-to-end:
 * auth gate (structured 401s), fan-out statuses, version/commit merge,
 * whitelist scrubbing, and the synapse-down ⇒ overall-down rule.
 *
 * node:test style (like health.test.js): run with
 *   node --test tests/ops-health.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'test-secret-ci-only';
process.env.SYNAPSE_REGISTRATION_SECRET = 'test-reg-secret';
process.env.CHAT_API_TOKEN = 'test-service-token';
process.env.WINDY_OPS_PROBE_TIMEOUT_MS = '1000';

const jwt = require('jsonwebtoken');

let server;
let baseURL;
let healthyStub;
let degradedStub;
let synapseStub;
let deadPort;

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function stubUrl(srv) {
  return `http://127.0.0.1:${srv.address().port}`;
}

function userToken() {
  return jwt.sign({ sub: 'grant-test' }, process.env.WINDY_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
}

function opsFleet(overrides = {}) {
  return JSON.stringify({
    synapse: stubUrl(synapseStub),
    healthy: stubUrl(healthyStub),
    degraded: stubUrl(degradedStub),
    dead: `http://127.0.0.1:${deadPort}`,
    ...overrides,
  });
}

before(async () => {
  // Healthy fleet member — /health deliberately includes a content-like
  // field that the aggregator's whitelist must NOT forward.
  healthyStub = await listen((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        service: 'stub-healthy',
        status: 'ok',
        version: '1.0.0',
        uptime: '2h 3m 4s',
        dependencies: { db: true, redis: 'configured', nested: { drop: 'me' } },
        last_message_body: 'SECRET-CONTENT-MUST-NOT-LEAK',
      }));
    } else if (req.url === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        service: 'stub-healthy',
        version: '1.2.3',
        commit_sha_short: 'abc1234',
        environment: 'test',
      }));
    } else {
      res.writeHead(404).end();
    }
  });

  degradedStub = await listen((req, res) => {
    if (req.url === '/health') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'stub-degraded', status: 'degraded', version: '0.9.0' }));
    } else {
      res.writeHead(404).end();
    }
  });

  // Synapse serves plain-text /health and no /version.
  synapseStub = await listen((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404).end();
    }
  });

  // A port that was ours, then closed — connection refused, deterministic.
  const dead = await listen(() => {});
  deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));

  process.env.WINDY_OPS_FLEET = opsFleet();

  const { app } = require('../server');
  server = app.listen(0);
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const srv of [server, healthyStub, degradedStub, synapseStub]) {
    if (srv) srv.close();
  }
});

test('401 without Authorization — structured, names the remediation', async () => {
  const res = await fetch(`${baseURL}/api/v1/ops/health`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.error, 'missing_authorization');
  assert.match(body.remediation, /Eternitas passport/);
  assert.match(body.remediation, /account JWT/);
});

test('401 on garbage token — structured, names the remediation', async () => {
  const res = await fetch(`${baseURL}/api/v1/ops/health`, {
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'invalid_token');
  assert.match(body.remediation, /Eternitas passport/);
});

test('aggregates the constellation: up / degraded / down + versions', async () => {
  process.env.WINDY_OPS_FLEET = opsFleet();
  const res = await fetch(`${baseURL}/api/v1/ops/health`, {
    headers: { authorization: `Bearer ${userToken()}` },
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.strictEqual(body.service, 'windy-chat');
  assert.strictEqual(body.status, 'degraded'); // dead + degraded members, synapse up
  assert.strictEqual(body.summary.total, 4);
  assert.strictEqual(body.summary.up, 2);
  assert.strictEqual(body.summary.degraded, 1);
  assert.strictEqual(body.summary.down, 1);

  assert.strictEqual(body.services.synapse.status, 'up');
  assert.strictEqual(body.services.healthy.status, 'up');
  assert.strictEqual(body.services.healthy.version, '1.2.3'); // /version wins over /health
  assert.strictEqual(body.services.healthy.commit, 'abc1234');
  assert.strictEqual(body.services.healthy.uptime, '2h 3m 4s');
  assert.deepStrictEqual(body.services.healthy.dependencies, { db: true, redis: 'configured' });
  assert.strictEqual(body.services.degraded.status, 'degraded');
  assert.strictEqual(body.services.degraded.version, '0.9.0');
  assert.strictEqual(body.services.dead.status, 'down');
  assert.ok(body.services.dead.error, 'down member carries an error string');
});

test('whitelist scrub: content-like health fields never forwarded', async () => {
  process.env.WINDY_OPS_FLEET = opsFleet();
  const res = await fetch(`${baseURL}/api/v1/ops/health`, {
    headers: { authorization: `Bearer ${userToken()}` },
  });
  const raw = JSON.stringify(await res.json());
  assert.ok(!raw.includes('SECRET-CONTENT-MUST-NOT-LEAK'), 'content field scrubbed');
  assert.ok(!raw.includes('last_message_body'), 'content key scrubbed');
  assert.ok(!raw.includes('drop'), 'non-primitive dependency values dropped');
});

test('synapse down ⇒ overall status is down (the heart rule)', async () => {
  process.env.WINDY_OPS_FLEET = opsFleet({ synapse: `http://127.0.0.1:${deadPort}` });
  const res = await fetch(`${baseURL}/api/v1/ops/health`, {
    headers: { authorization: `Bearer ${userToken()}` },
  });
  const body = await res.json();
  assert.strictEqual(body.status, 'down');
  assert.strictEqual(body.services.synapse.status, 'down');
});

test('service token (CHAT_API_TOKEN) is accepted', async () => {
  process.env.WINDY_OPS_FLEET = opsFleet();
  const res = await fetch(`${baseURL}/api/v1/ops/health`, {
    headers: { authorization: 'Bearer test-service-token' },
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.service, 'windy-chat');
});

test('all healthy ⇒ overall ok', async () => {
  process.env.WINDY_OPS_FLEET = JSON.stringify({
    synapse: stubUrl(synapseStub),
    healthy: stubUrl(healthyStub),
  });
  const res = await fetch(`${baseURL}/api/v1/ops/health`, {
    headers: { authorization: `Bearer ${userToken()}` },
  });
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.summary.up, 2);
});
