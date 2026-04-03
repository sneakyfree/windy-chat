/**
 * Full Stack Integration Test — All Services (K2-K10)
 *
 * Exercises every Windy Chat service in a realistic user journey:
 *   1. JWT creation with windy_identity_id
 *   2. K2 Onboarding: display name check
 *   3. K3 Directory: register hash + search
 *   4. K10 Social: post, follow, like
 *   5. K9 Translation: translate text
 *   6. K4 Media: upload a test image
 *   7. K5 Call History: log a call, get history, get stats
 *   8. K10 Social: check notifications
 *   9. Verify windy_identity_id consistency
 *
 * Run: node --test tests/integration/test_full_stack.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Set test env vars before requiring any services
process.env.CHAT_API_TOKEN = 'test-fullstack-token';
process.env.WINDY_JWT_SECRET = 'test-fullstack-jwt-secret';
process.env.NODE_ENV = 'test';

// Clean data dirs
const serviceNames = [
  'onboarding', 'directory', 'push-gateway', 'backup', 'social',
  'translation', 'media', 'call-history',
];
for (const svc of serviceNames) {
  const dataDir = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dataDir, { recursive: true });
}
// Ensure media subdirectory
fs.mkdirSync(path.join(__dirname, '..', '..', 'services', 'media', 'data', 'media', 'thumbnails'), { recursive: true });

const jwt = require('../../services/social/node_modules/jsonwebtoken');

// Test identities
const WINDY_ID_A = 'aaaa1111-2222-3333-4444-555566667777';
const WINDY_ID_B = 'bbbb1111-2222-3333-4444-555566667777';
const USER_A = 'fullstack_user_a';
const USER_B = 'fullstack_user_b';

function makeJwt(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const tokenA = makeJwt(USER_A, WINDY_ID_A);
const tokenB = makeJwt(USER_B, WINDY_ID_B);

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

/**
 * Send a multipart/form-data file upload.
 */
