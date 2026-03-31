/**
 * Hardening: Webhook Replay Protection
 *
 * Tests:
 *   - Duplicate webhook is idempotent (not error)
 *   - Same payload twice processes safely
 *
 * Run: node --test tests/hardening/test_webhook_replay.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEBHOOK_SECRET = 'replay-test-secret';
process.env.ETERNITAS_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.CHAT_API_TOKEN = 'test-replay-token';
process.env.WINDY_JWT_SECRET = 'test-replay-jwt';
process.env.NODE_ENV = 'test';

const dataDir = path.join(__dirname, '..', '..', 'services', 'social', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../../services/social/server');
let server, baseUrl;

before(async () => {
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; r(); }); });
});
after(() => new Promise(r => { server.close(() => { setTimeout(() => process.exit(0), 100); r(); }); }));

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}), ...headers } };
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on('error', reject); if (bodyStr) r.write(bodyStr); r.end();
  });
}

function sign(payload) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex');
}

describe('Webhook Replay: Idempotent duplicate', () => {
  it('same payload sent twice both return 200', async () => {
    const payload = {
      event: 'passport.revoked',
      passport: 'ET-REPLAY-001',
      bot_name: 'replay-test-bot',
      operator_id: 'op-1',
      reason: 'test replay',
      timestamp: new Date().toISOString(),
    };
    const sig = sign(payload);
    const headers = {
      Authorization: `Bearer ${process.env.CHAT_API_TOKEN}`,
      'X-Eternitas-Signature': sig,
    };

    const res1 = await req('POST', '/api/v1/social/eternitas/webhook', payload, headers);
    assert.equal(res1.status, 200);
    assert.equal(res1.body.acknowledged, true);
    assert.equal(res1.body.action_taken, 'account_deactivated');

    // Second identical request — should be idempotent
    const res2 = await req('POST', '/api/v1/social/eternitas/webhook', payload, headers);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.acknowledged, true);
  });

  it('revoke then reinstate is processed correctly', async () => {
    const passportId = 'ET-LIFECYCLE-001';

    const revoke = {
      event: 'passport.revoked',
      passport: passportId,
      bot_name: 'lifecycle-bot',
      operator_id: 'op-1',
      reason: 'revoked',
      timestamp: new Date().toISOString(),
    };
    const revokeRes = await req('POST', '/api/v1/social/eternitas/webhook', revoke, {
      Authorization: `Bearer ${process.env.CHAT_API_TOKEN}`,
      'X-Eternitas-Signature': sign(revoke),
    });
    assert.equal(revokeRes.body.action_taken, 'account_deactivated');

    const reinstate = {
      event: 'passport.reinstated',
      passport: passportId,
      bot_name: 'lifecycle-bot',
      operator_id: 'op-1',
      reason: 'cleared',
      timestamp: new Date().toISOString(),
    };
    const reinstateRes = await req('POST', '/api/v1/social/eternitas/webhook', reinstate, {
      Authorization: `Bearer ${process.env.CHAT_API_TOKEN}`,
      'X-Eternitas-Signature': sign(reinstate),
    });
    assert.equal(reinstateRes.body.action_taken, 'account_reactivated');
  });

  it('all three lifecycle events work in sequence', async () => {
    const passportId = 'ET-SEQ-001';
    const events = ['passport.suspended', 'passport.reinstated', 'passport.revoked'];
    const expected = ['account_locked', 'account_reactivated', 'account_deactivated'];

    for (let i = 0; i < events.length; i++) {
      const payload = {
        event: events[i],
        passport: passportId,
        bot_name: 'seq-bot',
        operator_id: 'op-1',
        reason: `step ${i}`,
        timestamp: new Date().toISOString(),
      };
      const res = await req('POST', '/api/v1/social/eternitas/webhook', payload, {
        Authorization: `Bearer ${process.env.CHAT_API_TOKEN}`,
        'X-Eternitas-Signature': sign(payload),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.action_taken, expected[i]);
    }
  });
});
