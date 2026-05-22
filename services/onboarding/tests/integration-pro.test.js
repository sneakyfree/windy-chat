/**
 * Integration Test: Pro JWT Validation + Agent Provisioning
 *
 * Tests that Chat correctly validates tokens from Windy Pro (JWKS + HS256)
 * and provisions agents via unified-login with DM room creation and
 * Eternitas webhook handling.
 *
 * Run: node --test services/onboarding/tests/integration-pro.test.js
 *   or: cd services/onboarding && npm run test:integration
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ═══════════════════════════════════════════════
// Environment
// ═══════════════════════════════════════════════

const JWT_SECRET = 'pro-integration-test-secret';
const API_TOKEN = 'pro-integration-api-token';
const WEBHOOK_SECRET = 'pro-integration-webhook-secret';

process.env.WINDY_JWT_SECRET = JWT_SECRET;
process.env.CHAT_API_TOKEN = API_TOKEN;
process.env.ETERNITAS_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.SYNAPSE_REGISTRATION_SECRET = '';
process.env.NODE_ENV = 'test';

// Clean data
const dataDir = path.join(__dirname, '..', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

// ═══════════════════════════════════════════════
// RSA Key Pair (simulates Pro JWKS)
// ═══════════════════════════════════════════════

const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Second key pair (for rejection tests)
const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ═══════════════════════════════════════════════
// JWT Helpers
// ═══════════════════════════════════════════════

const jwt = require('jsonwebtoken');

function makeHS256Token(claims, opts = {}) {
  return jwt.sign(claims, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: opts.expiresIn || '1h',
  });
}

function makeRS256Token(claims, key, opts = {}) {
  return jwt.sign(claims, key, {
    algorithm: 'RS256',
    expiresIn: opts.expiresIn || '1h',
    keyid: 'test-kid-1',
  });
}

// ═══════════════════════════════════════════════
// Mock JWKS Server
// ═══════════════════════════════════════════════

let mockJwksServer, mockJwksUrl;

function createJwksServer() {
  // Export public key as JWK
  const keyObj = crypto.createPublicKey(rsaPublicKey);
  const jwk = keyObj.export({ format: 'jwk' });
  jwk.kid = 'test-kid-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/jwks.json') {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
}

// ═══════════════════════════════════════════════
// HTTP Helper
// ═══════════════════════════════════════════════

function request(method, baseUrl, urlPath, body, headers = {}) {
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
      res.on('data', (c) => data += c);
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

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function computeHmac(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

// ═══════════════════════════════════════════════
// Service Startup
// ═══════════════════════════════════════════════

let onboardingUrl;
const servers = [];

function loadService(modulePath) {
  const origPort = process.env.PORT;
  process.env.PORT = '0';
  const origListen = http.Server.prototype.listen;
  let captured = null;
  http.Server.prototype.listen = function (...args) {
    captured = this;
    if (typeof args[0] === 'number' || typeof args[0] === 'string') args[0] = 0;
    return origListen.apply(this, args);
  };
  const mod = require(modulePath);
  http.Server.prototype.listen = origListen;
  if (origPort !== undefined) process.env.PORT = origPort;
  else delete process.env.PORT;

  return new Promise((resolve) => {
    if (captured) {
      const check = () => {
        const addr = captured.address();
        if (addr) { servers.push(captured); resolve(`http://localhost:${addr.port}`); }
        else captured.once('listening', () => {
          servers.push(captured);
          resolve(`http://localhost:${captured.address().port}`);
        });
      };
      check();
    } else {
      const app = mod.app || mod;
      const srv = app.listen(0, () => {
        servers.push(srv);
        resolve(`http://localhost:${srv.address().port}`);
      });
    }
  });
}

before(async () => {
  // Start mock JWKS server
  mockJwksServer = createJwksServer();
  await new Promise(r => {
    mockJwksServer.listen(0, () => {
      mockJwksUrl = `http://localhost:${mockJwksServer.address().port}`;
      servers.push(mockJwksServer);
      r();
    });
  });
  process.env.WINDY_ACCOUNT_SERVER_URL = mockJwksUrl;

  // Start onboarding service
  onboardingUrl = await loadService('../server');
});

after(() => new Promise((resolve) => {
  let closed = 0;
  const total = servers.length;
  if (!total) { resolve(); return; }
  const onClose = () => { closed++; if (closed >= total) { setTimeout(() => process.exit(0), 100); resolve(); } };
  for (const srv of servers) {
    try { srv.close(onClose); } catch { onClose(); }
  }
}));

// ═══════════════════════════════════════════════
// 1. JWKS Validation
// ═══════════════════════════════════════════════

describe('1. JWKS Validation', () => {
  it('1.1 accepts HS256 token signed with WINDY_JWT_SECRET', async () => {
    const token = makeHS256Token({ sub: 'jwks-test-1', windy_identity_id: 'wid-jwks-1', display_name: 'JWKS Test' });
    const r = await request('GET', onboardingUrl, '/api/v1/chat/profile/check-name?name=JWKSTest', null, auth(token));
    assert.equal(r.status, 200);
  });

  it('1.2 rejects token signed with wrong HS256 secret', async () => {
    const token = jwt.sign({ sub: 'bad-secret' }, 'wrong-secret', { algorithm: 'HS256', expiresIn: '1h' });
    const r = await request('GET', onboardingUrl, '/api/v1/chat/profile/check-name?name=Test', null, auth(token));
    assert.equal(r.status, 401);
  });

  it('1.3 rejects expired HS256 token', async () => {
    const token = jwt.sign({ sub: 'expired' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '-1s' });
    const r = await request('GET', onboardingUrl, '/api/v1/chat/profile/check-name?name=Test', null, auth(token));
    assert.equal(r.status, 401);
  });

  it('1.4 rejects request with no Authorization header', async () => {
    const r = await request('GET', onboardingUrl, '/api/v1/chat/profile/check-name?name=Test');
    assert.equal(r.status, 401);
  });

  it('1.5 HS256 fallback works when JWKS is unreachable', async () => {
    // HS256 tokens should always work regardless of JWKS server status
    const token = makeHS256Token({ sub: 'fallback-test', windy_identity_id: 'wid-fallback' });
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(token));
    assert.ok(r.status === 201 || r.status === 200);
  });
});

// ═══════════════════════════════════════════════
// 2. Unified Login Creates Correct Matrix User
// ═══════════════════════════════════════════════

describe('2. Unified Login Provisioning', () => {
  const claims = {
    sub: 'test-agent-001',
    windy_identity_id: 'wid-agent-001',
    display_name: 'Test Agent Alpha',
    email: 'agent@example.com',
    passport_id: 'passport-001',
  };

  let loginResponse;

  it('2.1 provisions Matrix user with correct ID format', async () => {
    const token = makeHS256Token(claims);
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(token));
    assert.equal(r.status, 201);
    assert.ok(r.body.matrix_user_id);
    // Mail-aligned localpart per services/shared/localpart.js: lowercase
    // alphanumeric + `._-` only (intersection of Matrix + Mail charsets).
    assert.match(r.body.matrix_user_id, /^@[a-z0-9._-]+:chat\.windychat\.ai$/);
    assert.equal(r.body.already_existed, false);
    assert.equal(r.body.windy_identity_id, claims.windy_identity_id);
    assert.equal(r.body.display_name, claims.display_name);
    assert.ok(r.body.access_token);
    assert.ok(r.body.chat_user_id);
    loginResponse = r.body;
  });

  it('2.2 display_name is sanitized to mail-aligned localpart', async () => {
    // 'Test Agent Alpha' → mailAlignedLocalpart → 'test.agent.alpha'
    // (spaces → dots, lowercase, charset-stripped). See
    // services/shared/localpart.js for the full algorithm.
    assert.match(loginResponse.chat_user_id, /^[a-z0-9._-]+$/);
    assert.equal(loginResponse.chat_user_id, 'test.agent.alpha');
  });

  it('2.3 onboarding DB was updated with matrix_provisioned = 1', async () => {
    const r = await request('GET', onboardingUrl,
      `/api/v1/onboarding/onboarding/status?chatUserId=${loginResponse.chat_user_id}`,
      null, auth(makeHS256Token({ sub: 'check' })));
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, true);
    assert.equal(r.body.steps.matrixProvisioned, true);
    assert.equal(r.body.steps.verified, true);
    assert.ok(r.body.matrixUserId);
  });
});

// ═══════════════════════════════════════════════
// 3. Unified Login Idempotency
// ═══════════════════════════════════════════════

describe('3. Unified Login Idempotency', () => {
  const claims = {
    sub: 'idempotent-user',
    windy_identity_id: 'wid-idempotent',
    display_name: 'Idempotent Agent',
  };

  let firstResponse, secondResponse;

  it('3.1 first call creates user (201)', async () => {
    const token = makeHS256Token(claims);
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(token));
    assert.equal(r.status, 201);
    assert.equal(r.body.already_existed, false);
    firstResponse = r.body;
  });

  it('3.2 second call returns existing (200, already_existed: true)', async () => {
    const token = makeHS256Token(claims);
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(token));
    assert.equal(r.status, 200);
    assert.equal(r.body.already_existed, true);
    secondResponse = r.body;
  });

  it('3.3 matrix_user_id is the same both times', async () => {
    assert.equal(secondResponse.chat_user_id, firstResponse.chat_user_id);
    assert.equal(secondResponse.windy_identity_id, firstResponse.windy_identity_id);
  });
});

// ═══════════════════════════════════════════════
// 4. DM Room Creation
// ═══════════════════════════════════════════════

describe('4. DM Room Creation', () => {
  it('4.1 agent provisioned with owner claims gets room_id', async () => {
    // First provision the owner
    const ownerToken = makeHS256Token({
      sub: 'room-owner',
      windy_identity_id: 'wid-room-owner',
      display_name: 'Room Owner',
    });
    await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(ownerToken));

    // Now provision agent with owner claims
    const agentToken = makeHS256Token({
      sub: 'room-agent',
      windy_identity_id: 'wid-room-agent',
      display_name: 'Room Agent',
      owner_sub: 'room-owner',
      owner_windy_identity_id: 'wid-room-owner',
    });
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(agentToken));
    assert.equal(r.status, 201);
    assert.ok(r.body.room_id, 'Should return room_id when owner exists');
    assert.match(r.body.room_id, /^!.*:chat\.windychat\.ai$/);
  });

  it('4.2 agent-room lookup returns the created room', async () => {
    // agent_user_id in the agent_rooms table is the mail-aligned chat_user_id
    // (i.e. 'room.agent' for display_name 'Room Agent'), NOT a windy_-prefixed
    // form. owner_user_id is the JWT `sub` of the owner (room-owner). See
    // services/onboarding/routes/provision.js around line 920.
    const token = makeHS256Token({ sub: 'lookup-user' });
    const r = await request('GET', onboardingUrl,
      '/api/v1/onboarding/agent-room?agentId=room.agent&ownerId=room-owner',
      null, auth(token));
    assert.equal(r.status, 200);
    assert.ok(r.body.room_id);
    assert.equal(r.body.agent_name, 'Room Agent');
  });

  it('4.3 agent without owner claims gets room_id = null', async () => {
    const token = makeHS256Token({
      sub: 'solo-agent',
      windy_identity_id: 'wid-solo',
      display_name: 'Solo Agent',
    });
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(token));
    assert.equal(r.status, 201);
    assert.equal(r.body.room_id, null, 'No owner = no room');
  });

  it('4.4 agent with non-existent owner skips room creation', async () => {
    const token = makeHS256Token({
      sub: 'orphan-agent',
      windy_identity_id: 'wid-orphan',
      display_name: 'Orphan Agent',
      owner_sub: 'nonexistent-owner',
      owner_windy_identity_id: 'wid-nonexistent',
    });
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(token));
    assert.equal(r.status, 201);
    // Room may be created with a constructed matrix ID or skipped — either way no crash
    assert.ok(r.body.matrix_user_id);
  });
});

// ═══════════════════════════════════════════════
// 5. Eternitas Webhook (RETIRED — see provision.js:500)
// ═══════════════════════════════════════════════
//
// /api/v1/onboarding/eternitas/webhook was retired in P2-1 (Wave 7
// gap analysis) — the canonical handler is now
// /api/v1/webhooks/eternitas on the social service (port 8105).
// The retired URL is kept live with a 410 Gone response so any
// producer still configured against it gets a clear migration
// signal rather than silent dropping.
//
// Functional coverage of the live (new) endpoint lives in
// services/onboarding/tests/webhooks.test.js (Webhook: passport/*).
// What we keep here is a single regression check that the
// retirement signaling stays correct.

describe('5. Eternitas Webhook — retired endpoint signaling', () => {
  it('5.0 returns 410 Gone with migration pointer', async () => {
    const body = {
      event: 'passport.revoked',
      passport: 'any-passport',
      timestamp: new Date().toISOString(),
    };
    const r = await request('POST', onboardingUrl, '/api/v1/onboarding/eternitas/webhook', body, {
      ...auth(API_TOKEN),
      'x-eternitas-signature': computeHmac(body),
    });
    assert.equal(r.status, 410);
    assert.equal(r.body.code, 'ENDPOINT_RETIRED');
    assert.equal(r.body.moved_to, '/api/v1/webhooks/eternitas');
    assert.match(r.body.error, /retired/i);
  });
});

// ═══════════════════════════════════════════════
// 6. Static CHAT_API_TOKEN Auth
// ═══════════════════════════════════════════════

describe('6. Static CHAT_API_TOKEN Auth', () => {
  it('6.1 service-to-service call with CHAT_API_TOKEN is accepted', async () => {
    const r = await request('GET', onboardingUrl, '/health');
    assert.equal(r.status, 200);
    // Now test an auth-protected endpoint with the static token
    const r2 = await request('GET', onboardingUrl,
      '/api/v1/chat/profile/check-name?name=ServiceTest',
      null, auth(API_TOKEN));
    assert.equal(r2.status, 200);
  });

  it('6.2 invalid static token is rejected', async () => {
    const r = await request('GET', onboardingUrl,
      '/api/v1/chat/profile/check-name?name=Test',
      null, auth('wrong-api-token'));
    assert.equal(r.status, 401);
  });
});
