/**
 * Tests for Windy Chat — Call History Service (K5)
 *
 * Run: node --test tests/unit/test-call-history.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-token-call-history';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

// Clean data dir before loading the service
const dataDir = path.join(__dirname, '..', '..', 'services', 'call-history', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../../services/call-history/server');
const jwt = require('../../services/call-history/node_modules/jsonwebtoken');

let server;
let baseUrl;

function makeJwt(sub, windyId) {
  return jwt.sign(
    { sub, windy_identity_id: windyId || sub },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

const TOKEN = makeJwt('call-user-1', 'wid-call-1');

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
    assert.equal(res.body.service, 'windy-chat-call-history');
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
  it('rejects missing auth on log endpoint', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!room:chat.windypro.com',
      caller_id: 'user1',
      callee_id: 'user2',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_seconds: 60,
      call_type: 'voice',
    }, { Authorization: '' });
    assert.equal(res.status, 401);
  });

  it('rejects missing auth on history endpoint', async () => {
    const res = await request('GET', '/api/v1/calls/history', null, { Authorization: '' });
    assert.equal(res.status, 401);
  });

  it('rejects missing auth on stats endpoint', async () => {
    const res = await request('GET', '/api/v1/calls/stats', null, { Authorization: '' });
    assert.equal(res.status, 401);
  });
});

// ── POST /api/v1/calls/log — Validation ──

describe('POST /api/v1/calls/log — validation', () => {
  it('rejects missing room_id', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      caller_id: 'u1', callee_id: 'u2',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: 30, call_type: 'voice',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /room_id/);
  });

  it('rejects missing caller_id', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!r:x', callee_id: 'u2',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: 30, call_type: 'voice',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /caller_id/);
  });

  it('rejects missing callee_id', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!r:x', caller_id: 'u1',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: 30, call_type: 'voice',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /callee_id/);
  });

  it('rejects missing started_at', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!r:x', caller_id: 'u1', callee_id: 'u2',
      ended_at: new Date().toISOString(),
      duration_seconds: 30, call_type: 'voice',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /started_at/);
  });

  it('rejects negative duration', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!r:x', caller_id: 'u1', callee_id: 'u2',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: -5, call_type: 'voice',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /duration_seconds/);
  });

  it('rejects invalid call_type', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!r:x', caller_id: 'u1', callee_id: 'u2',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: 30, call_type: 'text',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /call_type/);
  });

  it('rejects quality_score out of range', async () => {
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!r:x', caller_id: 'u1', callee_id: 'u2',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_seconds: 30, call_type: 'voice', quality_score: 6,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /quality_score/);
  });
});

// ── POST /api/v1/calls/log — Create ──

describe('POST /api/v1/calls/log — create', () => {
  it('logs a voice call', async () => {
    const now = new Date();
    const started = new Date(now.getTime() - 120000).toISOString();
    const ended = now.toISOString();

    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!room1:chat.windypro.com',
      caller_id: 'call-user-1',
      callee_id: 'call-user-2',
      started_at: started,
      ended_at: ended,
      duration_seconds: 120,
      call_type: 'voice',
      quality_score: 4.5,
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.room_id, '!room1:chat.windypro.com');
    assert.equal(res.body.caller_id, 'call-user-1');
    assert.equal(res.body.callee_id, 'call-user-2');
    assert.equal(res.body.duration_seconds, 120);
    assert.equal(res.body.call_type, 'voice');
    assert.equal(res.body.quality_score, 4.5);
  });

  it('logs a video call with no quality_score', async () => {
    const now = new Date();
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!room2:chat.windypro.com',
      caller_id: 'call-user-1',
      callee_id: 'call-user-3',
      started_at: new Date(now.getTime() - 60000).toISOString(),
      ended_at: now.toISOString(),
      duration_seconds: 60,
      call_type: 'video',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.call_type, 'video');
    assert.equal(res.body.quality_score, null);
  });

  it('logs a zero-duration call (missed)', async () => {
    const now = new Date().toISOString();
    const res = await request('POST', '/api/v1/calls/log', {
      room_id: '!room3:chat.windypro.com',
      caller_id: 'call-user-4',
      callee_id: 'call-user-1',
      started_at: now,
      ended_at: now,
      duration_seconds: 0,
      call_type: 'voice',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.duration_seconds, 0);
  });
});

// ── GET /api/v1/calls/history — Pagination ──

describe('GET /api/v1/calls/history', () => {
  it('returns call history for the authenticated user', async () => {
    const res = await request('GET', '/api/v1/calls/history');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.calls));
    assert.ok(res.body.calls.length >= 2); // at least the 2 outgoing + 1 incoming call logged above
    assert.ok(typeof res.body.total === 'number');
    assert.ok(typeof res.body.limit === 'number');
    assert.ok(typeof res.body.offset === 'number');
  });

  it('includes direction (outgoing/incoming)', async () => {
    const res = await request('GET', '/api/v1/calls/history');
    const outgoing = res.body.calls.find(c => c.direction === 'outgoing');
    const incoming = res.body.calls.find(c => c.direction === 'incoming');
    assert.ok(outgoing, 'should have an outgoing call');
    assert.ok(incoming, 'should have an incoming call');
    assert.ok(outgoing.other_user_id); // callee for outgoing
    assert.ok(incoming.other_user_id); // caller for incoming
  });

  it('respects limit parameter', async () => {
    const res = await request('GET', '/api/v1/calls/history?limit=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.calls.length, 1);
    assert.equal(res.body.limit, 1);
  });

  it('respects offset parameter', async () => {
    const all = await request('GET', '/api/v1/calls/history?limit=100');
    const offset = await request('GET', '/api/v1/calls/history?limit=100&offset=1');
    assert.equal(offset.body.calls.length, all.body.calls.length - 1);
    assert.equal(offset.body.offset, 1);
  });

  it('clamps limit to 100', async () => {
    const res = await request('GET', '/api/v1/calls/history?limit=999');
    assert.equal(res.body.limit, 100);
  });
});

// ── GET /api/v1/calls/stats ──

describe('GET /api/v1/calls/stats', () => {
  it('returns aggregate stats', async () => {
    const res = await request('GET', '/api/v1/calls/stats');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.total_calls === 'number');
    assert.ok(res.body.total_calls >= 3);
    assert.ok(typeof res.body.total_minutes === 'number');
    assert.ok(typeof res.body.avg_duration === 'number');
    assert.ok(typeof res.body.calls_today === 'number');
  });

  it('reports calls_today correctly', async () => {
    const res = await request('GET', '/api/v1/calls/stats');
    // All calls we logged have today's date
    assert.ok(res.body.calls_today >= 3);
  });
});
