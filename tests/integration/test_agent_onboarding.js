/**
 * Integration Test — Agent/Bot Onboarding Flow
 *
 * Simulates what the account-server sends when a bot is hatched via `windy go`:
 *   1. POST /api/v1/onboarding/agent with passport + owner info
 *   2. Verify Matrix account created
 *   3. Verify DM room is created the moment the owner signs into Chat
 *      (Wave 8 Grandma Ribbon — previously room creation was eager with
 *      a guessed owner Matrix ID; now it's deferred until the owner has
 *      a real account)
 *   4. Verify duplicate provisioning returns existing credentials
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
process.env.WINDY_IDENTITY_WEBHOOK_SECRET = 'test-identity-webhook-secret';
process.env.PUSH_BUS_URL = ''; // disable outbound push from Wave 8 hook
process.env.SYNAPSE_URL = 'http://127.0.0.1:1'; // unreachable → stub DM
process.env.NODE_ENV = 'test';

const { app } = require('../../services/onboarding/server');
const crypto = require('node:crypto');

let server;
let baseUrl;

function signIdentityWebhook(bodyStr) {
  return crypto
    .createHmac('sha256', process.env.WINDY_IDENTITY_WEBHOOK_SECRET)
    .update(bodyStr)
    .digest('hex');
}

async function provisionOwnerViaWebhook(windyIdentityId, firstName, lastName) {
  const payload = {
    windy_identity_id: windyIdentityId,
    first_name: firstName,
    last_name: lastName,
    display_name: `${firstName} ${lastName}`,
  };
  const sig = signIdentityWebhook(JSON.stringify(payload));
  return request('POST', '/api/v1/webhooks/identity/created', payload, {
    'x-windy-signature': sig,
  });
}

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

  it('provisions a new agent via service token (owner not in Chat → DM deferred)', async () => {
    // Wave 8 Grandma Ribbon: when the owner has no Chat account yet, the
    // agent's DM room is NOT created eagerly against a guessed Matrix
    // ID. Instead the credentials are parked and the room is created
    // the moment the owner first lands in Chat.
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
    assert.equal(res.body.dm_room_id, null, 'Wave 8: DM deferred until owner first-login');
    assert.equal(res.body.welcome_pending, true, 'Wave 8: welcome_pending=true flags the deferred DM');
    assert.equal(res.body.agent_name, 'TestFly');
    assert.equal(res.body.passport_number, 'ET26-K7BF-42MN');

    // Matrix user ID follows convention: @agent_<passport>:server
    assert.match(res.body.matrix_user_id, /^@agent_.*:chat\.windychat\.ai$/);

    provisionResult = res.body;
  });

  it('returns dev stub credentials when Synapse is not running', async () => {
    // In test mode without Synapse, we get dev tokens
    assert.ok(provisionResult.access_token.startsWith('dev_token_'), 'Expected dev token in test mode');
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
    // dm_room_id stays null until the owner logs in — Wave 8 contract.
    // The replay returns whatever was previously persisted (still null here).
  });
});

// ═══════════════════════════════════════════
//  Step 3: Agent Room Lookup (after owner first-login)
// ═══════════════════════════════════════════

describe('Step 3: Agent Room Lookup (owner first-login flushes deferred DM)', () => {
  // Separate owner — Step 1 intentionally left test-user-123 without a
  // Chat account so we could verify the deferred contract. Here we
  // walk the full flow: hatch agent, then land the owner via the
  // identity/created webhook, and confirm the agent-room endpoint
  // resolves the newly-created DM.
  const ownerId = 'test-user-456';
  const agentPassport = 'ET26-K7BF-STEP3';

  it('hatches an agent for a fresh owner', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: agentPassport,
      agent_name: 'LookupFly',
      owner_windy_identity_id: ownerId,
    }, {
      Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}`,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.welcome_pending, true);
  });

  it('owner first-login (via identity/created) seeds the DM', async () => {
    const res = await provisionOwnerViaWebhook(ownerId, 'Lookup', 'Owner');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'provisioned');
    assert.ok(Array.isArray(res.body.seeded_agent_rooms), 'seeded_agent_rooms should be an array');
    assert.equal(res.body.seeded_agent_rooms.length, 1, 'one deferred agent flushed');
    assert.ok(res.body.seeded_agent_rooms[0].room_id, 'seeded room_id present');
  });

  it('finds the DM room via agent-room endpoint', async () => {
    const jwt = require('../../services/onboarding/node_modules/jsonwebtoken');
    const token = jwt.sign(
      { sub: ownerId, windy_identity_id: ownerId },
      process.env.WINDY_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const agentMatrixId = `@agent_${agentPassport.replace(/[^a-z0-9_-]/gi, '').toLowerCase()}:chat.windychat.ai`;

    const res = await request('GET',
      `/api/v1/chat/agent-room?agentId=${encodeURIComponent(agentMatrixId)}&ownerId=${encodeURIComponent(ownerId)}`,
      null,
      { Authorization: `Bearer ${token}` }
    );

    assert.equal(res.status, 200);
    assert.ok(res.body.room_id, 'Expected room_id in agent-room response');
    assert.equal(res.body.agent_name, 'LookupFly');
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
  // Same fresh owner as Step 3 — they've logged in, so a second agent
  // hatching now should create the DM immediately (not defer).
  it('provisions a second agent for an owner who is already in Chat', async () => {
    const res = await request('POST', '/api/v1/onboarding/agent', {
      passport_number: 'ET26-M9XZ-11AB',
      agent_name: 'TranslatorFly',
      owner_windy_identity_id: 'test-user-456',
    }, {
      Authorization: `Bearer ${process.env.CHAT_SERVICE_TOKEN}`,
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.matrix_user_id);
    // Owner is in Chat now → DM created eagerly, welcome_pending=false.
    assert.ok(res.body.dm_room_id, 'DM created immediately when owner exists');
    assert.equal(res.body.welcome_pending, false);
    assert.equal(res.body.agent_name, 'TranslatorFly');
    assert.match(res.body.matrix_user_id, /agent_et26-m9xz-11ab/i);
  });
});
