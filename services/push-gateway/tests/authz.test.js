/**
 * Wave 12 P0 — push-gateway authorization pins
 *
 * H-1 repro + fix:
 *   /api/v1/chat/push/register (and /push/mute, /push/unmute) used to
 *   take userId from the request body verbatim — any valid JWT could
 *   register a pushkey under a victim's account and hijack all
 *   downstream push fan-out. This test suite pins the fix: the
 *   body.userId must match the caller's JWT identity claim (or the
 *   caller must be a service-token call).
 *
 * M-1 repro + fix:
 *   /api/v1/chat/push/test dispatched to any supplied pushkey with
 *   no ownership check — an outbound spam channel + token-validity
 *   oracle. The fix requires the pushkey to be registered against
 *   the caller's own userId before the test push fires.
 *
 * Run: npx jest tests/authz.test.js
 *
 * Migrated from `node --test` to Jest 2026-05-26 to eliminate the IPC
 * framing flake (Node 22.22.x bug nodejs/node#57135 — keep-alive sockets
 * writing late stdout that breaks the parent process's V8 deserializer).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const JWT_SECRET = 'wave12-authz-jwt-secret';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = JWT_SECRET;
process.env.PUSH_BUS_TOKEN = 'wave12-authz-bus-token';
process.env.CHAT_API_TOKEN = 'wave12-authz-service-token';

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
  // resolves immediately. Defensive carryover from the node:test era — Jest's
  // worker IPC is robust to late stdout, but lingering connections still slow
  // teardown.
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function jwtFor(claims) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 300, ...claims };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const si = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(si).digest('base64url');
  return `${si}.${sig}`;
}

async function postJson(pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

// Single top-level lifecycle — the two describe blocks below share one server.
// In Jest, file-scope beforeAll/afterAll run once per test file and wrap every
// nested describe, which is the same shape the node:test version was emulating
// with top-level before/after hooks.
beforeAll(startServer);
afterAll(stopServer);

// ── H-1 ─────────────────────────────────────────────────────────────
describe('Wave 12 H-1 — /api/v1/chat/push/register binds userId to JWT', () => {
  it('test_push_register_rejects_foreign_userId', async () => {
    const attackerToken = jwtFor({ sub: 'attacker-001', windy_identity_id: 'attacker-001' });
    const { status, body } = await postJson('/api/v1/chat/push/register', {
      pushkey: 'h1-stolen-pushkey',
      userId: 'victim-001',
      platform: 'android',
      deviceName: 'Attacker Device',
    }, { Authorization: `Bearer ${attackerToken}` });

    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.detail).toMatch(/userId must match authenticated user/);

    // And the DB must not have been written
    const row = pushDb.db
      .prepare('SELECT user_id FROM push_tokens WHERE pushkey = ?')
      .get('h1-stolen-pushkey');
    expect(row).toBeUndefined();
  });

  it('accepts a self-registration (userId === sub)', async () => {
    const token = jwtFor({ sub: 'grant-001', windy_identity_id: 'grant-001' });
    const { status, body } = await postJson('/api/v1/chat/push/register', {
      pushkey: 'h1-self-pushkey',
      userId: 'grant-001',
      platform: 'android',
      deviceName: 'Grant Pixel',
    }, { Authorization: `Bearer ${token}` });

    expect(status).toBe(201);
    expect(body.success).toBe(true);

    const row = pushDb.db
      .prepare('SELECT user_id FROM push_tokens WHERE pushkey = ?')
      .get('h1-self-pushkey');
    expect(row.user_id).toBe('grant-001');
  });

  it('accepts a registration with the canonical windy_identity_id claim', async () => {
    // JWT with different sub vs windy_identity_id — the identity_id
    // wins because it's the cross-service canonical claim.
    const token = jwtFor({ sub: 'session-abc', windy_identity_id: 'grant-002' });
    const { status } = await postJson('/api/v1/chat/push/register', {
      pushkey: 'h1-identity-claim-pushkey',
      userId: 'grant-002',
      platform: 'ios',
      deviceName: 'iPhone',
    }, { Authorization: `Bearer ${token}` });
    expect(status).toBe(201);
  });

  it('lets the CHAT_API_TOKEN service caller register on behalf of any user', async () => {
    const { status, body } = await postJson('/api/v1/chat/push/register', {
      pushkey: 'h1-service-registered-pushkey',
      userId: 'any-user-003',
      platform: 'web',
      deviceName: 'account-server re-provision',
    }, { Authorization: `Bearer ${process.env.CHAT_API_TOKEN}` });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
  });

  it('test_push_mute_rejects_foreign_userId', async () => {
    const token = jwtFor({ sub: 'muter-001', windy_identity_id: 'muter-001' });
    const { status, body } = await postJson('/api/v1/chat/push/mute', {
      userId: 'victim-001',
      roomId: '!room:chat.windychat.ai',
      duration: '1h',
    }, { Authorization: `Bearer ${token}` });
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
  });

  it('test_push_unmute_rejects_foreign_userId', async () => {
    const token = jwtFor({ sub: 'muter-001', windy_identity_id: 'muter-001' });
    const { status, body } = await postJson('/api/v1/chat/push/unmute', {
      userId: 'victim-001',
      roomId: '!room:chat.windychat.ai',
    }, { Authorization: `Bearer ${token}` });
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
  });
});

// ── M-1 ─────────────────────────────────────────────────────────────
describe('Wave 12 M-1 — /api/v1/chat/push/test requires ownership', () => {
  it('test_push_test_rejects_unowned_pushkey', async () => {
    // victim-m1 registers a pushkey of their own
    const victim = jwtFor({ sub: 'victim-m1', windy_identity_id: 'victim-m1' });
    await postJson('/api/v1/chat/push/register', {
      pushkey: 'm1-victim-pushkey',
      userId: 'victim-m1',
      platform: 'android',
    }, { Authorization: `Bearer ${victim}` });

    // attacker-m1 tries to /push/test against the victim's key
    const attacker = jwtFor({ sub: 'attacker-m1', windy_identity_id: 'attacker-m1' });
    const { status, body } = await postJson('/api/v1/chat/push/test', {
      pushkey: 'm1-victim-pushkey',
      platform: 'android',
      title: 'pwned',
      body: 'oh no',
    }, { Authorization: `Bearer ${attacker}` });
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.detail).toMatch(/pushkey must be registered to authenticated user/);
  });

  it('rejects an unknown pushkey', async () => {
    const attacker = jwtFor({ sub: 'attacker-m1b', windy_identity_id: 'attacker-m1b' });
    const { status, body } = await postJson('/api/v1/chat/push/test', {
      pushkey: 'nobody-registered-this',
      platform: 'android',
    }, { Authorization: `Bearer ${attacker}` });
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
  });

  it('allows a self-test against a pushkey the caller owns', async () => {
    const self = jwtFor({ sub: 'self-m1', windy_identity_id: 'self-m1' });
    // register first
    await postJson('/api/v1/chat/push/register', {
      pushkey: 'm1-self-pushkey',
      userId: 'self-m1',
      platform: 'ios',
    }, { Authorization: `Bearer ${self}` });

    const { status, body } = await postJson('/api/v1/chat/push/test', {
      pushkey: 'm1-self-pushkey',
      platform: 'ios',
      title: 'Hello',
      body: 'Test',
    }, { Authorization: `Bearer ${self}` });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('rejects a platform that does not match the stored pushkey', async () => {
    const self = jwtFor({ sub: 'self-m1-plat', windy_identity_id: 'self-m1-plat' });
    await postJson('/api/v1/chat/push/register', {
      pushkey: 'm1-platform-pushkey',
      userId: 'self-m1-plat',
      platform: 'android',
    }, { Authorization: `Bearer ${self}` });

    const { status, body } = await postJson('/api/v1/chat/push/test', {
      pushkey: 'm1-platform-pushkey',
      platform: 'ios',
    }, { Authorization: `Bearer ${self}` });
    expect(status).toBe(400);
    expect(body.error).toMatch(/platform mismatch/);
  });

  it('lets the service token exercise any pushkey (ops diagnostic)', async () => {
    const victim = jwtFor({ sub: 'service-target', windy_identity_id: 'service-target' });
    await postJson('/api/v1/chat/push/register', {
      pushkey: 'm1-service-pushkey',
      userId: 'service-target',
      platform: 'android',
    }, { Authorization: `Bearer ${victim}` });

    const { status, body } = await postJson('/api/v1/chat/push/test', {
      pushkey: 'm1-service-pushkey',
      platform: 'android',
    }, { Authorization: `Bearer ${process.env.CHAT_API_TOKEN}` });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});
