/**
 * Contract Test: Eternitas Webhook HMAC Verification
 *
 * Proves that the social service correctly:
 *   1. Validates HMAC-SHA256 signatures from Eternitas
 *   2. Rejects invalid signatures
 *   3. Allows requests in dev mode (no secret configured)
 *   4. Processes passport lifecycle events correctly
 *
 * Run: node --test tests/integration/test_eternitas_webhook_contract.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEBHOOK_SECRET = 'eternitas-test-hmac-secret-2026';
const SERVICE_TOKEN = 'test-eternitas-service-token';

// Set env before loading
process.env.ETERNITAS_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.CHAT_API_TOKEN = SERVICE_TOKEN;
process.env.WINDY_JWT_SECRET = 'test-eternitas-jwt';
process.env.NODE_ENV = 'test';

// Clean data
const dataDir = path.join(__dirname, '..', '..', 'services', 'social', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../../services/social/server');

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
      path: url.pathname,
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

function computeSignature(payload) {
  const bodyStr = JSON.stringify(payload);
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyStr).digest('hex');
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => {
  server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
}));

// ═══════════════════════════════════════════
// Valid Signature + Payload
// ═══════════════════════════════════════════

describe('Eternitas Webhook: Valid signature', () => {
  it('accepts passport.revoked with correct HMAC', async () => {
    const payload = {
      event: 'passport.revoked',
      passport: 'ET-00001',
      bot_name: 'testbot',
      operator_id: 'op-1',
      reason: 'abuse',
      timestamp: '2026-03-31T00:00:00Z',
    };
    const signature = computeSignature(payload);

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'X-Eternitas-Signature': signature,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, true);
    assert.equal(res.body.action_taken, 'account_deactivated');
    assert.equal(res.body.event, 'passport.revoked');
  });

  it('accepts passport.suspended with correct HMAC', async () => {
    const payload = {
      event: 'passport.suspended',
      passport: 'ET-00002',
      bot_name: 'suspended-bot',
      operator_id: 'op-2',
      reason: 'investigation',
      timestamp: '2026-03-31T01:00:00Z',
    };
    const signature = computeSignature(payload);

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'X-Eternitas-Signature': signature,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.action_taken, 'account_locked');
  });

  it('accepts passport.reinstated with correct HMAC', async () => {
    const payload = {
      event: 'passport.reinstated',
      passport: 'ET-00003',
      bot_name: 'reinstated-bot',
      operator_id: 'op-3',
      reason: 'cleared',
      timestamp: '2026-03-31T02:00:00Z',
    };
    const signature = computeSignature(payload);

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'X-Eternitas-Signature': signature,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.action_taken, 'account_reactivated');
  });
});

// ═══════════════════════════════════════════
// Invalid Signatures
// ═══════════════════════════════════════════

describe('Eternitas Webhook: Invalid signature', () => {
  it('rejects wrong HMAC signature with 401', async () => {
    const payload = {
      event: 'passport.revoked',
      passport: 'ET-99999',
      bot_name: 'hacker-bot',
      operator_id: 'evil',
      reason: 'spoofed',
      timestamp: '2026-03-31T00:00:00Z',
    };

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'X-Eternitas-Signature': 'deadbeef0000000000000000000000000000000000000000000000000000cafe',
    });

    assert.equal(res.status, 401);
    assert.match(res.body.error, /signature/i);
  });

  it('rejects tampered payload', async () => {
    const originalPayload = {
      event: 'passport.revoked',
      passport: 'ET-00010',
      bot_name: 'tamper-test',
      operator_id: 'op-1',
      reason: 'test',
      timestamp: '2026-03-31T00:00:00Z',
    };

    // Sign the original
    const signature = computeSignature(originalPayload);

    // Tamper with the payload
    const tamperedPayload = { ...originalPayload, event: 'passport.reinstated' };

    const res = await request('POST', '/api/v1/social/eternitas/webhook', tamperedPayload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'X-Eternitas-Signature': signature,
    });

    assert.equal(res.status, 401);
  });
});

// ═══════════════════════════════════════════
// Validation Errors
// ═══════════════════════════════════════════

describe('Eternitas Webhook: Payload validation', () => {
  it('rejects missing required fields', async () => {
    const payload = { event: 'passport.revoked' }; // missing passport, bot_name, timestamp
    const signature = computeSignature(payload);

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'X-Eternitas-Signature': signature,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Missing/);
  });

  it('rejects invalid event type', async () => {
    const payload = {
      event: 'passport.deleted',
      passport: 'ET-00001',
      bot_name: 'test',
      timestamp: '2026-03-31T00:00:00Z',
    };
    const signature = computeSignature(payload);

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'X-Eternitas-Signature': signature,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /event type/i);
  });

  it('rejects unauthenticated request (no service token)', async () => {
    const payload = {
      event: 'passport.revoked',
      passport: 'ET-00001',
      bot_name: 'test',
      timestamp: '2026-03-31T00:00:00Z',
    };

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {});
    assert.equal(res.status, 401);
  });
});

// ═══════════════════════════════════════════
// Dev Mode (no secret configured)
// ═══════════════════════════════════════════

describe('Eternitas Webhook: Dev mode', () => {
  it('accepts requests without signature when ETERNITAS_WEBHOOK_SECRET is unset', async () => {
    // Temporarily unset the secret
    const original = process.env.ETERNITAS_WEBHOOK_SECRET;
    delete process.env.ETERNITAS_WEBHOOK_SECRET;

    const payload = {
      event: 'passport.revoked',
      passport: 'ET-DEV-001',
      bot_name: 'dev-bot',
      operator_id: 'dev',
      reason: 'dev-test',
      timestamp: '2026-03-31T00:00:00Z',
    };

    const res = await request('POST', '/api/v1/social/eternitas/webhook', payload, {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      // No X-Eternitas-Signature header
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, true);

    // Restore
    process.env.ETERNITAS_WEBHOOK_SECRET = original;
  });
});
