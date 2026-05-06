/**
 * Tests for Windy Chat — Translation Service (K9)
 *
 * Run: node --test tests/unit/test-translation.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-token-translation';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.WINDY_TRANSLATE_URL = 'http://127.0.0.1:19877'; // will start mock below

// Clean data dir before loading the service
const dataDir = path.join(__dirname, '..', '..', 'services', 'translation', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../../services/translation/server');
const jwt = require('../../services/translation/node_modules/jsonwebtoken');

let server;
let baseUrl;
let mockTranslateServer;

function makeJwt(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId || sub },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const TOKEN = makeJwt('translate-user-1', 'wid-translate-1');

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

before(async () => {
  // Start mock translate server that echoes back reversed text
  mockTranslateServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const { text, source_lang, target_lang } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          translated_text: `[${target_lang}] ${text}`,
          confidence: 0.95,
        }));
      } catch {
        res.writeHead(400);
        res.end('{}');
      }
    });
  });

  await new Promise((resolve) => {
    mockTranslateServer.listen(19877, resolve);
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => {
  mockTranslateServer.close(() => {
    server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
  });
}));

// ── Health ──

describe('GET /health', () => {
  it('returns service status', async () => {
    const res = await request('GET', '/health', null, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'windy-chat-translation');
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
  it('rejects missing auth on translate endpoint', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'hello', source_lang: 'en', target_lang: 'es',
    }, { Authorization: '' });
    assert.equal(res.status, 401);
  });

  it('rejects missing auth on preferences GET', async () => {
    const res = await request('GET', '/api/v1/translate/preferences', null, { Authorization: '' });
    assert.equal(res.status, 401);
  });

  it('rejects missing auth on preferences POST', async () => {
    const res = await request('POST', '/api/v1/translate/preferences', {
      preferred_language: 'es',
    }, { Authorization: '' });
    assert.equal(res.status, 401);
  });
});

// ── POST /api/v1/translate — Validation ──

describe('POST /api/v1/translate — validation', () => {
  it('rejects missing text', async () => {
    const res = await request('POST', '/api/v1/translate', {
      source_lang: 'en', target_lang: 'es',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /text/);
  });

  it('rejects empty text', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: '  ', source_lang: 'en', target_lang: 'es',
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing source_lang', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'hello', target_lang: 'es',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /source_lang/);
  });

  it('rejects missing target_lang', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'hello', source_lang: 'en',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /target_lang/);
  });
});

// ── POST /api/v1/translate — Translation ──

describe('POST /api/v1/translate — translation', () => {
  it('returns same text when source === target', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'hello', source_lang: 'en', target_lang: 'en',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.translated_text, 'hello');
    assert.equal(res.body.confidence, 1.0);
    assert.equal(res.body.cached, false);
  });

  it('forwards to translate server and returns result', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'Hello world', source_lang: 'en', target_lang: 'es',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.translated_text, '[es] Hello world');
    assert.equal(res.body.confidence, 0.95);
    assert.equal(res.body.cached, false);
    assert.equal(res.body.source_lang, 'en');
    assert.equal(res.body.target_lang, 'es');
  });

  it('returns cached result on second identical request', async () => {
    // First request to populate cache
    await request('POST', '/api/v1/translate', {
      text: 'Cache me', source_lang: 'en', target_lang: 'fr',
    });

    // Second request should be cached
    const res = await request('POST', '/api/v1/translate', {
      text: 'Cache me', source_lang: 'en', target_lang: 'fr',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.translated_text, '[fr] Cache me');
    assert.equal(res.body.cached, true);
  });

  it('different target lang is not cached', async () => {
    const res = await request('POST', '/api/v1/translate', {
      text: 'Cache me', source_lang: 'en', target_lang: 'de',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.translated_text, '[de] Cache me');
    assert.equal(res.body.cached, false);
  });
});

// ── Language Preferences ──

describe('GET /api/v1/translate/preferences', () => {
  it('returns defaults for new user', async () => {
    const res = await request('GET', '/api/v1/translate/preferences');
    assert.equal(res.status, 200);
    assert.equal(res.body.preferred_language, 'en');
    assert.equal(res.body.auto_translate, true);
  });
});

describe('POST /api/v1/translate/preferences', () => {
  it('rejects missing preferred_language', async () => {
    const res = await request('POST', '/api/v1/translate/preferences', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /preferred_language/);
  });

  it('rejects too-short language code', async () => {
    const res = await request('POST', '/api/v1/translate/preferences', {
      preferred_language: 'x',
    });
    assert.equal(res.status, 400);
  });

  it('saves preferences successfully', async () => {
    const res = await request('POST', '/api/v1/translate/preferences', {
      preferred_language: 'es',
      auto_translate: false,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.preferred_language, 'es');
    assert.equal(res.body.auto_translate, false);
  });

  it('persists preferences across GET', async () => {
    const res = await request('GET', '/api/v1/translate/preferences');
    assert.equal(res.status, 200);
    assert.equal(res.body.preferred_language, 'es');
    assert.equal(res.body.auto_translate, false);
  });

  it('updates preferences idempotently', async () => {
    await request('POST', '/api/v1/translate/preferences', {
      preferred_language: 'fr',
      auto_translate: true,
    });
    const res = await request('GET', '/api/v1/translate/preferences');
    assert.equal(res.body.preferred_language, 'fr');
    assert.equal(res.body.auto_translate, true);
  });
});

// ── Appservice endpoints ──

describe('Appservice — /_matrix/app/v1', () => {
  it('PUT /transactions/:txnId responds with empty JSON', async () => {
    const res = await request('PUT', '/_matrix/app/v1/transactions/txn-test-1', {
      events: [],
    }, { Authorization: '' });
    assert.equal(res.status, 200);
  });

  it('PUT /transactions/:txnId handles text message events', async () => {
    const res = await request('PUT', '/_matrix/app/v1/transactions/txn-test-2', {
      events: [{
        type: 'm.room.message',
        sender: '@alice:chat.windychat.ai',
        room_id: '!testroom:chat.windychat.ai',
        event_id: '$event1',
        content: {
          msgtype: 'm.text',
          body: 'Hello everyone',
        },
      }],
    }, { Authorization: '' });
    assert.equal(res.status, 200);
  });

  it('GET /rooms/:alias returns 404 (appservice does not create rooms)', async () => {
    const res = await request('GET', '/_matrix/app/v1/rooms/%23test:chat.windychat.ai', null, { Authorization: '' });
    assert.equal(res.status, 404);
  });

  it('GET /users/:userId returns 404 (appservice does not create users)', async () => {
    const res = await request('GET', '/_matrix/app/v1/users/@test:chat.windychat.ai', null, { Authorization: '' });
    assert.equal(res.status, 404);
  });

  it('POST /rooms/:roomId/languages sets room language config', async () => {
    const res = await request('POST', '/_matrix/app/v1/rooms/!room1:chat.windychat.ai/languages', {
      users: {
        '@alice:chat.windychat.ai': 'en',
        '@bob:chat.windychat.ai': 'es',
      },
    }, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user_count, 2);
    assert.equal(res.body.languages['@alice:chat.windychat.ai'], 'en');
  });

  it('POST /rooms/:roomId/languages rejects missing users object', async () => {
    const res = await request('POST', '/_matrix/app/v1/rooms/!room1:chat.windychat.ai/languages', {}, { Authorization: '' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /users/);
  });
});

// ── Registration YAML ──

describe('Appservice registration', () => {
  it('registration.yaml exists and is valid', () => {
    const regPath = path.join(__dirname, '..', '..', 'services', 'translation', 'appservice', 'registration.yaml');
    assert.ok(fs.existsSync(regPath), 'registration.yaml should exist');
    const content = fs.readFileSync(regPath, 'utf-8');
    assert.ok(content.includes('id: windy-translation'));
    assert.ok(content.includes('sender_localpart: "windy_translator"'));
    assert.ok(content.includes('rate_limited: false'));
  });
});
