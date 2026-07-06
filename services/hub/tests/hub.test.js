/**
 * Hub service tests — node --test, no external deps.
 *
 * Spins up (a) a fake bridgev2 provisioning server and (b) the hub app on
 * ephemeral ports, with a throwaway onboarding.db providing the
 * identity → MXID mapping. Exercises the auth gate, platform listing,
 * the provisioning proxy (path allow-list, user_id pinning, secret
 * injection), and connection bookkeeping.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

// ── Environment BEFORE requiring the app ────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'hub-test-secret';
process.env.HUB_DATA_DIR = path.join(tmp, 'hub-data');
process.env.ONBOARDING_DB_PATH = path.join(tmp, 'onboarding.db');
process.env.SYNAPSE_SERVER_NAME = 'chat.windychat.ai';

// Seed a fake onboarding.db with the identity → MXID mapping.
{
  const odb = new Database(process.env.ONBOARDING_DB_PATH);
  odb.exec(`
    CREATE TABLE onboarding_state (
      windy_user_id TEXT PRIMARY KEY, verified INTEGER, profile_setup INTEGER,
      matrix_provisioned INTEGER, matrix_user_id TEXT, provisioned_at TEXT, passport_id TEXT
    );
    CREATE TABLE user_profiles (
      chat_user_id TEXT PRIMARY KEY, windy_identity_id TEXT, display_name TEXT
    );
  `);
  odb.prepare(
    "INSERT INTO onboarding_state (windy_user_id, matrix_user_id) VALUES ('wid-grant', '@grant.whitmer:chat.windychat.ai')"
  ).run();
  odb.close();
}

// ── Fake bridge ──────────────────────────────────────────────────────
const bridgeCalls = [];
const fakeBridge = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    bridgeCalls.push({
      url: req.url,
      method: req.method,
      auth: req.headers.authorization,
      body,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/_matrix/provision/v3/whoami')) {
      res.end(JSON.stringify({
        network: { beeper_bridge_type: 'telegram' },
        logins: [{ id: 'tg-login-1', name: 'Grant TG', state: { state_event: 'CONNECTED' } }],
      }));
    } else if (req.url.startsWith('/_matrix/provision/v3/login/start/')) {
      res.end(JSON.stringify({
        login_id: 'proc-123',
        type: 'user_input',
        step_id: 'fi.mau.telegram.phone_number',
      }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });
});

let app;
let hubServer;
let hubPort;

function token(claims = {}) {
  return jwt.sign(
    { sub: 'wid-grant', windy_identity_id: 'wid-grant', ...claims },
    process.env.WINDY_JWT_SECRET
  );
}

function request(method, urlPath, { auth = token(), body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hubPort,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test.before(async () => {
  await new Promise((r) => fakeBridge.listen(0, '127.0.0.1', r));
  const bridgePort = fakeBridge.address().port;
  process.env.HUB_BRIDGE_TELEGRAM_URL = `http://127.0.0.1:${bridgePort}`;
  process.env.HUB_BRIDGE_TELEGRAM_PROVISIONING_SECRET = 'prov-secret';

  app = require('../server');
  hubServer = app.listen(0, '127.0.0.1');
  await new Promise((r) => hubServer.on('listening', r));
  hubPort = hubServer.address().port;
});

test.after(() => {
  hubServer.close();
  fakeBridge.close();
});

test('health reports configured platforms', async () => {
  const res = await request('GET', '/health', { auth: null });
  assert.strictEqual(res.status, 200);
  assert.match(res.json.dependencies.configured_platforms, /telegram/);
});

test('rejects unauthenticated hub calls', async () => {
  const res = await request('GET', '/api/v1/hub/platforms', { auth: null });
  assert.strictEqual(res.status, 401);
});

test('lists configured platforms without leaking secrets', async () => {
  const res = await request('GET', '/api/v1/hub/platforms');
  assert.strictEqual(res.status, 200);
  const tg = res.json.platforms.find((p) => p.key === 'telegram');
  assert.ok(tg, 'telegram should be configured');
  assert.strictEqual(tg.secret, undefined);
  assert.strictEqual(tg.baseUrl, undefined);
  assert.ok(!JSON.stringify(res.json).includes('prov-secret'));
});

test('409s when the identity has no chat account', async () => {
  const res = await request('GET', '/api/v1/hub/platforms', {
    auth: token({ sub: 'wid-nobody', windy_identity_id: 'wid-nobody' }),
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.error, 'no_chat_account');
});

test('proxies whoami with pinned user_id and bridge secret', async () => {
  bridgeCalls.length = 0;
  const res = await request('GET', '/api/v1/hub/telegram/whoami');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.logins[0].id, 'tg-login-1');
  assert.strictEqual(bridgeCalls.length, 1);
  assert.match(bridgeCalls[0].url, /user_id=%40grant\.whitmer%3Achat\.windychat\.ai/);
  assert.strictEqual(bridgeCalls[0].auth, 'Bearer prov-secret');
});

test('whoami syncs connection rows from the bridge login list', async () => {
  const res = await request('GET', '/api/v1/hub/platforms');
  const tg = res.json.platforms.find((p) => p.key === 'telegram');
  assert.strictEqual(tg.connections.length, 1);
  assert.strictEqual(tg.connections[0].login_id, 'tg-login-1');
  assert.strictEqual(tg.connections[0].state, 'CONNECTED');
});

test('provision proxy forwards login start and ignores client user_id', async () => {
  bridgeCalls.length = 0;
  const res = await request(
    'POST',
    '/api/v1/hub/telegram/provision/v3/login/start/phone?user_id=@evil:chat.windychat.ai',
    { body: {} }
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.login_id, 'proc-123');
  const forwarded = bridgeCalls[0].url;
  assert.match(forwarded, /user_id=%40grant\.whitmer%3Achat\.windychat\.ai/);
  assert.ok(!forwarded.includes('evil'));
});

test('blocks unsupported provisioning paths', async () => {
  const res = await request('GET', '/api/v1/hub/telegram/provision/v3/internal_admin_thing');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'unsupported_provision_path');
});

test('404s unconfigured platforms', async () => {
  const res = await request('GET', '/api/v1/hub/discord/whoami');
  assert.strictEqual(res.status, 404);
});
