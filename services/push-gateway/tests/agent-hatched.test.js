/**
 * Wave 8 — Grandma Ribbon: agent.hatched push event
 *
 * Covers the richer notification payload built for event_type
 * "agent.hatched": the owner's phone should buzz with the agent's avatar
 * and a deep link into the DM room the moment the welcome lands.
 *
 * Run: npx jest tests/agent-hatched.test.js
 *
 * Migrated from `node --test` to Jest 2026-05-26 to eliminate the IPC
 * framing flake (Node 22.22.x bug nodejs/node#57135 — keep-alive sockets
 * writing late stdout that breaks the parent process's V8 deserializer).
 */

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
  // resolves immediately. Defensive carryover from the node:test era — Jest's
  // worker IPC is robust to late stdout, but lingering connections still slow
  // teardown.
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function postJson(pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

describe('Wave 8 — agent.hatched payload shape', () => {
  it('defaults deep link to windychat://room/{roomId}', () => {
    const payload = buildAgentHatchedPayload({
      room_id: '!abc123:chat.windychat.ai',
      agent_name: 'Buzz',
      agent_avatar_url: 'https://cdn.windy.ai/buzz.png',
    });
    expect(payload.eventType).toBe('agent.hatched');
    expect(payload.deepLink).toBe('windychat://room/!abc123:chat.windychat.ai');
    expect(payload.imageUrl).toBe('https://cdn.windy.ai/buzz.png');
    expect(payload.roomId).toBe('!abc123:chat.windychat.ai');
    expect(payload.agentName).toBe('Buzz');
  });

  it('provides default title and body when caller omits copy', () => {
    const payload = buildAgentHatchedPayload({
      room_id: '!r:chat.windychat.ai',
      agent_name: 'Nimbus',
    });
    expect(payload.title).toMatch(/Nimbus just hatched/);
    expect(payload.body && payload.body.length > 0).toBeTruthy();
  });

  it('respects caller-supplied copy and deep_link overrides', () => {
    const payload = buildAgentHatchedPayload({
      title: 'Custom title',
      body: 'Custom body',
      deep_link: 'https://windychat.ai/room/abc',
      agent_name: 'Ivy',
    });
    expect(payload.title).toBe('Custom title');
    expect(payload.body).toBe('Custom body');
    expect(payload.deepLink).toBe('https://windychat.ai/room/abc');
  });
});

describe('Wave 8 — /api/v1/push/notify agent.hatched', () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it('accepts agent.hatched without an explicit title', async () => {
    const { status, body } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_hatched_no_devices',
      event_type: 'agent.hatched',
      room_id: '!r1:chat.windychat.ai',
      agent_name: 'Buzz',
      agent_avatar_url: 'https://cdn.windy.ai/buzz.png',
      passport_number: 'ET-HATCH-001',
    }, { 'x-push-bus-token': BUS_TOKEN });

    expect(status).toBe(200);
    expect(body.event_type).toBe('agent.hatched');
    expect(body.delivered).toBe(0);
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

    expect(status).toBe(200);
    expect(body.delivered).toBe(2);
    expect(body.rejected).toEqual([]);
  });

  it('still requires title for non-agent events', async () => {
    const { status } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_x',
      event_type: 'chat.new_message',
    }, { 'x-push-bus-token': BUS_TOKEN });
    expect(status).toBe(400);
  });
});
