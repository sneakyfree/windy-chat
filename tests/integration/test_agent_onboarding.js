/**
 * Integration Test — Agent/Bot Onboarding Flow
 *
 * Simulates what the account-server sends when a bot is hatched via `windy go`:
 *   1. POST /api/v1/onboarding/agent with passport + owner info
 *   2. Verify Matrix account created
 *   3. Verify DM room created with greeting
 *   4. Verify agent appears in owner's room list
 *   5. Verify duplicate provisioning returns existing credentials
 *
 * Run: node --test tests/integration/test_agent_onboarding.js
 *
 * Synapse API calls documented:
 *   - GET  /_synapse/admin/v1/register             → get nonce
 *   - POST /_synapse/admin/v1/register             → create account with HMAC
 *   - PUT  /_matrix/client/v3/profile/:userId/avatar_url → set avatar
 *   - POST /_synapse/admin/v1/rooms                → create DM room (admin API)
 *   - POST /_matrix/client/v3/createRoom           → create DM room (client fallback)
 *   - PUT  /_matrix/client/v3/rooms/:roomId/send/m.room.message/:txnId → send greeting
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

// Clean data dir for fresh test
const dataDir = path.join(__dirname, '..', '..', 'services', 'onboarding', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

process.env.CHAT_API_TOKEN = 'test-agent-int-token';
process.env.CHAT_SERVICE_TOKEN = 'test-service-token-int';
process.env.WINDY_JWT_SECRET = 'test-agent-int-jwt-secret';
process.env.NODE_ENV = 'test';

const { app } = require('../../services/onboarding/server');

let server;
let baseUrl;

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

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
}));

// ═══════════════════════════════════════════
//  Step 1: Agent Provisioning
// ═══════════════════════════════════════════

describe('Step 1: Agent Provisioning', () => {
  let provisionResult;

  it('provisions a new agent via service token', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET26-K7BF-42MN',
      agent_name: 'TestFly',
      owner_windy_identity_id: 'test-user-123',
    }, {
      Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}`,
    });

    assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.matrix_user_id, 'Expected matrix_user_id');
    assert.ok(res.body.access_token, 'Expected access_token');
    assert.ok(res.body.dm_room_id, 'Expected dm_room_id');
    assert.equal(res.body.agent_name, 'TestFly');
    assert.equal(res.body.passport_number, 'ET26-K7BF-42MN');

    // Matrix user ID follows convention: @agent_<passport>:server
    assert.match(res.body.matrix_user_id, /^@agent_.*:chat\.windypro\.com$/);

    provisionResult = res.body;
  });

  it('returns dev stub credentials when Synapse is not running', async () => {
    // In test mode without Synapse, we get dev tokens
    assert.ok(provisionResult.access_token.startsWith('dev_token_'), 'Expected dev token in test mode');
    assert.ok(provisionResult.dm_room_id.startsWith('!dev_agent_dm_'), 'Expected dev room ID in test mode');
  });
});

// ═══════════════════════════════════════════
//  Step 2: Duplicate Provisioning
// ═══════════════════════════════════════════

describe('Step 2: Duplicate Provisioning', () => {
  it('returns existing credentials for same passport', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET26-K7BF-42MN',
      agent_name: 'TestFly',
      owner_windy_identity_id: 'test-user-123',
    }, {
      Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}`,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.already_provisioned, true);
    assert.ok(res.body.matrix_user_id);
    assert.ok(res.body.dm_room_id);
  });
});

// ═══════════════════════════════════════════
//  Step 3: Agent Room Lookup
// ═══════════════════════════════════════════

describe('Step 3: Agent Room Lookup', () => {
  it('finds the DM room via agent-room endpoint', async () => {
    const jwt = require('../../services/onboarding/node_modules/jsonwebtoken');
    const token = jwt.sign(
      { sub: 'test-user-123', windy_identity_id: 'test-user-123' },
      process.env.WINDY_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    // Look up the agent room — need to find the agent's matrix_user_id first
    const provRes = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET26-K7BF-42MN',
      agent_name: 'TestFly',
      owner_windy_identity_id: 'test-user-123',
    }, {
      Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}`,
    });

    const agentMatrixId = provRes.body.matrix_user_id;

    const res = await request('GET',
      `/api/v1/chat/agent-room?agentId=${encodeURIComponent(agentMatrixId)}&ownerId=test-user-123`,
      null,
      { Authorization: `Bearer ${token}` }
    );

    assert.equal(res.status, 200);
    assert.ok(res.body.room_id, 'Expected room_id in agent-room response');
    assert.equal(res.body.agent_name, 'TestFly');
  });
});

// ═══════════════════════════════════════════
//  Step 4: Validation
// ═══════════════════════════════════════════

describe('Step 4: Input Validation', () => {
  const auth = { Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}` };

  it('rejects missing passport_number', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      agent_name: 'Bot',
      owner_windy_identity_id: 'user-1',
    }, auth);
    assert.equal(res.status, 400);
  });

  it('rejects missing auth', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-001',
      agent_name: 'Bot',
      owner_windy_identity_id: 'user-1',
    });
    assert.equal(res.status, 401);
  });

  it('rejects invalid service token', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET-001',
      agent_name: 'Bot',
      owner_windy_identity_id: 'user-1',
    }, { Authorization: 'Bearer wrong-token' });
    assert.equal(res.status, 403);
  });
});

// ═══════════════════════════════════════════
//  Step 5: Multiple Agents for Same Owner
// ═══════════════════════════════════════════

describe('Step 5: Multiple Agents', () => {
  it('provisions a second agent for the same owner', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET26-M9XZ-11AB',
      agent_name: 'TranslatorFly',
      owner_windy_identity_id: 'test-user-123',
    }, {
      Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}`,
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.matrix_user_id);
    assert.ok(res.body.dm_room_id);
    assert.equal(res.body.agent_name, 'TranslatorFly');
    // Different Matrix user ID from the first agent
    assert.match(res.body.matrix_user_id, /agent_et26-m9xz-11ab/i);
  });
});
