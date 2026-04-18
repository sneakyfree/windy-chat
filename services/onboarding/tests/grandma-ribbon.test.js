/**
 * Wave 8 — Grandma Ribbon: Auto-join agent DM on owner first-login
 *
 * Covers the post-provision hook in provision.js that seeds pending agent
 * DMs the first time an owner logs into Chat. Before Wave 8, an agent
 * that hatched before its owner had a Chat account left an empty ghost
 * room with a guessed Matrix ID; this test exercises the flow that
 * replaces that behavior.
 *
 * Run: node --test services/onboarding/tests/grandma-ribbon.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE_TOKEN = 'grandma-ribbon-service-token';
const API_TOKEN = 'grandma-ribbon-api-token';
const IDENTITY_SECRET = 'grandma-ribbon-identity-secret';

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'grandma-ribbon-jwt-secret';
process.env.CHAT_API_TOKEN = API_TOKEN;
process.env.CHAT_SERVICE_TOKEN = SERVICE_TOKEN;
process.env.WINDY_IDENTITY_WEBHOOK_SECRET = IDENTITY_SECRET;
process.env.SYNAPSE_REGISTRATION_SECRET = ''; // force dev-stub provisioning
process.env.SYNAPSE_URL = 'http://127.0.0.1:1'; // unreachable
process.env.PUSH_BUS_URL = ''; // disable outbound push

const dataDir = path.join(__dirname, '..', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { app } = require('../server');
const onboardingDb = require('../lib/db');
const { renderAgentWelcome } = require('../routes/provision');

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
  return new Promise((resolve) => server && server.close(() => resolve()));
}

function signIdentity(bodyStr) {
  return crypto.createHmac('sha256', IDENTITY_SECRET).update(bodyStr).digest('hex');
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

describe('Wave 8 — Grandma Ribbon: pending agent DM auto-join', { concurrency: false }, () => {
  before(startServer);
  after(stopServer);

  it('renderAgentWelcome uses the bootcamp-demo tone', () => {
    const msg = renderAgentWelcome({
      ownerName: 'Grant',
      hatchedAt: '2026-04-18T10:30:00.000Z',
      passportNumber: 'ET-ABC-001',
    });
    assert.match(msg, /^Hi Grant, I'm your agent\./);
    assert.match(msg, /I just hatched at /);
    assert.match(msg, /My passport is ET-ABC-001\./);
    assert.match(msg, /What do you want me to help with first\?$/);
  });

  it('defers DM creation when agent hatches before owner exists in Chat', async () => {
    const passport = 'ET-GRANDMA-001';
    const ownerId = 'id_grandma_owner_001';

    const { status, body } = await postJson('/api/v1/onboarding/agent/', {
      passport_number: passport,
      agent_name: 'Buzz',
      owner_windy_identity_id: ownerId,
    }, { 'Authorization': `Bearer ${SERVICE_TOKEN}` });

    assert.equal(status, 201);
    assert.equal(body.welcome_pending, true);
    assert.equal(body.dm_room_id, null);

    const pending = onboardingDb.getPendingAgentsForOwner.all(ownerId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].passport_number, passport);
    assert.equal(pending[0].welcomed_at, null);
  });

  it('flushes pending welcome on owner identity/created webhook', async () => {
    const passport = 'ET-GRANDMA-002';
    const ownerId = 'id_grandma_owner_002';

    // Agent hatches first — owner has no Chat account yet.
    const hatch = await postJson('/api/v1/onboarding/agent/', {
      passport_number: passport,
      agent_name: 'Nimbus',
      owner_windy_identity_id: ownerId,
    }, { 'Authorization': `Bearer ${SERVICE_TOKEN}` });
    assert.equal(hatch.status, 201);
    assert.equal(hatch.body.welcome_pending, true);

    // Owner's identity/created webhook fires after account-server provisions them.
    const identityPayload = {
      windy_identity_id: ownerId,
      first_name: 'Grand',
      last_name: 'Ma',
      display_name: 'Grand Ma',
    };
    const sig = signIdentity(JSON.stringify(identityPayload));
    const prov = await postJson(
      '/api/v1/webhooks/identity/created', identityPayload,
      { 'x-windy-signature': sig },
    );
    assert.equal(prov.status, 200);
    assert.equal(prov.body.status, 'provisioned');
    assert.ok(Array.isArray(prov.body.seeded_agent_rooms));
    assert.equal(prov.body.seeded_agent_rooms.length, 1);

    const seeded = prov.body.seeded_agent_rooms[0];
    assert.equal(seeded.agent_name, 'Nimbus');
    assert.match(seeded.message, /^Hi Grand Ma, I'm your agent\./);
    assert.match(seeded.message, /My passport is ET-GRANDMA-002\./);
    assert.ok(seeded.room_id, 'seeded room_id present');

    // agent_rooms entry exists for the owner
    const agentRoom = onboardingDb.getAgentRoom.get(
      seeded.agent_matrix_id,
      ownerId,
    );
    assert.ok(agentRoom, 'agent_rooms row exists');
    assert.equal(agentRoom.room_id, seeded.room_id);

    // welcomed_at is now set — no double-seed on second login
    const pendingAfter = onboardingDb.getPendingAgentsForOwner.all(ownerId);
    assert.equal(pendingAfter.length, 0, 'no pending agents after seeding');

    // Idempotency: replaying identity/created returns already_existed and
    // does NOT re-seed the agent DM.
    const replay = await postJson(
      '/api/v1/webhooks/identity/created', identityPayload,
      { 'x-windy-signature': sig },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, 'already_existed');
  });
});
