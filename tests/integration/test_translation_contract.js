/**
 * Contract Test: Translation Proxy ↔ Windy Pro Translate API
 *
 * Proves that the translation proxy correctly:
 *   1. Forwards requests to WINDY_TRANSLATE_URL
 *   2. Returns the correct response format
 *   3. Caches translations (24h TTL)
 *   4. Degrades gracefully when translate server is down
 *
 * Run: node --test tests/integration/test_translation_contract.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let mockTranslateServer;
let mockTranslatePort;
let lastTranslateRequest = null;

// Set env vars early (before any module loads)
process.env.WINDY_JWT_SECRET = 'test-translate-jwt';
process.env.CHAT_API_TOKEN = 'test-translate-token';
process.env.NODE_ENV = 'test';

// Track requests to mock translate server
before(async () => {
  // Start mock Windy Pro translate-api
  mockTranslateServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/translate') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        const parsed = JSON.parse(body);
        lastTranslateRequest = parsed;

        // Simulate translation
        const translations = {
          'en:es': { text: 'Hola mundo', confidence: 0.95 },
          'en:ja': { text: 'こんにちは世界', confidence: 0.88 },
          'en:fr': { text: 'Bonjour le monde', confidence: 0.92 },
        };
        const key = `${parsed.source_lang}:${parsed.target_lang}`;
        const result = translations[key];

        if (result) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            translated_text: result.text,
            confidence: result.confidence,
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            translated_text: `[${parsed.target_lang}] ${parsed.text}`,
            confidence: 0.5,
          }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => {
    mockTranslateServer.listen(0, () => {
      mockTranslatePort = mockTranslateServer.address().port;
      resolve();
    });
  });

  // Point to mock translate server
  process.env.WINDY_TRANSLATE_URL = `http://localhost:${mockTranslatePort}`;

  // Clean data
  const dataDir = path.join(__dirname, '..', '..', 'services', 'translation', 'data');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dataDir, { recursive: true });

  // Clear ALL cached service modules so translation picks up new env vars
  for (const key of Object.keys(require.cache)) {
    if (key.includes('services/')) delete require.cache[key];
  }
  const { app } = require('../../services/translation/server');
  await new Promise((resolve) => {
    translationServer = app.listen(0, () => {
      translationUrl = `http://localhost:${translationServer.address().port}`;
      resolve();
    });
  });
});

let translationServer;
let translationUrl;

after(() => new Promise((resolve) => {
  let closed = 0;
  const onClose = () => { closed++; if (closed >= 2) { setTimeout(() => process.exit(0), 100); resolve(); } };
  translationServer.close(onClose);
  mockTranslateServer.close(onClose);
}));

const jwt = require('../../services/social/node_modules/jsonwebtoken');
const token = jwt.sign(
  { sub: 'translate_test_user', windy_identity_id: 'translate-uuid' },
  process.env.WINDY_JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' }
);

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, translationUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
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

// ═══════════════════════════════════════════
// Request Forwarding Contract
// ═══════════════════════════════════════════

describe('Translation Contract: Request forwarding', () => {
  it('forwards {text, source_lang, target_lang} to Pro translate-api', async () => {
    lastTranslateRequest = null;
    const res = await request('POST', '/api/v1/translate', {
      text: 'Hello world',
      source_lang: 'en',
      target_lang: 'es',
    });

    assert.equal(res.status, 200);
    assert.ok(lastTranslateRequest, 'Mock translate server should have received request');
    assert.equal(lastTranslateRequest.text, 'Hello world');
    assert.equal(lastTranslateRequest.source_lang, 'en');
    assert.equal(lastTranslateRequest.target_lang, 'es');
  });

  it('returns correct response format', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'Hello world',
      source_lang: 'en',
      target_lang: 'ja',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.translated_text, 'こんにちは世界');
    assert.equal(res.body.source_lang, 'en');
    assert.equal(res.body.target_lang, 'ja');
    assert.equal(res.body.confidence, 0.88);
    assert.equal(typeof res.body.cached, 'boolean');
  });
});

// ═══════════════════════════════════════════
// Caching Contract
// ═══════════════════════════════════════════

describe('Translation Contract: Caching', () => {
  it('caches translation results', async () => {
    // First call
    lastTranslateRequest = null;
    await request('POST', '/api/v1/translate', {
      text: 'Cached test',
      source_lang: 'en',
      target_lang: 'fr',
    });
    assert.ok(lastTranslateRequest, 'First call should hit translate server');

    // Second call with same text
    lastTranslateRequest = null;
    const res = await request('POST', '/api/v1/translate', {
      text: 'Cached test',
      source_lang: 'en',
      target_lang: 'fr',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.cached, true);
    assert.equal(lastTranslateRequest, null, 'Second call should use cache, not hit server');
  });

  it('returns same-language text without calling server', async () => {
    lastTranslateRequest = null;
    const res = await request('POST', '/api/v1/translate', {
      text: 'Same language',
      source_lang: 'en',
      target_lang: 'en',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.translated_text, 'Same language');
    assert.equal(res.body.confidence, 1.0);
    assert.equal(lastTranslateRequest, null, 'Same-lang should not call translate server');
  });
});

// ═══════════════════════════════════════════
// Graceful Degradation
// ═══════════════════════════════════════════

describe('Translation Contract: Server down', () => {
  it('returns stub when translate server is unreachable', async () => {
    // Temporarily point to non-existent server
    // Since WINDY_TRANSLATE_URL is read at module load, we need to test
    // with a text that isn't cached and relies on the mock server being down.
    // Instead, stop the mock server temporarily.
    await new Promise((resolve) => mockTranslateServer.close(resolve));

    const res = await request('POST', '/api/v1/translate', {
      text: 'Server is down test ' + Date.now(),
      source_lang: 'en',
      target_lang: 'de',
    });

    assert.equal(res.status, 200);
    assert.ok(res.body.translated_text);
    assert.equal(res.body.stub, true);

    // Restart mock server
    await new Promise((resolve) => {
      mockTranslateServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ translated_text: 'restored', confidence: 1.0 }));
      });
      mockTranslateServer.listen(mockTranslatePort, resolve);
    });
  });
});

// ═══════════════════════════════════════════
// Input Validation
// ═══════════════════════════════════════════

describe('Translation Contract: Validation', () => {
  it('rejects missing text', async () => {
    const res = await request('POST', '/api/v1/translate', {
      source_lang: 'en',
      target_lang: 'es',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /text/);
  });

  it('rejects missing source_lang', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'hello',
      target_lang: 'es',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /source_lang/);
  });

  it('rejects missing target_lang', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'hello',
      source_lang: 'en',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /target_lang/);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ text: 'hello', source_lang: 'en', target_lang: 'es' });
      const url = new URL('/api/v1/translate', translationUrl);
      const req = http.request({
        method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.equal(res.status, 401);
  });
});
