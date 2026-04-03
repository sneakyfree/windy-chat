/**
 * Tests for Windy Chat — Onboarding Service NEW features
 * Avatar upload (K2) + Account deletion (GDPR)
 *
 * Run: node --test tests/unit/test-onboarding-new.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-token-onboarding-new';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

// Clean data dir before loading the service
const dataDir = path.join(__dirname, '..', '..', 'services', 'onboarding', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../../services/onboarding/server');
const jwt = require('../../services/onboarding/node_modules/jsonwebtoken');

let server;
let baseUrl;

function makeJwt(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId || sub },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

const TOKEN = makeJwt('onb-test-user', 'wid-onb-test');

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
        'Authorization': `Bearer ${TOKEN}`,
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

function uploadFile(fieldName, fileName, fileBuffer, mimeType, urlPath, authToken) {
  return new Promise((resolve, reject) => {
    const boundary = '----WindyTestBoundary' + crypto.randomBytes(8).toString('hex');
    const url = new URL(urlPath, baseUrl);
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`,
      `Content-Type: ${mimeType}\r\n\r\n`,
    ];
    const start = Buffer.from(bodyParts.join(''));
    const end = Buffer.from(`\r\n--${boundary}--\r\n`);
    const full = Buffer.concat([start, fileBuffer, end]);
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': full.length,
        'Authorization': `Bearer ${authToken}`,
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
    req.write(full);
    req.end();
  });
}

/** Fetch a raw HTTP response (used for avatar serving). */
function rawGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// ── Create a small fake JPEG (valid JFIF header) ──
function fakeJpeg(sizeBytes) {
  // Minimal JPEG: SOI + JFIF APP0 + EOI, padded to desired size
  const soi = Buffer.from([0xFF, 0xD8]);
  const eoi = Buffer.from([0xFF, 0xD9]);
  const padding = Buffer.alloc(Math.max(0, sizeBytes - 4), 0x00);
  return Buffer.concat([soi, padding, eoi]);
}

function fakePng(sizeBytes) {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const padding = Buffer.alloc(Math.max(0, sizeBytes - sig.length), 0x00);
  return Buffer.concat([sig, padding]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────────

describe('Onboarding — Avatar Upload', () => {
  before((_, done) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  // Server stays alive for the Account Deletion suite below.

  // ── Auth ──

  it('returns 401 without a valid token', async () => {
    const res = await uploadFile('avatar', 'pic.jpg', fakeJpeg(100), 'image/jpeg', '/api/v1/chat/profile/avatar', 'bad-token');
    assert.equal(res.status, 401);
  });

  // ── Validation ──

  it('returns 400 when no file is attached', async () => {
    // Send a POST with no multipart body
    const res = await request('POST', '/api/v1/chat/profile/avatar', null);
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('rejects disallowed file type (.exe)', async () => {
    const exeBuf = Buffer.alloc(128, 0x90); // NOP sled, whatever
    const res = await uploadFile('avatar', 'malware.exe', exeBuf, 'application/x-msdownload', '/api/v1/chat/profile/avatar', TOKEN);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not allowed/i);
  });

  it('rejects file over 5 MB', async () => {
    const bigBuf = Buffer.alloc(5 * 1024 * 1024 + 1, 0xFF);
    const res = await uploadFile('avatar', 'huge.jpg', bigBuf, 'image/jpeg', '/api/v1/chat/profile/avatar', TOKEN);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /too large|5MB/i);
  });

  // ── Successful uploads ──

  it('uploads a JPEG avatar (201) and returns expected fields', async () => {
    const buf = fakeJpeg(512);
    const res = await uploadFile('avatar', 'selfie.jpg', buf, 'image/jpeg', '/api/v1/chat/profile/avatar', TOKEN);
    assert.equal(res.status, 201);
    assert.ok(res.body.avatar_url);
    assert.ok(res.body.filename);
    assert.equal(res.body.size, buf.length);
    assert.equal(res.body.mime_type, 'image/jpeg');
  });

  it('uploads a PNG avatar', async () => {
    const buf = fakePng(256);
    const res = await uploadFile('avatar', 'logo.png', buf, 'image/png', '/api/v1/chat/profile/avatar', TOKEN);
    assert.equal(res.status, 201);
    assert.equal(res.body.mime_type, 'image/png');
    assert.ok(res.body.filename.endsWith('.png'));
  });

  // ── Serving ──

  it('serves an uploaded avatar via GET', async () => {
    // Upload first
    const buf = fakeJpeg(128);
    const up = await uploadFile('avatar', 'serve-test.jpg', buf, 'image/jpeg', '/api/v1/chat/profile/avatar', TOKEN);
    assert.equal(up.status, 201);

    // Fetch it — the route is behind the profile auth middleware prefix,
    // so we pass the token via query-less GET with Authorization header.
    const res = await request('GET', up.body.avatar_url, null);
    assert.equal(res.status, 200);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe('Onboarding — Account Deletion', () => {
  after(() => {
    server.close();
    setTimeout(() => process.exit(0), 100);
  });

  it('returns 401 without a valid token', async () => {
    const res = await request('DELETE', '/api/v1/onboarding/account', null, {
      Authorization: 'Bearer invalid-token',
    });
    assert.equal(res.status, 401);
  });

  it('deletes an account and returns { deleted: true }', async () => {
    // 1. Create a fresh user + profile
    const userId = 'del-user-' + crypto.randomBytes(4).toString('hex');
    const windyId = 'wid-del-' + crypto.randomBytes(4).toString('hex');
    const userToken = makeJwt(userId, windyId);

    const uniqueName = 'DelUser ' + crypto.randomBytes(4).toString('hex');
    const setup = await request('POST', '/api/v1/chat/profile/setup', {
      verificationToken: 'tok-' + crypto.randomBytes(8).toString('hex'),
      displayName: uniqueName,
      languages: ['en'],
    }, { Authorization: `Bearer ${userToken}` });
    assert.equal(setup.status, 201, `Profile setup should succeed, got ${setup.status}: ${JSON.stringify(setup.body)}`);

    const chatUserId = setup.body.profile.chatUserId;
    assert.ok(chatUserId);

    // 2. Delete account
    const del = await request('DELETE', '/api/v1/onboarding/account', null, {
      Authorization: `Bearer ${userToken}`,
    });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    assert.equal(del.body.local_data_removed, true);

    // 3. Profile should be gone (404)
    const profile = await request('GET', `/api/v1/chat/profile/${chatUserId}`, null, {
      Authorization: `Bearer ${userToken}`,
    });
    assert.equal(profile.status, 404);
  });
});
