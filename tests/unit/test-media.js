/**
 * Tests for Windy Chat — Media Service (K4)
 *
 * Run: node --test tests/unit/test-media.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-token-media';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

// Clean data dir before loading the service
const dataDir = path.join(__dirname, '..', '..', 'services', 'media', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(path.join(dataDir, 'media', 'thumbnails'), { recursive: true });

const { app } = require('../../services/media/server');
const jwt = require('../../services/media/node_modules/jsonwebtoken');

let server;
let baseUrl;

function makeJwt(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId || sub },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const TOKEN = makeJwt('media-test-user', 'wid-media-test');

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

function uploadFile(fieldName, fileName, fileBuffer, mimeType, authToken) {
  return new Promise((resolve, reject) => {
    const boundary = '----WindyTestBoundary' + crypto.randomBytes(8).toString('hex');
    const url = new URL('/api/v1/media/upload', baseUrl);

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
        'Authorization': `Bearer ${authToken || TOKEN}`,
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

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
}));

// ── Health ──

describe('GET /health', () => {
  it('returns service status', async () => {
    const res = await request('GET', '/health', null, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'windy-chat-media');
    assert.ok(res.body.uptime);
  });
});

// ── 404 ──

describe('Unknown routes', () => {
  it('returns 404 JSON', async () => {
    const res = await request('GET', '/nonexistent');
    assert.equal(res.status, 404);
  });
});

// ── Auth ──

describe('Auth', () => {
  it('rejects missing auth on upload', async () => {
    const res = await uploadFile('file', 'test.jpg', Buffer.from('fake'), 'image/jpeg', 'invalid.jwt.token');
    assert.equal(res.status, 401);
  });
});

// ── Upload validation ──

describe('POST /api/v1/media/upload', () => {
  it('rejects request with no file', async () => {
    // Send a multipart request with no file field
    const boundary = '----WindyTestBoundary' + crypto.randomBytes(8).toString('hex');
    const url = new URL('/api/v1/media/upload', baseUrl);
    const body = Buffer.from(`--${boundary}--\r\n`);

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'Authorization': `Bearer ${TOKEN}`,
        },
      }, (r) => {
        let data = '';
        r.on('data', (c) => data += c);
        r.on('end', () => {
          try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: r.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /[Nn]o file/);
  });

  it('rejects disallowed file type (.exe)', async () => {
    const res = await uploadFile('file', 'malware.exe', Buffer.from('MZ'), 'application/x-msdownload');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not allowed/);
  });

  it('uploads a valid JPEG image', async () => {
    // Create a minimal valid-ish JPEG (just needs the right header for multer)
    const fakeJpeg = Buffer.alloc(1024);
    fakeJpeg[0] = 0xFF; fakeJpeg[1] = 0xD8; // JPEG SOI marker
    const res = await uploadFile('file', 'photo.jpg', fakeJpeg, 'image/jpeg');
    assert.equal(res.status, 201);
    assert.ok(res.body.media_id);
    assert.ok(res.body.url);
    assert.equal(res.body.mime_type, 'image/jpeg');
    assert.equal(res.body.size, 1024);
    assert.equal(res.body.original_name, 'photo.jpg');
  });

  it('uploads a PDF document', async () => {
    const fakePdf = Buffer.from('%PDF-1.4 fake content');
    const res = await uploadFile('file', 'doc.pdf', fakePdf, 'application/pdf');
    assert.equal(res.status, 201);
    assert.equal(res.body.mime_type, 'application/pdf');
    assert.equal(res.body.original_name, 'doc.pdf');
    assert.equal(res.body.thumbnail_url, null); // no thumbnails for PDFs
  });

  it('uploads an audio file', async () => {
    const fakeAudio = Buffer.alloc(512);
    const res = await uploadFile('file', 'song.mp3', fakeAudio, 'audio/mpeg');
    assert.equal(res.status, 201);
    assert.equal(res.body.mime_type, 'audio/mpeg');
    assert.equal(res.body.thumbnail_url, null); // no thumbnails for audio
  });

  it('uploads a PNG image', async () => {
    const fakePng = Buffer.alloc(256);
    const res = await uploadFile('file', 'image.png', fakePng, 'image/png');
    assert.equal(res.status, 201);
    assert.equal(res.body.mime_type, 'image/png');
  });
});

// ── Serve file ──

describe('GET /api/v1/media/:id', () => {
  let uploadedMediaId;

  before(async () => {
    const fakeFile = Buffer.from('hello world file content');
    const res = await uploadFile('file', 'serve-test.pdf', fakeFile, 'application/pdf');
    uploadedMediaId = res.body.media_id;
  });

  it('serves an uploaded file with correct Content-Type', async () => {
    const url = new URL(`/api/v1/media/${uploadedMediaId}`, baseUrl);
    const res = await new Promise((resolve, reject) => {
      http.get(url, (r) => {
        let data = '';
        r.on('data', (c) => data += c);
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: data }));
      }).on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.ok(res.headers['content-disposition'].includes('serve-test.pdf'));
  });

  it('returns 404 for non-existent media', async () => {
    const res = await request('GET', '/api/v1/media/nonexistent-id', null, { Authorization: '' });
    assert.equal(res.status, 404);
  });
});

// ── Thumbnail ──

describe('GET /api/v1/media/:id/thumbnail', () => {
  it('returns 404 for media with no thumbnail', async () => {
    // Upload a PDF (no thumbnail generated)
    const fakeFile = Buffer.from('pdf content');
    const upload = await uploadFile('file', 'no-thumb.pdf', fakeFile, 'application/pdf');
    const mediaId = upload.body.media_id;

    const res = await request('GET', `/api/v1/media/${mediaId}/thumbnail`, null, { Authorization: '' });
    assert.equal(res.status, 404);
  });

  it('returns 404 for non-existent media thumbnail', async () => {
    const res = await request('GET', '/api/v1/media/nonexistent/thumbnail', null, { Authorization: '' });
    assert.equal(res.status, 404);
  });
});