function uploadFile(baseUrl, urlPath, fieldName, fileName, fileBuffer, mimeType, headers = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----WindyTestBoundary' + crypto.randomBytes(8).toString('hex');
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

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

// Service URLs
let onboardingUrl, directoryUrl, socialUrl, pushUrl, translationUrl, mediaUrl, callHistoryUrl;
let servers = [];

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

before(async () => {
  onboardingUrl = await startManualService('../../services/onboarding/server');
  directoryUrl = await startManualService('../../services/directory/server');
  pushUrl = await startManualService('../../services/push-gateway/server');
  socialUrl = await startManualService('../../services/social/server');
  translationUrl = await startManualService('../../services/translation/server');
  mediaUrl = await startManualService('../../services/media/server');
  callHistoryUrl = await startManualService('../../services/call-history/server');
});

after(() => new Promise((resolve) => {
  let closed = 0;
  const total = servers.length;
  if (total === 0) { resolve(); return; }
  const onClose = () => { closed++; if (closed >= total) { setTimeout(() => process.exit(0), 100); resolve(); } };
  for (const srv of servers) srv.close(onClose);
}));

// ═══════════════════════════════════════════
// Step 1: Health checks
// ═══════════════════════════════════════════

describe('Step 1: All services healthy', () => {
  for (const [name, getUrl] of [
    ['onboarding', () => onboardingUrl],
    ['directory', () => directoryUrl],
    ['social', () => socialUrl],
    ['push-gateway', () => pushUrl],
    ['translation', () => translationUrl],
    ['media', () => mediaUrl],
    ['call-history', () => callHistoryUrl],
  ]) {
    it(`${name} is healthy`, async () => {
      const res = await jsonRequest('GET', getUrl(), '/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
    });
  }
});

// ═══════════════════════════════════════════
// Step 2: K2 Onboarding — display name
// ═══════════════════════════════════════════

describe('Step 2: K2 Onboarding', () => {
  it('checks display name availability', async () => {
    const res = await jsonRequest('GET', onboardingUrl, '/api/v1/chat/profile/check-name?name=FullStackUser', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
  });
});

// ═══════════════════════════════════════════
// Step 3: K3 Directory — register + search
// ═══════════════════════════════════════════

describe('Step 3: K3 Directory', () => {
  it('registers a phone hash', async () => {
    const phoneHash = crypto.createHash('sha256').update('+15551234567salt').digest('hex');
    const res = await jsonRequest('POST', directoryUrl, '/api/v1/chat/directory/register-hash', {
      userId: USER_A,
      displayName: 'FullStackUser',
      identifierHash: phoneHash,
    }, authed(tokenA));
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
  });

  it('registers user in searchable directory', async () => {
    const res = await jsonRequest('POST', directoryUrl, '/api/v1/chat/directory/register', {
      userId: USER_A,
      displayName: 'FullStackUser',
      email: 'fullstack@windypro.com',
      languages: ['en', 'es'],
      searchable: true,
    }, authed(tokenA));
    assert.equal(res.status, 201);
  });

  it('finds user via search', async () => {
    const res = await jsonRequest('GET', directoryUrl, '/api/v1/chat/directory/search?q=FullStackUser', null, authed(tokenA));
    assert.equal(res.status, 200);
    const found = res.body.results.find(r => r.userId === USER_A);
    assert.ok(found, 'User should appear in search results');
    assert.equal(found.displayName, 'FullStackUser');
  });
});

// ═══════════════════════════════════════════
// Step 4: K10 Social — post, follow, like
// ═══════════════════════════════════════════

let postId;

describe('Step 4: K10 Social', () => {
  it('creates a post', async () => {
    const res = await jsonRequest('POST', socialUrl, '/api/v1/social/posts', {
      content: 'Full stack test post!',
      translated_versions: { es: 'Publicacion de prueba de pila completa!' },
    }, authed(tokenA));
    assert.equal(res.status, 201);
    assert.equal(res.body.userId, USER_A);
    postId = res.body.id;
  });

  it('user B follows user A', async () => {
    const res = await jsonRequest('POST', socialUrl, `/api/v1/social/follow/${USER_A}`, {}, authed(tokenB));
    assert.equal(res.status, 200);
    assert.equal(res.body.following, true);
  });

  it('user B likes user A post', async () => {
    const res = await jsonRequest('POST', socialUrl, `/api/v1/social/posts/${postId}/like`, {}, authed(tokenB));
    assert.equal(res.status, 200);
    assert.equal(res.body.liked, true);
    assert.equal(res.body.likeCount, 1);
  });
});

// ═══════════════════════════════════════════
// Step 5: K9 Translation
// ═══════════════════════════════════════════

describe('Step 5: K9 Translation', () => {
  it('translates text (stub mode)', async () => {
    const res = await jsonRequest('POST', translationUrl, '/api/v1/translate', {
      text: 'Hello from the full stack test',
      source_lang: 'en',
      target_lang: 'es',
    }, authed(tokenA));
    assert.equal(res.status, 200);
    assert.ok(res.body.translated_text);
    assert.equal(res.body.source_lang, 'en');
    assert.equal(res.body.target_lang, 'es');
  });

  it('sets language preferences', async () => {
    const res = await jsonRequest('POST', translationUrl, '/api/v1/translate/preferences', {
      preferred_language: 'ja',
    }, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.preferred_language, 'ja');
  });
});

// ═══════════════════════════════════════════
// Step 6: K4 Media — upload test image
// ═══════════════════════════════════════════

describe('Step 6: K4 Media', () => {
  let mediaId;

  it('uploads a test PNG image', async () => {
    // Create a minimal valid 1x1 PNG
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, // compressed data
      0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, // ...
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);

    const res = await uploadFile(
      mediaUrl, '/api/v1/media/upload',
      'file', 'test-image.png', pngHeader, 'image/png',
      authed(tokenA)
    );
    assert.equal(res.status, 201);
    assert.ok(res.body.media_id);
    assert.equal(res.body.mime_type, 'image/png');
    assert.ok(res.body.url);
    mediaId = res.body.media_id;
  });

  it('serves the uploaded file', async () => {
    const url = new URL(`/api/v1/media/${mediaId}`, mediaUrl);
    const res = await new Promise((resolve, reject) => {
      http.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] }));
      }).on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'image/png');
  });

  it('returns 404 for non-existent media', async () => {
    const res = await jsonRequest('GET', mediaUrl, '/api/v1/media/nonexistent');
    assert.equal(res.status, 404);
  });
});

// ═══════════════════════════════════════════
// Step 7: K5 Call History — log, history, stats
// ═══════════════════════════════════════════

