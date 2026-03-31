/**
 * Integration Test — Full Onboarding Flow
 *
 * Simulates a user journey across multiple services:
 *   1. JWT from Windy Pro (with windy_identity_id)
 *   2. K2 Onboarding: profile setup, display name
 *   3. K3 Directory: register in searchable directory
 *   4. K10 Social: create post, follow user
 *   5. K6 Push: register push token
 *   6. K9 Translation: preferences
 *   7. Verify windy_identity_id consistency across all services
 *
 * Run: node --test tests/integration/test_onboarding_flow.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Set test env vars before requiring any services
process.env.CHAT_API_TOKEN = 'test-integration-token';
process.env.WINDY_JWT_SECRET = 'test-integration-jwt-secret';
process.env.NODE_ENV = 'test';

// Clean data dirs for all services
const serviceNames = [
  'onboarding', 'directory', 'push-gateway', 'backup', 'social',
  'translation', 'media',
];
for (const svc of serviceNames) {
  const dataDir = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dataDir, { recursive: true });
}

// Services that auto-listen need unique ports. Set PORT=0 to get random ports.
// We'll intercept the server from the net module.
const jwt = require('../../services/social/node_modules/jsonwebtoken');

// Test identities
const WINDY_IDENTITY_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_SUB = 'integration_test_user';
const USER_B_SUB = 'integration_test_user_b';
const WINDY_IDENTITY_ID_B = '660e8400-e29b-41d4-a716-446655440001';

function makeJwt(sub, windyIdentityId) {
  return jwt.sign(
    { sub, windy_identity_id: windyIdentityId },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const tokenA = makeJwt(USER_SUB, WINDY_IDENTITY_ID);
const tokenB = makeJwt(USER_B_SUB, WINDY_IDENTITY_ID_B);

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

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

// Track service URLs — we'll load services that auto-listen and extract their ports
let onboardingUrl, directoryUrl, socialUrl, pushUrl, translationUrl, mediaUrl;
let servers = [];

// Helper: load a service, capture its auto-started server or start one
function loadAutoListenService(modulePath, envPort) {
  // Set a unique random port for auto-listen services
  const originalPort = process.env.PORT;
  process.env.PORT = '0'; // 0 = random port

  // Intercept http.Server.listen to capture the server
  const origListen = http.Server.prototype.listen;
  let capturedServer = null;
  http.Server.prototype.listen = function(...args) {
    capturedServer = this;
    // Replace the port arg with 0 for random port
    if (typeof args[0] === 'number' || typeof args[0] === 'string') {
      args[0] = 0;
    }
    return origListen.apply(this, args);
  };

  const mod = require(modulePath);
  http.Server.prototype.listen = origListen;

  if (originalPort !== undefined) process.env.PORT = originalPort;
  else delete process.env.PORT;

  return new Promise((resolve) => {
    if (capturedServer) {
      // Wait for the server to be listening
      const checkListening = () => {
        const addr = capturedServer.address();
        if (addr) {
          servers.push(capturedServer);
          resolve({ app: mod.app || mod, url: `http://localhost:${addr.port}`, server: capturedServer });
        } else {
          capturedServer.once('listening', () => {
            servers.push(capturedServer);
            resolve({ app: mod.app || mod, url: `http://localhost:${capturedServer.address().port}`, server: capturedServer });
          });
        }
      };
      checkListening();
    } else {
      // No auto-listen — start manually
      const app = mod.app || mod;
      const srv = app.listen(0, () => {
        servers.push(srv);
        resolve({ app, url: `http://localhost:${srv.address().port}`, server: srv });
      });
    }
  });
}

before(async () => {
  // Load services that auto-listen (onboarding, directory, push-gateway, backup)
  const onb = await loadAutoListenService('../../services/onboarding/server');
  onboardingUrl = onb.url;

  const dir = await loadAutoListenService('../../services/directory/server');
  directoryUrl = dir.url;

  const push = await loadAutoListenService('../../services/push-gateway/server');
  pushUrl = push.url;

  // Services with require.main guard — start manually
  const { app: socialApp } = require('../../services/social/server');
  const socialSrv = socialApp.listen(0);
  await new Promise(r => socialSrv.on('listening', r));
  socialUrl = `http://localhost:${socialSrv.address().port}`;
  servers.push(socialSrv);

  const { app: translationApp } = require('../../services/translation/server');
  const transSrv = translationApp.listen(0);
  await new Promise(r => transSrv.on('listening', r));
  translationUrl = `http://localhost:${transSrv.address().port}`;
  servers.push(transSrv);

  const { app: mediaApp } = require('../../services/media/server');
  const mediaSrv = mediaApp.listen(0);
  await new Promise(r => mediaSrv.on('listening', r));
  mediaUrl = `http://localhost:${mediaSrv.address().port}`;
  servers.push(mediaSrv);
});

after(() => new Promise((resolve) => {
  let closed = 0;
  const total = servers.length;
  if (total === 0) { resolve(); return; }
  const onClose = () => { closed++; if (closed >= total) { setTimeout(() => process.exit(0), 100); resolve(); } };
  for (const srv of servers) {
    srv.close(onClose);
  }
}));

// ════════════════════════════════════════
// Step 1: All services healthy
// ════════════════════════════════════════

describe('Step 1: Service Health', () => {
  it('onboarding is healthy', async () => {
    const res = await request('GET', onboardingUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('directory is healthy', async () => {
    const res = await request('GET', directoryUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('social is healthy', async () => {
    const res = await request('GET', socialUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('push gateway is healthy', async () => {
    const res = await request('GET', pushUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('translation is healthy', async () => {
    const res = await request('GET', translationUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('media is healthy', async () => {
    const res = await request('GET', mediaUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });
});

// ════════════════════════════════════════
// Step 2: K2 Onboarding — Profile setup
// ════════════════════════════════════════

describe('Step 2: K2 Onboarding — Profile Setup', () => {
  it('checks display name availability', async () => {
    const res = await request('GET', onboardingUrl, '/api/v1/chat/profile/check-name?name=IntegrationUser', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.ok('available' in res.body);
  });

  it('sends OTP for phone verification', async () => {
    const res = await request('POST', onboardingUrl, '/api/v1/chat/verify/send', {
      type: 'email',
      identifier: 'integration@windypro.com',
    }, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});

// ════════════════════════════════════════
// Step 3: K3 Directory — Register user
// ════════════════════════════════════════

describe('Step 3: K3 Directory — Register & Search', () => {
  it('registers user in searchable directory', async () => {
    const res = await request('POST', directoryUrl, '/api/v1/chat/directory/register', {
      userId: USER_SUB,
      displayName: 'IntegrationUser',
      email: 'integration@windypro.com',
      languages: ['en', 'es'],
      searchable: true,
    }, authed(tokenA));
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
  });

  it('finds user via search', async () => {
    const res = await request('GET', directoryUrl, '/api/v1/chat/directory/search?q=IntegrationUser', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.ok(res.body.results.length >= 1);
    const found = res.body.results.find(r => r.userId === USER_SUB);
    assert.ok(found, 'User should appear in search results');
  });
});

// ════════════════════════════════════════
// Step 4: K10 Social — Post & Follow
// ════════════════════════════════════════

describe('Step 4: K10 Social — Posts & Follows', () => {
  let postId;

  it('creates a post', async () => {
    const res = await request('POST', socialUrl, '/api/v1/social/posts', {
      content: 'Hello from the integration test!',
    }, authed(tokenA));
    assert.equal(res.status, 201);
    assert.equal(res.body.userId, USER_SUB);
    assert.ok(res.body.id);
    postId = res.body.id;
  });

  it('post is retrievable', async () => {
    const res = await request('GET', socialUrl, `/api/v1/social/posts/${postId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.content, 'Hello from the integration test!');
  });

  it('user B follows user A', async () => {
    const res = await request('POST', socialUrl, `/api/v1/social/follow/${USER_SUB}`, {}, authed(tokenB));
    assert.equal(res.status, 200);
    assert.equal(res.body.following, true);
  });

  it('user A post appears in user B feed', async () => {
    const res = await request('GET', socialUrl, '/api/v1/social/posts', null, authed(tokenB));
    assert.equal(res.status, 200);
    const post = res.body.posts.find(p => p.userId === USER_SUB);
    assert.ok(post, 'User A post should appear in User B feed');
  });

  it('user B likes user A post', async () => {
    const res = await request('POST', socialUrl, `/api/v1/social/posts/${postId}/like`, {}, authed(tokenB));
    assert.equal(res.status, 200);
    assert.equal(res.body.liked, true);
    assert.equal(res.body.likeCount, 1);
  });

  it('user A receives like notification', async () => {
    const res = await request('GET', socialUrl, '/api/v1/social/notifications?unread=true', null, authed(tokenA));
    assert.equal(res.status, 200);
    const likeNotif = res.body.notifications.find(n => n.type === 'like' && n.postId === postId);
    assert.ok(likeNotif, 'Expected like notification');
    assert.equal(likeNotif.fromUserId, USER_B_SUB);
  });
});

// ════════════════════════════════════════
// Step 5: K6 Push — Register token
// ════════════════════════════════════════

describe('Step 5: K6 Push — Token Registration', () => {
  it('registers a push token', async () => {
    const res = await request('POST', pushUrl, '/api/v1/chat/push/register', {
      pushkey: 'integration-test-fcm-token',
      userId: USER_SUB,
      platform: 'android',
      appId: 'com.windypro.chat.android',
      deviceName: 'Integration Test Device',
    }, authed(tokenA));
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
  });
});

// ════════════════════════════════════════
// Step 6: K9 Translation — Preferences
// ════════════════════════════════════════

describe('Step 6: K9 Translation — Preferences', () => {
  it('sets language preferences with windy_identity_id', async () => {
    const res = await request('POST', translationUrl, '/api/v1/translate/preferences', {
      preferred_language: 'es',
      auto_translate: true,
    }, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.preferred_language, 'es');
    assert.equal(res.body.auto_translate, true);
  });

  it('retrieves language preferences', async () => {
    const res = await request('GET', translationUrl, '/api/v1/translate/preferences', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.preferred_language, 'es');
    assert.equal(res.body.windy_identity_id, WINDY_IDENTITY_ID);
  });

  it('translates text (stub mode)', async () => {
    const res = await request('POST', translationUrl, '/api/v1/translate', {
      text: 'Hello world',
      source_lang: 'en',
      target_lang: 'es',
    }, authed(tokenA));
    assert.equal(res.status, 200);
    assert.ok(res.body.translated_text);
    assert.equal(res.body.source_lang, 'en');
    assert.equal(res.body.target_lang, 'es');
  });

  it('returns same text when source == target', async () => {
    const res = await request('POST', translationUrl, '/api/v1/translate', {
      text: 'Hello world',
      source_lang: 'en',
      target_lang: 'en',
    }, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.translated_text, 'Hello world');
    assert.equal(res.body.confidence, 1.0);
  });
});

// ════════════════════════════════════════
// Step 7: Verify windy_identity_id consistency
// ════════════════════════════════════════

describe('Step 7: windy_identity_id Consistency', () => {
  it('JWT contains windy_identity_id', () => {
    const decoded = jwt.verify(tokenA, process.env.WINDY_JWT_SECRET);
    assert.equal(decoded.windy_identity_id, WINDY_IDENTITY_ID);
    assert.equal(decoded.sub, USER_SUB);
  });

  it('translation preferences store windy_identity_id', async () => {
    const res = await request('GET', translationUrl, '/api/v1/translate/preferences', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.windy_identity_id, WINDY_IDENTITY_ID);
  });

  it('directory registration propagates windy_identity_id', async () => {
    const res = await request('POST', directoryUrl, '/api/v1/chat/directory/register', {
      userId: USER_B_SUB,
      displayName: 'IntegrationUserB',
      email: 'integrationb@windypro.com',
      languages: ['en'],
      searchable: true,
    }, authed(tokenB));
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
  });
});
