/**
 * Tests for Windy Chat — Agent/Bot Provisioning
 *
 * Run: node --test tests/unit/test-agent-provision.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.CHAT_API_TOKEN = 'test-agent-token';
process.env.CHAT_SERVICE_TOKEN = 'test-service-token';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

const { app } = require('../../services/onboarding/server');
const onboardingDb = require('../../services/onboarding/lib/db');

let server;
let baseUrl;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
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

before(() => new Promise((resolve) => {
  // Clean test data from prior runs
  onboardingDb.db.exec("DELETE FROM onboarding_state WHERE passport_id LIKE 'ET-PROV-%'");
  onboardingDb.db.exec("DELETE FROM agent_rooms WHERE agent_name LIKE '%Bot%'");
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
}));

// ── Auth ──

describe('POST /api/v1/onboarding/agent — auth', () => {
  it('rejects missing authorization', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-001',
      agent_name: 'TestBot',
      owner_windy_identity_id: 'owner-123',
    });
    assert.equal(res.status, 401);
  });

  it('rejects invalid service token', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-001',
      agent_name: 'TestBot',
      owner_windy_identity_id: 'owner-123',
    }, { Authorization: 'Bearer wrong-token' });
    assert.equal(res.status, 403);
  });
});

// ── Validation ──

describe('POST /api/v1/onboarding/agent — validation', () => {
  const auth = { Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}` };

  it('rejects missing passport_number', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      agent_name: 'TestBot',
      owner_windy_identity_id: 'owner-123',
    }, auth);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /passport_number/);
  });

  it('rejects missing agent_name', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-001',
      owner_windy_identity_id: 'owner-123',
    }, auth);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /agent_name/);
  });

  it('rejects missing owner_windy_identity_id', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-001',
      agent_name: 'TestBot',
    }, auth);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /owner_windy_identity_id/);
  });

  it('rejects overly long passport_number', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'A'.repeat(256),
      agent_name: 'TestBot',
      owner_windy_identity_id: 'owner-123',
    }, auth);
    assert.equal(res.status, 400);
  });

  it('rejects overly long agent_name', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-001',
      agent_name: 'A'.repeat(101),
      owner_windy_identity_id: 'owner-123',
    }, auth);
    assert.equal(res.status, 400);
  });
});

// ── Provisioning ──

describe('POST /api/v1/onboarding/agent — provisioning', () => {
  const auth = { Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}` };

  it('provisions a new agent in dev mode', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-PROV-001',
      agent_name: 'ProvisionBot',
      owner_windy_identity_id: 'owner-prov-001',
    }, auth);
    assert.equal(res.status, 201);
    assert.ok(res.body.matrix_user_id);
    assert.ok(res.body.access_token);
    assert.ok(res.body.dm_room_id);
    assert.equal(res.body.agent_name, 'ProvisionBot');
    assert.equal(res.body.passport_number, 'ET-PROV-001');
    assert.match(res.body.matrix_user_id, /^@agent_et-prov-001:chat\.windypro\.com$/);
  });

  it('returns existing provisioning for duplicate passport', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-PROV-001',
      agent_name: 'ProvisionBot',
      owner_windy_identity_id: 'owner-prov-001',
    }, auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.already_provisioned, true);
    assert.ok(res.body.matrix_user_id);
  });

  it('provisions a second agent with different passport', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-PROV-002',
      agent_name: 'SecondBot',
      owner_windy_identity_id: 'owner-prov-001',
    }, auth);
    assert.equal(res.status, 201);
    assert.match(res.body.matrix_user_id, /agent_et-prov-002/);
  });

  it('strips HTML from agent name', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-PROV-003',
      agent_name: '<script>alert("xss")</script>EvilBot',
      owner_windy_identity_id: 'owner-prov-001',
    }, auth);
    assert.equal(res.status, 201);
    assert.equal(res.body.agent_name, 'alert("xss")EvilBot');
    assert.ok(!res.body.agent_name.includes('<script>'));
  });
});
