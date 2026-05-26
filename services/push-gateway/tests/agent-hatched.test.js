/**
 * Wave 8 — Grandma Ribbon: agent.hatched push event
 *
 * Covers the richer notification payload built for event_type
 * "agent.hatched": the owner's phone should buzz with the agent's avatar
 * and a deep link into the DM room the moment the welcome lands.
 *
 * Run: node --test services/push-gateway/tests/agent-hatched.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BUS_TOKEN = 'agent-hatched-test-token';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'agent-hatched-test-jwt';
process.env.PUSH_BUS_TOKEN = BUS_TOKEN;

const dataDir = path.join(__dirname, '..', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const app = require('../server');
const pushDb = require('../lib/db');
const { buildAgentHatchedPayload } = require('../routes/notify');

let server;
let baseUrl;
function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}
function stopServer() {
  // closeAllConnections() (Node 18.2+) drops keep-alive sockets so server.close
  // resolves immediately. Without it, lingering fetch() connections can fire an
  // async response after the test ends, surfacing as a node:test runner IPC
  // deserialization error and a flaky CI run.
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function postJson(pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    // Connection: close prevents undici from holding the socket open after the
    // response. Combined with server.closeAllConnections() in stopServer, this
    // eliminates the "asynchronous activity after the test ended" race that
    // surfaces as a node:test IPC deserialization failure.
    headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

describe('Wave 8 — agent.hatched payload shape', { concurrency: false }, () => {
  it('defaults deep link to windychat://room/{roomId}', () => {
    const payload = buildAgentHatchedPayload({
      room_id: '!abc123:chat.windychat.ai',
      agent_name: 'Buzz',
      agent_avatar_url: 'https://cdn.windy.ai/buzz.png',
    });
    assert.equal(payload.eventType, 'agent.hatched');
    assert.equal(payload.deepLink, 'windychat://room/!abc123:chat.windychat.ai');
    assert.equal(payload.imageUrl, 'https://cdn.windy.ai/buzz.png');
    assert.equal(payload.roomId, '!abc123:chat.windychat.ai');
    assert.equal(payload.agentName, 'Buzz');
  });

  it('provides default title and body when caller omits copy', () => {
    const payload = buildAgentHatchedPayload({
      room_id: '!r:chat.windychat.ai',
      agent_name: 'Nimbus',
    });
    assert.match(payload.title, /Nimbus just hatched/);
    assert.ok(payload.body && payload.body.length > 0);
  });

  it('respects caller-supplied copy and deep_link overrides', () => {
    const payload = buildAgentHatchedPayload({
      title: 'Custom title',
      body: 'Custom body',
      deep_link: 'https://windychat.ai/room/abc',
      agent_name: 'Ivy',
    });
    assert.equal(payload.title, 'Custom title');
    assert.equal(payload.body, 'Custom body');
    assert.equal(payload.deepLink, 'https://windychat.ai/room/abc');
  });
});

describe('Wave 8 — /api/v1/push/notify agent.hatched', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);

  it('accepts agent.hatched without an explicit title', async () => {
    const { status, body } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_hatched_no_devices',
      event_type: 'agent.hatched',
      room_id: '!r1:chat.windychat.ai',
      agent_name: 'Buzz',
      agent_avatar_url: 'https://cdn.windy.ai/buzz.png',
      passport_number: 'ET-HATCH-001',
    }, { 'x-push-bus-token': BUS_TOKEN });

    assert.equal(status, 200);
    assert.equal(body.event_type, 'agent.hatched');
    assert.equal(body.delivered, 0);
  });

  it('fans out agent.hatched to registered devices', async () => {
    const user = 'id_hatched_with_devices';
    pushDb.upsertToken.run({
      pushkey: 'android-hatched-1', user_id: user, platform: 'android',
      app_id: 'com.windypro.chat', device_name: 'Pixel', registered_at: Date.now(),
    });
    pushDb.upsertToken.run({
      pushkey: 'ios-hatched-1', user_id: user, platform: 'ios',
      app_id: 'com.windypro.chat', device_name: 'iPhone', registered_at: Date.now(),
    });

    const { status, body } = await postJson('/api/v1/push/notify', {
      windy_identity_id: user,
      event_type: 'agent.hatched',
      room_id: '!r2:chat.windychat.ai',
      agent_name: 'Nimbus',
      agent_avatar_url: 'https://cdn.windy.ai/nimbus.png',
      passport_number: 'ET-HATCH-002',
    }, { 'x-push-bus-token': BUS_TOKEN });

    assert.equal(status, 200);
    assert.equal(body.delivered, 2);
    assert.deepEqual(body.rejected, []);
  });

  it('still requires title for non-agent events', async () => {
    const { status } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_x',
      event_type: 'chat.new_message',
    }, { 'x-push-bus-token': BUS_TOKEN });
    assert.equal(status, 400);
  });
});