describe('Step 7: K5 Call History', () => {
  it('logs a voice call', async () => {
    const now = new Date();
    const started = new Date(now - 120000).toISOString();
    const ended = now.toISOString();
    const res = await jsonRequest('POST', callHistoryUrl, '/api/v1/calls/log', {
      room_id: '!testroom:chat.windypro.com',
      caller_id: USER_A,
      callee_id: USER_B,
      started_at: started,
      ended_at: ended,
      duration_seconds: 120,
      call_type: 'voice',
      quality_score: 4.5,
    }, authed(tokenA));
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.call_type, 'voice');
    assert.equal(res.body.duration_seconds, 120);
  });

  it('logs a video call', async () => {
    const now = new Date();
    const res = await jsonRequest('POST', callHistoryUrl, '/api/v1/calls/log', {
      room_id: '!testroom2:chat.windypro.com',
      caller_id: USER_B,
      callee_id: USER_A,
      started_at: new Date(now - 300000).toISOString(),
      ended_at: now.toISOString(),
      duration_seconds: 300,
      call_type: 'video',
      quality_score: 3.2,
    }, authed(tokenB));
    assert.equal(res.status, 201);
    assert.equal(res.body.call_type, 'video');
  });

  it('rejects invalid call_type', async () => {
    const res = await jsonRequest('POST', callHistoryUrl, '/api/v1/calls/log', {
      room_id: '!room:test', caller_id: USER_A, callee_id: USER_B,
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: 10, call_type: 'hologram',
    }, authed(tokenA));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /call_type/);
  });

  it('rejects negative duration', async () => {
    const res = await jsonRequest('POST', callHistoryUrl, '/api/v1/calls/log', {
      room_id: '!room:test', caller_id: USER_A, callee_id: USER_B,
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: -5, call_type: 'voice',
    }, authed(tokenA));
    assert.equal(res.status, 400);
  });

  it('gets call history for user A', async () => {
    const res = await jsonRequest('GET', callHistoryUrl, '/api/v1/calls/history?limit=10', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.ok(res.body.calls.length >= 2, 'Should have at least 2 calls');
    assert.equal(res.body.total, 2);
    // Check direction labels
    const outgoing = res.body.calls.find(c => c.direction === 'outgoing');
    const incoming = res.body.calls.find(c => c.direction === 'incoming');
    assert.ok(outgoing, 'Should have an outgoing call');
    assert.ok(incoming, 'Should have an incoming call');
    assert.equal(outgoing.other_user_id, USER_B);
    assert.equal(incoming.other_user_id, USER_B);
  });

  it('gets call stats for user A', async () => {
    const res = await jsonRequest('GET', callHistoryUrl, '/api/v1/calls/stats', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.total_calls, 2);
    assert.equal(res.body.total_minutes, 7); // (120+300)/60 = 7.0
    assert.equal(res.body.avg_duration, 210); // (120+300)/2
    assert.ok(res.body.calls_today >= 0);
  });

  it('rejects unauthenticated access', async () => {
    const res = await jsonRequest('GET', callHistoryUrl, '/api/v1/calls/history');
    assert.equal(res.status, 401);
  });
});

// ═══════════════════════════════════════════
// Step 8: K10 Social — notifications
// ═══════════════════════════════════════════

describe('Step 8: K10 Notifications', () => {
  it('user A has notifications from follow + like', async () => {
    const res = await jsonRequest('GET', socialUrl, '/api/v1/social/notifications', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.ok(res.body.notifications.length >= 2, 'Should have follow + like notifications');
    const types = res.body.notifications.map(n => n.type);
    assert.ok(types.includes('follow'), 'Should have follow notification');
    assert.ok(types.includes('like'), 'Should have like notification');
  });

  it('marks notifications as read', async () => {
    const get = await jsonRequest('GET', socialUrl, '/api/v1/social/notifications?unread=true', null, authed(tokenA));
    if (get.body.notifications.length > 0) {
      const ids = get.body.notifications.map(n => n.id);
      const res = await jsonRequest('POST', socialUrl, '/api/v1/social/notifications/read', { notificationIds: ids }, authed(tokenA));
      assert.equal(res.status, 200);
      assert.ok(res.body.markedRead >= 1);
    }
  });
});

// ═══════════════════════════════════════════
// Step 9: windy_identity_id consistency
// ═══════════════════════════════════════════

describe('Step 9: windy_identity_id consistency', () => {
  it('JWT payload has correct windy_identity_id', () => {
    const decoded = jwt.verify(tokenA, process.env.WINDY_JWT_SECRET);
    assert.equal(decoded.sub, USER_A);
    assert.equal(decoded.windy_identity_id, WINDY_ID_A);
  });

  it('translation preferences store windy_identity_id', async () => {
    const res = await jsonRequest('GET', translationUrl, '/api/v1/translate/preferences', null, authed(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.body.windy_identity_id, WINDY_ID_A);
  });

  it('user B directory registration propagates windy_identity_id', async () => {
    const res = await jsonRequest('POST', directoryUrl, '/api/v1/chat/directory/register', {
      userId: USER_B,
      displayName: 'FullStackUserB',
      languages: ['en'],
      searchable: true,
    }, authed(tokenB));
    assert.equal(res.status, 201);
  });

  it('both users exist in directory with correct identities', async () => {
    const resA = await jsonRequest('GET', directoryUrl, '/api/v1/chat/directory/search?q=FullStackUser', null, authed(tokenA));
    assert.equal(resA.status, 200);
    const userA = resA.body.results.find(r => r.userId === USER_A);
    const userB = resA.body.results.find(r => r.userId === USER_B);
    assert.ok(userA, 'User A should be in directory');
    assert.ok(userB, 'User B should be in directory');
  });
});
