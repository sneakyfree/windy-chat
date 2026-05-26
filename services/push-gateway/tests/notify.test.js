/**
 * Integration Test: Shared Push Bus
 *
 * Exercises POST /api/v1/push/notify — the cross-service publish surface
 * used by Mail, Chat homeserver, Clone, Fly, and Code.
 *
 * Run: node --test services/push-gateway/tests/notify.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BUS_TOKEN = 'bus-test-token';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'notify-test-jwt-secret';
process.env.PUSH_BUS_TOKEN = BUS_TOKEN;

// Fresh data dir
const dataDir = path.join(__dirname, '..', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const app = require('../server');
const pushDb = require('../lib/db');

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

describe('Push Bus: /api/v1/push/notify', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);

  it('rejects missing bus token', async () => {
    const { status } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_x', event_type: 'chat.new_message', title: 'x',
    });
    assert.equal(status, 401);
  });

  it('rejects invalid bus token', async () => {
    const { status } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_x', event_type: 'chat.new_message', title: 'x',
    }, { 'x-push-bus-token': 'wrong' });
    assert.equal(status, 401);
  });

  it('rejects missing windy_identity_id', async () => {
    const { status } = await postJson('/api/v1/push/notify', {
      event_type: 'chat.new_message', title: 'x',
    }, { 'x-push-bus-token': BUS_TOKEN });
    assert.equal(status, 400);
  });

  it('rejects missing event_type', async () => {
    const { status } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_x', title: 'x',
    }, { 'x-push-bus-token': BUS_TOKEN });
    assert.equal(status, 400);
  });

  it('delivers to zero tokens gracefully', async () => {
    const { status, body } = await postJson('/api/v1/push/notify', {
      windy_identity_id: 'id_no_devices',
      event_type: 'chat.new_message',
      title: 'Grant Whitmer',
      body: 'New message',
    }, { 'x-push-bus-token': BUS_TOKEN });
    assert.equal(status, 200);
    assert.equal(body.delivered, 0);
    assert.deepEqual(body.rejected, []);
    assert.equal(body.event_type, 'chat.new_message');
  });

  it('fans out to every registered device for the user', async () => {
    const user = 'id_with_devices';
    pushDb.upsertToken.run({
      pushkey: 'android-key-1', user_id: user, platform: 'android',
      app_id: 'com.windypro.chat', device_name: 'Pixel', registered_at: Date.now(),
    });
    pushDb.upsertToken.run({
      pushkey: 'ios-key-1', user_id: user, platform: 'ios',
      app_id: 'com.windypro.chat', device_name: 'iPhone', registered_at: Date.now(),
    });

    const { status, body } = await postJson('/api/v1/push/notify', {
      windy_identity_id: user,
      event_type: 'mail.inbound',
      title: 'New mail',
      body: 'From grant@windymail.ai',
      deep_link: 'windy://mail/inbox',
    }, { 'x-push-bus-token': BUS_TOKEN });

    assert.equal(status, 200);
    // FCM + APNs both stub-succeed in test mode (no firebase/apns configured)
    assert.equal(body.delivered, 2);
    assert.deepEqual(body.rejected, []);
  });
});
