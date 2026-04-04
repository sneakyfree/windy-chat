/**
 * Tests for Windy Chat — Unified Eternitas Webhook Handler
 *
 * Run: node --test tests/unit/test-eternitas-webhook.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.CHAT_API_TOKEN = 'test-webhook-token';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ETERNITAS_WEBHOOK_SECRET = 'test-eternitas-secret';

const { app } = require('../../services/social/server');

let server;
let baseUrl;

function sign(body) {
  return crypto.createHmac('sha256', process.env.ETERNITAS_WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CHAT_API_TOKEN}`,
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

// ── Validation ──

describe('POST /api/v1/webhooks/eternitas — validation', () => {
  it('rejects missing required fields', async () => {
    const body = { event: 'passport.revoked' };
    const res = await request('POST', '/api/v1/webhooks/eternitas', body, {
      'x-eternitas-signature': sign(body),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Missing required/);
  });

  it('rejects invalid event type', async () => {
    const body = { event: 'passport.deleted', passport: 'ET-001', bot_name: 'TestBot', timestamp: Date.now() };
    const res = await request('POST', '/api/v1/webhooks/eternitas', body, {
      'x-eternitas-signature': sign(body),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid event type/);
  });

  it('rejects invalid HMAC signature', async () => {
    const body = { event: 'passport.revoked', passport: 'ET-001', bot_name: 'TestBot', timestamp: Date.now() };
    const res = await request('POST', '/api/v1/webhooks/eternitas', body, {
      'x-eternitas-signature': 'invalid-signature-hex-value-that-is-wrong',
    });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid webhook signature/);
  });
});

// ── Passport Revoked ──

describe('POST /api/v1/webhooks/eternitas — passport.revoked', () => {
  it('acknowledges immediately with 200', async () => {
    const body = {
      event: 'passport.revoked',
      passport: 'ET-REVOKE-001',
      bot_name: 'RevokeBot',
      operator_id: 'admin-1',
      reason: 'violation',
      timestamp: Date.now(),
    };
    const res = await request('POST', '/api/v1/webhooks/eternitas', body, {
      'x-eternitas-signature': sign(body),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, true);
    assert.equal(res.body.event, 'passport.revoked');
    assert.equal(res.body.passport, 'ET-REVOKE-001');
  });

  it('removes verified badge after revocation', async () => {
    // First, add a verified badge
    const { verifiedAccounts } = require('../../services/social/lib/store');
    verifiedAccounts.add('bot_ET-REVOKE-002');
    assert.equal(verifiedAccounts.has('bot_ET-REVOKE-002'), true);

    const body = {
      event: 'passport.revoked',
      passport: 'ET-REVOKE-002',
      bot_name: 'RevokeBot2',
      timestamp: Date.now(),
    };
    await request('POST', '/api/v1/webhooks/eternitas', body, {
      'x-eternitas-signature': sign(body),
    });

    // Give async processing time to complete
    await new Promise(r => setTimeout(r, 100));
    assert.equal(verifiedAccounts.has('bot_ET-REVOKE-002'), false);
  });
});

// ── Passport Suspended ──

describe('POST /api/v1/webhooks/eternitas — passport.suspended', () => {
  it('acknowledges and removes verified badge', async () => {
    const { verifiedAccounts } = require('../../services/social/lib/store');
    verifiedAccounts.add('bot_ET-SUSPEND-001');

    const body = {
      event: 'passport.suspended',
      passport: 'ET-SUSPEND-001',
      bot_name: 'SuspendBot',
      timestamp: Date.now(),
    };
    const res = await request('POST', '/api/v1/webhooks/eternitas', body, {
      'x-eternitas-signature': sign(body),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, true);

    await new Promise(r => setTimeout(r, 100));
    assert.equal(verifiedAccounts.has('bot_ET-SUSPEND-001'), false);
  });
});

// ── Passport Reinstated ──

describe('POST /api/v1/webhooks/eternitas — passport.reinstated', () => {
  it('restores verified badge after reinstatement', async () => {
    const { verifiedAccounts } = require('../../services/social/lib/store');

    // Ensure not verified first
    verifiedAccounts.delete('bot_ET-REINSTATE-001');
    assert.equal(verifiedAccounts.has('bot_ET-REINSTATE-001'), false);

    const body = {
      event: 'passport.reinstated',
      passport: 'ET-REINSTATE-001',
      bot_name: 'ReinstateBot',
      operator_id: 'admin-1',
      reason: 'appeal approved',
      timestamp: Date.now(),
    };
    const res = await request('POST', '/api/v1/webhooks/eternitas', body, {
      'x-eternitas-signature': sign(body),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, true);

    await new Promise(r => setTimeout(r, 100));
    assert.equal(verifiedAccounts.has('bot_ET-REINSTATE-001'), true);

    // Cleanup
    verifiedAccounts.delete('bot_ET-REINSTATE-001');
  });
});

// ── Full lifecycle ──

describe('POST /api/v1/webhooks/eternitas — full lifecycle', () => {
  it('handles suspend → reinstate sequence', async () => {
    const { verifiedAccounts } = require('../../services/social/lib/store');
    verifiedAccounts.add('bot_ET-LIFECYCLE-001');

    // Suspend
    const suspendBody = {
      event: 'passport.suspended',
      passport: 'ET-LIFECYCLE-001',
      bot_name: 'LifecycleBot',
      timestamp: Date.now(),
    };
    await request('POST', '/api/v1/webhooks/eternitas', suspendBody, {
      'x-eternitas-signature': sign(suspendBody),
    });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(verifiedAccounts.has('bot_ET-LIFECYCLE-001'), false);

    // Reinstate
    const reinstateBody = {
      event: 'passport.reinstated',
      passport: 'ET-LIFECYCLE-001',
      bot_name: 'LifecycleBot',
      timestamp: Date.now(),
    };
    await request('POST', '/api/v1/webhooks/eternitas', reinstateBody, {
      'x-eternitas-signature': sign(reinstateBody),
    });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(verifiedAccounts.has('bot_ET-LIFECYCLE-001'), true);

    // Cleanup
    verifiedAccounts.delete('bot_ET-LIFECYCLE-001');
  });
});
