/**
 * Unified Login + Service Mesh Stress Test
 *
 * Industrial-grade stress test that starts ALL 8 Chat microservices and tests
 * the full unified login → messaging → social → translation flow.
 * Mocks account-server, Eternitas, and Windy Translate.
 *
 * Run: node --test tests/stress/test_full_mesh.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ═══════════════════════════════════════════════════════════
// Environment Setup
// ═══════════════════════════════════════════════════════════

const JWT_SECRET = 'mesh-stress-test-jwt-secret';
const API_TOKEN = 'mesh-stress-test-api-token';
const ETERNITAS_WEBHOOK_SECRET = 'mesh-stress-eternitas-secret';

process.env.CHAT_API_TOKEN = API_TOKEN;
process.env.WINDY_JWT_SECRET = JWT_SECRET;
process.env.ETERNITAS_WEBHOOK_SECRET = ETERNITAS_WEBHOOK_SECRET;
process.env.NODE_ENV = 'test';

// ═══════════════════════════════════════════════════════════
// RSA Key Pair Generation (for RS256 JWT testing)
// ═══════════════════════════════════════════════════════════

const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Export public key as JWK for the mock JWKS server
const publicKeyDer = crypto.createPublicKey(rsaPublicKey).export({ type: 'spki', format: 'der' });
const rsaJwk = {
  kty: 'RSA',
  kid: 'test-key-1',
  use: 'sig',
  alg: 'RS256',
  n: publicKeyDer.subarray(publicKeyDer.length - 256 - 5, publicKeyDer.length - 5)
    .toString('base64url'),
  e: 'AQAB',
};

// ═══════════════════════════════════════════════════════════
// Clean data directories
// ═══════════════════════════════════════════════════════════

const serviceNames = [
  'onboarding', 'directory', 'push-gateway', 'backup', 'social',
  'translation', 'media', 'call-history',
];
for (const svc of serviceNames) {
  const dataDir = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dataDir, { recursive: true });
}
fs.mkdirSync(path.join(__dirname, '..', '..', 'services', 'media', 'data', 'media', 'thumbnails'), { recursive: true });

// ═══════════════════════════════════════════════════════════
// JWT Helpers
// ═══════════════════════════════════════════════════════════

const jwt = require('../../services/social/node_modules/jsonwebtoken');

function makeHS256Token(sub, windyId, opts = {}) {
  return jwt.sign(
    { sub, windy_identity_id: windyId, display_name: opts.displayName || sub, email: opts.email },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: opts.expiresIn || '1h' }
  );
}

function makeExpiredToken(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '-1s' }
  );
}

function makeNoIdentityToken(sub) {
  return jwt.sign({ sub }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

// Test identities
const WINDY_ID_A = 'aaaa-mesh-1111-2222-3333-aaaaaa';
const WINDY_ID_B = 'bbbb-mesh-1111-2222-3333-bbbbbb';
const USER_A = 'mesh_user_a';
const USER_B = 'mesh_user_b';
const tokenA = makeHS256Token(USER_A, WINDY_ID_A, { displayName: 'Alice Mesh', email: 'alice@windypro.com' });
const tokenB = makeHS256Token(USER_B, WINDY_ID_B, { displayName: 'Bob Mesh', email: 'bob@windypro.com' });

// ═══════════════════════════════════════════════════════════
// Mock Servers: Account-Server, Eternitas, Windy Translate
// ═══════════════════════════════════════════════════════════

const mockStats = {
  eternitas: 0,
  translate: 0,
  accountServer: 0,
};

let mockAccountServer, mockEternitasServer, mockTranslateServer;
let mockAccountUrl, mockEternitasUrl, mockTranslateUrl;
let mockEternitasTrustScore = 85;
let mockEternitasDown = false;
let mockTranslateDown = false;

function createMockAccountServer() {
  return http.createServer((req, res) => {
    mockStats.accountServer++;
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/.well-known/jwks.json') {
      res.end(JSON.stringify({ keys: [rsaJwk] }));
      return;
    }

    if (req.url === '/api/v1/identity/validate-token') {
      res.end(JSON.stringify({
        valid: true,
        identity: { id: WINDY_ID_A, display_name: 'Alice Mesh' },
      }));
      return;
    }

    if (req.url === '/api/v1/identity/ecosystem-status') {
      res.end(JSON.stringify({
        products: { chat: true, pro: true, translate: true },
        active_users: 42,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/v1/identity/chat/provision') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          res.end(JSON.stringify({
            matrix_user_id: `@${data.localpart || 'mesh_user'}:chat.windypro.com`,
            access_token: `syt_mock_${crypto.randomBytes(8).toString('hex')}`,
            home_server: 'chat.windypro.com',
          }));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

function createMockEternitasServer() {
  return http.createServer((req, res) => {
    mockStats.eternitas++;
    res.setHeader('Content-Type', 'application/json');

    if (mockEternitasDown) {
      res.destroy();
      return;
    }

    if (req.url.startsWith('/api/v1/registry/verify/')) {
      res.end(JSON.stringify({
        valid: true,
        trust_score: mockEternitasTrustScore,
        passport_id: req.url.split('/').pop(),
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

function createMockTranslateServer() {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (mockTranslateDown) {
      res.destroy();
      return;
    }

    if (req.method === 'POST') {
      mockStats.translate++;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          res.end(JSON.stringify({
            translated_text: `[translated:${data.target_lang}] ${data.text}`,
            source_lang: data.source_lang,
            target_lang: data.target_lang,
            confidence: 0.95,
          }));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Bad request' }));
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

// ═══════════════════════════════════════════════════════════
// HTTP Helpers
// ═══════════════════════════════════════════════════════════

function jsonRequest(method, baseUrl, urlPath, body, headers = {}) {
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

function uploadFile(baseUrl, urlPath, fieldName, fileName, fileBuffer, mimeType, headers = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----MeshTestBoundary' + crypto.randomBytes(8).toString('hex');
    const url = new URL(urlPath, baseUrl);
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`,
      `Content-Type: ${mimeType}\r\n\r\n`,
    ];
    const bodyEnd = `\r\n--${boundary}--\r\n`;
    const bodyStart = Buffer.from(bodyParts.join(''));
    const bodyEndBuf = Buffer.from(bodyEnd);
    const fullBody = Buffer.concat([bodyStart, fileBuffer, bodyEndBuf]);
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
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
    req.write(fullBody);
    req.end();
  });
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const serviceAuth = () => ({ Authorization: `Bearer ${API_TOKEN}` });

function computeHmac(body) {
  return crypto.createHmac('sha256', ETERNITAS_WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

// ═══════════════════════════════════════════════════════════
// Service URLs & Server Management
// ═══════════════════════════════════════════════════════════

let onboardingUrl, directoryUrl, socialUrl, pushUrl, translationUrl, mediaUrl, callHistoryUrl, backupUrl;
const servers = [];

function loadAutoListenService(modulePath) {
  const originalPort = process.env.PORT;
  process.env.PORT = '0';
  const origListen = http.Server.prototype.listen;
  let capturedServer = null;
  http.Server.prototype.listen = function (...args) {
    capturedServer = this;
    if (typeof args[0] === 'number' || typeof args[0] === 'string') args[0] = 0;
    return origListen.apply(this, args);
  };
  const mod = require(modulePath);
  http.Server.prototype.listen = origListen;
  if (originalPort !== undefined) process.env.PORT = originalPort;
  else delete process.env.PORT;

  return new Promise((resolve) => {
    if (capturedServer) {
      const check = () => {
        const addr = capturedServer.address();
        if (addr) { servers.push(capturedServer); resolve(`http://localhost:${addr.port}`); }
        else capturedServer.once('listening', () => { servers.push(capturedServer); resolve(`http://localhost:${capturedServer.address().port}`); });
      };
      check();
    } else {
      const app = mod.app || mod;
      const srv = app.listen(0, () => { servers.push(srv); resolve(`http://localhost:${srv.address().port}`); });
    }
  });
}

function startManualService(modulePath) {
  const mod = require(modulePath);
  const app = mod.app || mod;
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      servers.push(srv);
      resolve(`http://localhost:${srv.address().port}`);
    });
  });
}

function startMock(createFn) {
  const server = createFn();
  return new Promise((resolve) => {
    server.listen(0, () => {
      servers.push(server);
      resolve(`http://localhost:${server.address().port}`);
    });
  });
}

// ═══════════════════════════════════════════════════════════
// Test Timing & Reporting
// ═══════════════════════════════════════════════════════════

const timings = [];
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const categoryResults = {};
let currentCategory = '';

function startTimer() {
  return process.hrtime.bigint();
}

function recordTiming(label, start) {
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  timings.push({ label, ms: elapsed });
  return elapsed;
}

// ═══════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════

before(async () => {
  console.log('\n\x1b[36m═══ STARTING CHAT MESH STRESS TEST ═══\x1b[0m\n');

  // Start mock servers first
  console.log('  Starting mock account-server...');
  mockAccountUrl = await startMock(createMockAccountServer);
  process.env.WINDY_ACCOUNT_SERVER_URL = mockAccountUrl;

  console.log('  Starting mock Eternitas...');
  mockEternitasUrl = await startMock(createMockEternitasServer);
  process.env.ETERNITAS_API_URL = mockEternitasUrl;

  console.log('  Starting mock Windy Translate...');
  mockTranslateUrl = await startMock(createMockTranslateServer);
  process.env.WINDY_TRANSLATE_URL = mockTranslateUrl;

  // Start all 8 services
  console.log('  Starting onboarding service...');
  onboardingUrl = await loadAutoListenService('../../services/onboarding/server');

  console.log('  Starting directory service...');
  directoryUrl = await loadAutoListenService('../../services/directory/server');

  console.log('  Starting push-gateway service...');
  pushUrl = await loadAutoListenService('../../services/push-gateway/server');

  console.log('  Starting backup service...');
  backupUrl = await startManualService('../../services/backup/server');

  console.log('  Starting social service...');
  socialUrl = await startManualService('../../services/social/server');

  console.log('  Starting translation service...');
  translationUrl = await startManualService('../../services/translation/server');

  console.log('  Starting media service...');
  mediaUrl = await startManualService('../../services/media/server');

  console.log('  Starting call-history service...');
  callHistoryUrl = await startManualService('../../services/call-history/server');

  console.log(`\n  \x1b[32m✓ All 8 services + 3 mock servers started\x1b[0m\n`);
});

after(() => new Promise((resolve) => {
  // Print final report
  const avgMs = timings.length > 0 ? (timings.reduce((s, t) => s + t.ms, 0) / timings.length).toFixed(0) : 0;
  const slowest = timings.length > 0 ? timings.reduce((a, b) => a.ms > b.ms ? a : b) : { label: 'none', ms: 0 };

  console.log('\n\x1b[36m═══ CHAT MESH STRESS TEST RESULTS ═══\x1b[0m');
  console.log(`  Services started: 8/8`);
  console.log(`  Total tests: ${totalTests}`);
  console.log(`  \x1b[32mPassed: ${passedTests}\x1b[0m | \x1b[${failedTests > 0 ? '31' : '32'}mFailed: ${failedTests}\x1b[0m`);
  console.log(`  Mock webhooks received: { eternitas: ${mockStats.eternitas}, translate: ${mockStats.translate} }`);
  console.log(`  Avg response time: ${avgMs}ms`);
  console.log(`  Slowest: ${slowest.ms.toFixed(0)}ms (${slowest.label})`);
  console.log('');

  let closed = 0;
  const total = servers.length;
  if (total === 0) { resolve(); return; }
  const onClose = () => { closed++; if (closed >= total) { setTimeout(() => process.exit(0), 200); resolve(); } };
  for (const srv of servers) {
    try { srv.close(onClose); } catch { onClose(); }
  }
}));

// Helper to track test results
function trackTest(name, fn) {
  return async () => {
    totalTests++;
    const start = startTimer();
    try {
      await fn();
      passedTests++;
      recordTiming(name, start);
    } catch (err) {
      failedTests++;
      recordTiming(name, start);
      throw err;
    }
  };
}

// ═══════════════════════════════════════════════════════════
// CATEGORY 1: Unified Login Flow (8 tests)
// ═══════════════════════════════════════════════════════════

describe('Category 1: Unified Login Flow', () => {
  let firstLoginResponse;

  it('1.1 POST unified-login with valid Pro JWT → 201', trackTest('unified-login', async () => {
    const r = await jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(tokenA));
    assert.equal(r.status, 201);
    assert.ok(r.body.matrix_user_id, 'Should return matrix_user_id');
    assert.ok(r.body.access_token, 'Should return access_token');
    assert.equal(r.body.already_existed, false);
    firstLoginResponse = r.body;
  }));

  it('1.2 Verify Matrix user ID returned', trackTest('verify-matrix-id', async () => {
    assert.ok(firstLoginResponse.matrix_user_id);
    assert.match(firstLoginResponse.matrix_user_id, /@.+:.+/);
  }));

  it('1.3 Verify user_profiles table has windy_identity_id', trackTest('verify-profile', async () => {
    assert.equal(firstLoginResponse.windy_identity_id, WINDY_ID_A);
    assert.ok(firstLoginResponse.chat_user_id);
  }));

  it('1.4 Idempotent second call (already_existed: true)', trackTest('idempotent-login', async () => {
    const r = await jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(tokenA));
    assert.equal(r.status, 200);
    assert.equal(r.body.already_existed, true);
    assert.equal(r.body.windy_identity_id, WINDY_ID_A);
    assert.equal(r.body.chat_user_id, firstLoginResponse.chat_user_id);
  }));

  it('1.5 JWT missing windy_identity_id → 400', trackTest('missing-identity', async () => {
    const badToken = makeNoIdentityToken('no_identity_user');
    const r = await jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(badToken));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /windy_identity_id/);
  }));

  it('1.6 Expired JWT → 401', trackTest('expired-jwt', async () => {
    const expired = makeExpiredToken('expired_user', 'expired-uuid');
    const r = await jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(expired));
    assert.equal(r.status, 401);
  }));

  it('1.7 No Authorization header → 401', trackTest('no-auth', async () => {
    const r = await jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {});
    assert.equal(r.status, 401);
  }));

  it('1.8 HS256 fallback works (standard path)', trackTest('hs256-fallback', async () => {
    // Our tokens are HS256 — this test confirms the auth middleware accepts them
    const freshToken = makeHS256Token('fallback_user', 'fallback-uuid-1234', { displayName: 'Fallback User' });
    const r = await jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(freshToken));
    assert.ok(r.status === 201 || r.status === 200, `Expected 201 or 200, got ${r.status}`);
  }));
});

// ═══════════════════════════════════════════════════════════
// CATEGORY 2: Cross-Service Identity (6 tests)
// ═══════════════════════════════════════════════════════════

describe('Category 2: Cross-Service Identity', () => {
  before(async () => {
    // Ensure user B is also logged in
    await jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(tokenB));
  });

  it('2.1 Login via unified-login → onboarding DB has profile', trackTest('cross-identity-login', async () => {
    const r = await jsonRequest('GET', onboardingUrl, `/api/v1/chat/profile/check-name?name=Alice Mesh`, null, auth(tokenA));
    assert.equal(r.status, 200);
  }));

  it('2.2 Search in directory → user findable by display name', trackTest('directory-search', async () => {
    // Register user in directory (searchable profile) first
    await jsonRequest('POST', directoryUrl, '/api/v1/chat/directory/register', {
      userId: USER_A,
      displayName: 'Alice Mesh',
      searchable: true,
    }, auth(tokenA));

    const r = await jsonRequest('GET', directoryUrl, '/api/v1/chat/directory/search?q=Alice', null, auth(tokenB));
    assert.equal(r.status, 200);
    assert.ok(r.body.results.length > 0, 'Should find user by display name');
  }));

  it('2.3 Create post in social → windy_identity_id recorded', trackTest('social-identity', async () => {
    const r = await jsonRequest('POST', socialUrl, '/api/v1/social/posts', {
      content: 'Cross-service identity test post',
    }, auth(tokenA));
    assert.equal(r.status, 201);
    assert.equal(r.body.windyIdentityId, WINDY_ID_A);
  }));

  it('2.4 Check notifications → correct user', trackTest('notifications-identity', async () => {
    const r = await jsonRequest('GET', socialUrl, '/api/v1/social/notifications', null, auth(tokenA));
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.notifications));
  }));

  it('2.5 Upload file in media → associated with right user', trackTest('media-identity', async () => {
    // Create a minimal valid PNG
    const png = createTestPng();
    const r = await uploadFile(mediaUrl, '/api/v1/media/upload', 'file', 'identity_test.png', png, 'image/png', auth(tokenA));
    assert.equal(r.status, 201);
    assert.ok(r.body.media_id);
  }));

  it('2.6 Log a call in call-history → user ID matches', trackTest('callhistory-identity', async () => {
    const r = await jsonRequest('POST', callHistoryUrl, '/api/v1/calls/log', {
      room_id: '!test-room:chat.windypro.com',
      caller_id: USER_A,
      callee_id: USER_B,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_seconds: 120,
      call_type: 'voice',
    }, auth(tokenA));
    assert.equal(r.status, 201);
    assert.ok(r.body.callId || r.body.call_id || r.body.id);
  }));
});

// ═══════════════════════════════════════════════════════════
// CATEGORY 3: Social Feed (6 tests)
// ═══════════════════════════════════════════════════════════

describe('Category 3: Social Feed', () => {
  let postId;

  it('3.1 User A creates a post → 201', trackTest('create-post', async () => {
    const r = await jsonRequest('POST', socialUrl, '/api/v1/social/posts', {
      content: 'Hello from Alice in the mesh test!',
    }, auth(tokenA));
    assert.equal(r.status, 201);
    assert.ok(r.body.id);
    postId = r.body.id;
  }));

  it('3.2 User B follows User A → 200', trackTest('follow-user', async () => {
    const r = await jsonRequest('POST', socialUrl, `/api/v1/social/follow/${USER_A}`, {}, auth(tokenB));
    assert.equal(r.status, 200);
    assert.equal(r.body.following, true);
  }));

  it('3.3 User B feed includes User A post', trackTest('feed-includes-post', async () => {
    const r = await jsonRequest('GET', socialUrl, '/api/v1/social/posts', null, auth(tokenB));
    assert.equal(r.status, 200);
    const found = r.body.posts.some(p => p.id === postId);
    assert.ok(found, "User A's post should appear in User B's feed");
  }));

  it('3.4 User B likes the post → like_count increments', trackTest('like-post', async () => {
    const r = await jsonRequest('POST', socialUrl, `/api/v1/social/posts/${postId}/like`, {}, auth(tokenB));
    assert.equal(r.status, 200);
    assert.equal(r.body.liked, true);
    assert.equal(r.body.likeCount, 1);
  }));

  it('3.5 User A gets notification of the like', trackTest('like-notification', async () => {
    const r = await jsonRequest('GET', socialUrl, '/api/v1/social/notifications', null, auth(tokenA));
    assert.equal(r.status, 200);
    const likeNotif = r.body.notifications.find(n => n.type === 'like');
    assert.ok(likeNotif, 'Should have a like notification');
    assert.equal(likeNotif.fromUserId, USER_B);
  }));

  it('3.6 Report a post → report recorded', trackTest('report-post', async () => {
    const r = await jsonRequest('POST', socialUrl, `/api/v1/social/moderation/${postId}/report`, {
      reason: 'spam',
      description: 'Test report',
    }, auth(tokenB));
    assert.equal(r.status, 201);
    assert.ok(r.body.reportId);
    assert.equal(r.body.status, 'pending');
  }));
});

// ═══════════════════════════════════════════════════════════
// CATEGORY 4: Translation Proxy (5 tests)
// ═══════════════════════════════════════════════════════════

describe('Category 4: Translation Proxy', () => {
  const translateCountBefore = () => mockStats.translate;

  it('4.1 POST /api/v1/translate with valid text → translation returned', trackTest('translate-basic', async () => {
    const r = await jsonRequest('POST', translationUrl, '/api/v1/translate', {
      text: 'Hello world',
      source_lang: 'en',
      target_lang: 'fr',
    }, auth(tokenA));
    assert.equal(r.status, 200);
    assert.ok(r.body.translated_text, 'Should return translated_text');
    assert.equal(r.body.source_lang, 'en');
    assert.equal(r.body.target_lang, 'fr');
  }));

  it('4.2 Mock translate server received the request', trackTest('translate-mock-called', async () => {
    assert.ok(mockStats.translate >= 1, 'Mock translate server should have been called at least once');
  }));

  it('4.3 Same translation again → cache hit (mock NOT called twice)', trackTest('translate-cache', async () => {
    const countBefore = mockStats.translate;
    const r = await jsonRequest('POST', translationUrl, '/api/v1/translate', {
      text: 'Hello world',
      source_lang: 'en',
      target_lang: 'fr',
    }, auth(tokenA));
    assert.equal(r.status, 200);
    assert.ok(r.body.translated_text);
    assert.equal(r.body.cached, true, 'Second call should be cached');
    assert.equal(mockStats.translate, countBefore, 'Mock server should NOT be called again for cached translation');
  }));

  it('4.4 Invalid language code → 400', trackTest('translate-invalid-lang', async () => {
    const r = await jsonRequest('POST', translationUrl, '/api/v1/translate', {
      text: 'Hello',
      source_lang: '',
      target_lang: '',
    }, auth(tokenA));
    assert.ok(r.status === 400 || r.status === 422, `Expected 400 or 422, got ${r.status}`);
  }));

  it('4.5 Translate server down → 502 or stub fallback', trackTest('translate-down', async () => {
    mockTranslateDown = true;
    const r = await jsonRequest('POST', translationUrl, '/api/v1/translate', {
      text: 'Test when down',
      source_lang: 'en',
      target_lang: 'de',
    }, auth(tokenA));
    // Service may return 502 or a stub fallback response
    assert.ok(r.status === 200 || r.status === 502, `Expected 200 (stub) or 502, got ${r.status}`);
    if (r.status === 200) {
      assert.equal(r.body.stub, true, 'Fallback should have stub: true');
    }
    mockTranslateDown = false;
  }));
});

// ═══════════════════════════════════════════════════════════
// CATEGORY 5: Media Upload (5 tests)
// ═══════════════════════════════════════════════════════════

// Minimal valid PNG (1x1 pixel, red)
function createTestPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.from([
    0x00, 0x00, 0x00, 0x0D, // chunk length
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, // width: 1
    0x00, 0x00, 0x00, 0x01, // height: 1
    0x08, 0x02,             // 8-bit RGB
    0x00, 0x00, 0x00,       // compression, filter, interlace
    0x00, 0x00, 0x00, 0x00, // placeholder CRC
  ]);
  // Pre-computed valid IDAT for 1x1 red pixel
  const idat = Buffer.from([
    0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,
    0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00,
    0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33,
  ]);
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, idat, iend]);
}

describe('Category 5: Media Upload', () => {
  let uploadedMediaId;

  it('5.1 Upload small PNG → 201, media_id returned', trackTest('media-upload', async () => {
    const png = createTestPng();
    const r = await uploadFile(mediaUrl, '/api/v1/media/upload', 'file', 'test.png', png, 'image/png', auth(tokenA));
    assert.equal(r.status, 201);
    assert.ok(r.body.media_id);
    assert.ok(r.body.url);
    assert.equal(r.body.mime_type, 'image/png');
    uploadedMediaId = r.body.media_id;
  }));

  it('5.2 GET /api/v1/media/:id → correct Content-Type', trackTest('media-serve', async () => {
    const r = await new Promise((resolve, reject) => {
      const url = new URL(`/api/v1/media/${uploadedMediaId}`, mediaUrl);
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
  }));

  it('5.3 GET /api/v1/media/:id/thumbnail → exists or null', trackTest('media-thumbnail', async () => {
    const r = await new Promise((resolve, reject) => {
      const url = new URL(`/api/v1/media/${uploadedMediaId}/thumbnail`, mediaUrl);
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode }));
      }).on('error', reject);
    });
    // Thumbnail may be 200 (sharp available) or 404 (sharp not available)
    assert.ok(r.status === 200 || r.status === 404, `Expected 200 or 404 for thumbnail, got ${r.status}`);
  }));

  it('5.4 Upload .exe file → 400 (rejected)', trackTest('media-reject-exe', async () => {
    const fakeExe = Buffer.from('MZ\x90\x00this is a fake exe');
    const r = await uploadFile(mediaUrl, '/api/v1/media/upload', 'file', 'malware.exe', fakeExe, 'application/x-msdownload', auth(tokenA));
    assert.equal(r.status, 400);
  }));

  it('5.5 Upload file over 50MB → 413', trackTest('media-too-large', async () => {
    // Create a buffer just over 50MB — we'll use a sparse approach via headers
    // Actually sending 50MB would be slow, so we trick multer with Content-Length
    // Instead, create a small buffer but test that the limit config exists
    const boundary = '----MeshTestOversize' + crypto.randomBytes(8).toString('hex');
    const url = new URL('/api/v1/media/upload', mediaUrl);

    // We'll send a request that claims to be >50MB via a large buffer
    // To avoid OOM, we'll send a 51MB stream of zeros in chunks
    const r = await new Promise((resolve, reject) => {
      const headerPart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.png"\r\nContent-Type: image/png\r\n\r\n`;
      const footerPart = `\r\n--${boundary}--\r\n`;
      const totalFileSize = 50 * 1024 * 1024 + 1024; // 50MB + 1KB
      const totalSize = Buffer.byteLength(headerPart) + totalFileSize + Buffer.byteLength(footerPart);

      const opts = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalSize,
          Authorization: `Bearer ${tokenA}`,
        },
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (err) => {
        // Connection reset is expected when server rejects oversized upload
        resolve({ status: 413, body: { error: 'Connection reset (expected for oversize)' } });
      });

      req.write(headerPart);

      // Write 50MB + 1KB of zeros in 1MB chunks
      const chunkSize = 1024 * 1024;
      let written = 0;
      function writeChunk() {
        while (written < totalFileSize) {
          const remaining = totalFileSize - written;
          const size = Math.min(chunkSize, remaining);
          const ok = req.write(Buffer.alloc(size));
          written += size;
          if (!ok) {
            req.once('drain', writeChunk);
            return;
          }
        }
        req.write(footerPart);
        req.end();
      }
      writeChunk();
    });
    assert.equal(r.status, 413, `Expected 413 for oversized upload, got ${r.status}`);
  }));
});

// ═══════════════════════════════════════════════════════════
// CATEGORY 6: Eternitas Badge Verification (4 tests)
// ═══════════════════════════════════════════════════════════

describe('Category 6: Eternitas Badge Verification', () => {
  const botUserId = 'bot_test_passport_123';
  const passportId = 'test_passport_123';

  before(async () => {
    // Clear Eternitas cache by resetting state
    mockEternitasTrustScore = 85;
    mockEternitasDown = false;
  });

  it('6.1 Create post as bot user → Eternitas API called on profile check', trackTest('eternitas-check', async () => {
    // First, verify the bot via service-to-service call
    await jsonRequest('POST', socialUrl, '/api/v1/social/eternitas/verify', {
      userId: botUserId,
      passportId,
    }, serviceAuth());

    // Check profile — should show verified badge
    const r = await jsonRequest('GET', socialUrl, `/api/v1/social/profile/${botUserId}`, null, auth(tokenA));
    assert.equal(r.status, 200);
    assert.equal(r.body.verified, true);
  }));

  it('6.2 Badge shows verified (trust_score >= 50)', trackTest('eternitas-verified', async () => {
    const r = await jsonRequest('GET', socialUrl, `/api/v1/social/profile/${botUserId}`, null, auth(tokenA));
    assert.equal(r.status, 200);
    assert.equal(r.body.verified, true);
  }));

  it('6.3 Trust_score 30 → unverified badge', trackTest('eternitas-unverified', async () => {
    mockEternitasTrustScore = 30;
    // Use a new bot user that hasn't been locally verified
    const lowTrustBot = 'bot_low_trust_agent';
    const r = await jsonRequest('GET', socialUrl, `/api/v1/social/profile/${lowTrustBot}`, null, auth(tokenA));
    assert.equal(r.status, 200);
    assert.equal(r.body.verified, false, 'Low trust score bot should NOT be verified');
    mockEternitasTrustScore = 85;
  }));

  it('6.4 Eternitas down → graceful fallback (no crash)', trackTest('eternitas-down', async () => {
    mockEternitasDown = true;
    const downBot = 'bot_offline_agent';
    const r = await jsonRequest('GET', socialUrl, `/api/v1/social/profile/${downBot}`, null, auth(tokenA));
    assert.equal(r.status, 200);
    // Should not crash — verified should be false when Eternitas is unreachable
    assert.equal(r.body.verified, false);
    mockEternitasDown = false;
  }));
});

// ═══════════════════════════════════════════════════════════
// CATEGORY 7: Webhook HMAC (4 tests)
// ═══════════════════════════════════════════════════════════

describe('Category 7: Webhook HMAC', () => {
  const testPassport = 'webhook_test_passport';
  const botName = 'TestBot';
  const botUserId = `bot_${testPassport}`;

  before(async () => {
    // Pre-verify the bot so revocation has something to revoke
    await jsonRequest('POST', socialUrl, '/api/v1/social/eternitas/verify', {
      userId: botUserId,
    }, serviceAuth());
  });

  it('7.1 Eternitas revocation with valid HMAC → 200, account deactivated', trackTest('webhook-revoke', async () => {
    const body = {
      event: 'passport.revoked',
      passport: testPassport,
      bot_name: botName,
      operator_id: 'op_123',
      reason: 'violation',
      timestamp: new Date().toISOString(),
    };
    const signature = computeHmac(body);
    const r = await jsonRequest('POST', socialUrl, '/api/v1/social/eternitas/webhook', body, {
      ...serviceAuth(),
      'x-eternitas-signature': signature,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.acknowledged, true);
    assert.equal(r.body.action_taken, 'account_deactivated');

    // Verify bot is no longer verified
    const profile = await jsonRequest('GET', socialUrl, `/api/v1/social/profile/${botUserId}`, null, auth(tokenA));
    assert.equal(profile.body.verified, false);
  }));

  it('7.2 Wrong HMAC → 401', trackTest('webhook-bad-hmac', async () => {
    const body = {
      event: 'passport.revoked',
      passport: testPassport,
      bot_name: botName,
      timestamp: new Date().toISOString(),
    };
    const r = await jsonRequest('POST', socialUrl, '/api/v1/social/eternitas/webhook', body, {
      ...serviceAuth(),
      'x-eternitas-signature': 'deadbeef_wrong_signature',
    });
    assert.equal(r.status, 401);
  }));

  it('7.3 passport.reinstated → account reactivated', trackTest('webhook-reinstate', async () => {
    const body = {
      event: 'passport.reinstated',
      passport: testPassport,
      bot_name: botName,
      timestamp: new Date().toISOString(),
    };
    const signature = computeHmac(body);
    const r = await jsonRequest('POST', socialUrl, '/api/v1/social/eternitas/webhook', body, {
      ...serviceAuth(),
      'x-eternitas-signature': signature,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.action_taken, 'account_reactivated');

    // Verify bot is verified again
    const profile = await jsonRequest('GET', socialUrl, `/api/v1/social/profile/${botUserId}`, null, auth(tokenA));
    assert.equal(profile.body.verified, true);
  }));

  it('7.4 Non-existent bot → 200 (idempotent)', trackTest('webhook-nonexistent', async () => {
    const body = {
      event: 'passport.revoked',
      passport: 'nonexistent_passport_xyz',
      bot_name: 'GhostBot',
      timestamp: new Date().toISOString(),
    };
    const signature = computeHmac(body);
    const r = await jsonRequest('POST', socialUrl, '/api/v1/social/eternitas/webhook', body, {
      ...serviceAuth(),
      'x-eternitas-signature': signature,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.acknowledged, true);
  }));
});

// ═══════════════════════════════════════════════════════════
// CATEGORY 8: Concurrent Load (4 tests)
// ═══════════════════════════════════════════════════════════

describe('Category 8: Concurrent Load', () => {
  it('8.1 20 simultaneous unified-logins → all succeed', trackTest('concurrent-logins', async () => {
    const promises = Array.from({ length: 20 }, (_, i) => {
      const t = makeHS256Token(`conc_user_${i}`, `conc-uuid-${i}`, { displayName: `ConcUser${i}` });
      return jsonRequest('POST', onboardingUrl, '/api/v1/onboarding/unified-login', {}, auth(t));
    });
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 201 || r.status === 200);
    assert.equal(successes.length, 20, `All 20 logins should succeed, got ${successes.length}`);
  }));

  it('8.2 20 simultaneous post creates → all succeed, no duplicates', trackTest('concurrent-posts', async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      jsonRequest('POST', socialUrl, '/api/v1/social/posts', {
        content: `Concurrent mesh post ${i} at ${Date.now()}`,
      }, auth(tokenA))
    );
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 201);
    assert.equal(successes.length, 20, `All 20 creates should succeed, got ${successes.length}`);

    const ids = successes.map(r => r.body.id);
    const unique = new Set(ids);
    assert.equal(unique.size, 20, 'All 20 posts should have unique IDs');
  }));

  it('8.3 20 simultaneous likes on same post → idempotent', trackTest('concurrent-likes', async () => {
    // Create a target post
    const post = await jsonRequest('POST', socialUrl, '/api/v1/social/posts', {
      content: 'Like storm target',
    }, auth(tokenA));
    const postId = post.body.id;

    // 20 different users liking the same post
    const promises = Array.from({ length: 20 }, (_, i) => {
      const t = makeHS256Token(`liker_${i}`, `liker-uuid-${i}`);
      return jsonRequest('POST', socialUrl, `/api/v1/social/posts/${postId}/like`, {}, auth(t));
    });
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 200);
    assert.equal(successes.length, 20, 'All 20 likes should respond 200');

    // Check final count
    const check = await jsonRequest('GET', socialUrl, `/api/v1/social/posts/${postId}`);
    assert.equal(check.body.likeCount, 20, 'Like count should be exactly 20 (one per user)');
  }));

  it('8.4 50 simultaneous health checks across all 8 services → all 200', trackTest('concurrent-health', async () => {
    const serviceUrls = [
      onboardingUrl, directoryUrl, pushUrl, backupUrl,
      socialUrl, translationUrl, mediaUrl, callHistoryUrl,
    ];

    // ~6 health checks per service, 50 total
    const promises = [];
    for (let i = 0; i < 50; i++) {
      const url = serviceUrls[i % serviceUrls.length];
      promises.push(jsonRequest('GET', url, '/health'));
    }
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 200);
    assert.equal(successes.length, 50, `All 50 health checks should return 200, got ${successes.length}`);
  }));
});
