/**
 * Tests for Windy Chat — Push Gateway Service (K6)
 *
 * Run: node --test tests/push-gateway.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.CHAT_API_TOKEN = 'test-token-push';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

const app = require('../services/push-gateway/server');

let server;
let baseUrl;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CHAT_API_TOKEN}`,
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
    if (body) req.write(JSON.stringify(body));
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
  it('returns service status with FCM/APNs status', async () => {
    const res = await request('GET', '/health', null, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'windy-chat-push-gateway');
    assert.ok(res.body.uptime);
    assert.ok(res.body.dependencies);
    assert.equal(res.body.dependencies.fcm, 'stubbed');
    assert.equal(res.body.dependencies.apns, 'stubbed');
  });
});

// ── 404 ──

describe('Unknown routes', () => {
  it('returns 404 JSON', async () => {
    const res = await request('GET', '/nonexistent');
    assert.equal(res.status, 404);
  });
});

// ── Matrix Push Endpoint (K6.1) ──

describe('POST /_matrix/push/v1/notify', () => {
  it('rejects missing notification object', async () => {
    const res = await request('POST', '/_matrix/push/v1/notify', {}, { Authorization: '' });
    assert.equal(res.status, 400);
  });

  it('rejects invalid devices field', async () => {
    const res = await request('POST', '/_matrix/push/v1/notify', {
      notification: { devices: 'not-array' },
    }, { Authorization: '' });
    assert.equal(res.status, 400);
  });

  it('handles empty devices array', async () => {
    const res = await request('POST', '/_matrix/push/v1/notify', {
      notification: {
        room_id: '!test:chat.windychat.ai',
        sender: '@alice:chat.windychat.ai',
        devices: [],
      },
    }, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rejected, []);
  });

  it('does not require auth (server-to-server)', async () => {
    const res = await request('POST', '/_matrix/push/v1/notify', {
      notification: {
        room_id: '!test:chat.windychat.ai',
        sender: '@alice:chat.windychat.ai',
        devices: [],
      },
    }, { Authorization: '' });
    assert.equal(res.status, 200);
  });

  it('processes push notification with stub FCM', async () => {
    // First register a token
    await request('POST', '/api/v1/chat/push/register', {
      pushkey: 'fcm-token-test-123',
      userId: 'push_test_user',
      platform: 'android',
    });

    const res = await request('POST', '/_matrix/push/v1/notify', {
      notification: {
        room_id: '!test:chat.windychat.ai',
        event_id: '$test-event',
        sender: '@alice:chat.windychat.ai',
        sender_display_name: 'Alice',
        type: 'm.room.message',
        prio: 'high',
        devices: [{ pushkey: 'fcm-token-test-123', app_id: 'com.windypro.chat.android' }],
        counts: { unread: 1 },
      },
    }, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.rejected));
  });
});

// ── Push Token Registration ──

describe('POST /api/v1/chat/push/register', () => {
  it('rejects missing pushkey', async () => {
    const res = await request('POST', '/api/v1/chat/push/register', {
      userId: 'user1',
      platform: 'android',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /pushkey/);
  });

  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/chat/push/register', {
      pushkey: 'token123',
      platform: 'android',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId/);
  });

  it('rejects invalid platform', async () => {
    const res = await request('POST', '/api/v1/chat/push/register', {
      pushkey: 'token123',
      userId: 'user1',
      platform: 'blackberry',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /platform/);
  });

  it('rejects missing auth', async () => {
    const res = await request('POST', '/api/v1/chat/push/register', {
      pushkey: 'token123',
      userId: 'user1',
      platform: 'android',
    }, { Authorization: '' });
    assert.equal(res.status, 401);
  });

  it('registers a valid push token', async () => {
    const res = await request('POST', '/api/v1/chat/push/register', {
      pushkey: 'test-push-token-abc',
      userId: 'reg_test_user',
      platform: 'ios',
      appId: 'com.windypro.chat.ios',
      deviceName: 'iPhone 15',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
  });

  it('rejects pushkey longer than 1024 chars', async () => {
    const res = await request('POST', '/api/v1/chat/push/register', {
      pushkey: 'x'.repeat(1025),
      userId: 'user1',
      platform: 'android',
    });
    assert.equal(res.status, 400);
  });
});

// ── Mute (K6.4) ──

describe('POST /api/v1/chat/push/mute', () => {
  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/chat/push/mute', {
      roomId: '!room:chat.windychat.ai',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId/);
  });

  it('rejects missing roomId', async () => {
    const res = await request('POST', '/api/v1/chat/push/mute', {
      userId: 'user1',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /roomId/);
  });

  it('mutes a conversation with default duration', async () => {
    const res = await request('POST', '/api/v1/chat/push/mute', {
      userId: 'mute_user',
      roomId: '!room:chat.windychat.ai',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.mutedUntil);
  });

  it('mutes with specific duration', async () => {
    const res = await request('POST', '/api/v1/chat/push/mute', {
      userId: 'mute_user',
      roomId: '!room2:chat.windychat.ai',
      duration: '1w',
      mentionOverride: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});

describe('POST /api/v1/chat/push/unmute', () => {
  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/chat/push/unmute', {
      roomId: '!room:chat.windychat.ai',
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing roomId', async () => {
    const res = await request('POST', '/api/v1/chat/push/unmute', {
      userId: 'user1',
    });
    assert.equal(res.status, 400);
  });

  it('unmutes a conversation', async () => {
    const res = await request('POST', '/api/v1/chat/push/unmute', {
      userId: 'mute_user',
      roomId: '!room:chat.windychat.ai',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});

// ── Mute suppresses notifications ──

describe('Mute integration', () => {
  it('skips notification for muted room', async () => {
    // Register token
    await request('POST', '/api/v1/chat/push/register', {
      pushkey: 'mute-integration-token',
      userId: 'mute_int_user',
      platform: 'android',
    });

    // Mute the room
    await request('POST', '/api/v1/chat/push/mute', {
      userId: 'mute_int_user',
      roomId: '!muted_room:chat.windychat.ai',
      duration: '1h',
      mentionOverride: false,
    });

    // Send notification — should be silently skipped
    const res = await request('POST', '/_matrix/push/v1/notify', {
      notification: {
        room_id: '!muted_room:chat.windychat.ai',
        event_id: '$mute-test',
        sender: '@bob:chat.windychat.ai',
        type: 'm.room.message',
        devices: [{ pushkey: 'mute-integration-token', app_id: 'com.windypro.chat.android' }],
        counts: { unread: 1 },
      },
    }, { Authorization: '' });
    assert.equal(res.status, 200);
    // Muted — should not be rejected (it was skipped, not sent)
    assert.deepEqual(res.body.rejected, []);
  });
});
