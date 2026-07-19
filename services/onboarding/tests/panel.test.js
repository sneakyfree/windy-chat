/**
 * windy.panel.v1 — the agent control-panel API (DASHBOARD_API_CONTRACT.md).
 *
 * Pins the contract the hub + mobile UIs build against: auth + ownership
 * resolution from the JWT claim, gateway-compatible slider shapes, 400 (not
 * 500) on bad input, history rows on every change, honest 501s for
 * capabilities the cloud agent doesn't have, and the store-only-non-default
 * rule that makes an untouched panel identical to today's midwife.
 */

process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-onboarding-secret';
process.env.CHAT_API_TOKEN = 'test-static-token';
process.env.WINDY_IDENTITY_WEBHOOK_SECRET = 'test-identity-hmac-secret';
process.env.ETERNITAS_WEBHOOK_SECRET = 'test-eternitas-hmac-secret';
process.env.SYNAPSE_ADMIN_TOKEN = 'test-admin-token';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../server');
const onboardingDb = require('../lib/db');
const { SUPPORTED_SLIDERS } = require('../lib/panel-sliders');

const OWNER_ID = 'windy-id-panel-owner';
const MATRIX_ID = '@agent_et26-panel-test:chat.windychat.ai';
const OTHER_OWNER_ID = 'windy-id-no-agent';

function token(identityId) {
  return jwt.sign(
    { windy_identity_id: identityId, sub: identityId },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '15m' },
  );
}

const auth = (req, identityId = OWNER_ID) =>
  req.set('Authorization', `Bearer ${token(identityId)}`);

beforeAll(() => {
  onboardingDb.upsertAgentCredentials.run({
    agent_matrix_id: MATRIX_ID,
    owner_windy_id: OWNER_ID,
    passport_number: 'ET26-PANL-TEST',
    agent_name: 'Panel Test Agent',
    access_token: 'syt_test_token',
    hatched_at: '2026-07-18T00:00:00.000Z',
    welcomed_at: null,
    created_at: '2026-07-18T00:00:00.000Z',
  });
});

beforeEach(() => {
  onboardingDb.db.prepare('DELETE FROM agent_settings WHERE agent_matrix_id = ?').run(MATRIX_ID);
  onboardingDb.db.prepare('DELETE FROM agent_settings_history WHERE agent_matrix_id = ?').run(MATRIX_ID);
});

afterAll(() => {
  onboardingDb.db.prepare('DELETE FROM agent_credentials WHERE agent_matrix_id = ?').run(MATRIX_ID);
  onboardingDb.db.prepare('DELETE FROM agent_settings WHERE agent_matrix_id = ?').run(MATRIX_ID);
  onboardingDb.db.prepare('DELETE FROM agent_settings_history WHERE agent_matrix_id = ?').run(MATRIX_ID);
});

describe('windy.panel.v1 auth + ownership', () => {
  it('401 without a bearer', async () => {
    const res = await request(app).get('/api/v1/agent/panel/sliders');
    expect(res.status).toBe(401);
  });

  it('404 no_agent for an identity with no hatched agent', async () => {
    const res = await auth(request(app).get('/api/v1/agent/panel/sliders'), OTHER_OWNER_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'no_agent', hint: 'not_provisioned' });
  });
});

describe('GET /sliders + /sliders/info', () => {
  it('returns all supported sliders with defaults filled in', async () => {
    const res = await auth(request(app).get('/api/v1/agent/panel/sliders'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.sliders).sort()).toEqual([...SUPPORTED_SLIDERS].sort());
    for (const v of Object.values(res.body.sliders)) expect(v).toBe(5);
  });

  it('info carries label/description/impacts/value/cost_per_point', async () => {
    const res = await auth(request(app).get('/api/v1/agent/panel/sliders/info'));
    expect(res.status).toBe(200);
    const humor = res.body.sliders.humor;
    expect(humor.label).toBe('Humor');
    expect(typeof humor.description).toBe('string');
    expect(typeof humor.impact_low).toBe('string');
    expect(typeof humor.impact_high).toBe('string');
    expect(humor.value).toBe(5);
    expect(humor.cost_per_point).toBe(0);
  });
});

describe('PUT /sliders/:name', () => {
  it('writes, persists, and records history', async () => {
    const put = await auth(request(app).put('/api/v1/agent/panel/sliders/humor')).send({ value: 9 });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ success: true });

    const get = await auth(request(app).get('/api/v1/agent/panel/sliders'));
    expect(get.body.sliders.humor).toBe(9);

    const hist = await auth(request(app).get('/api/v1/agent/panel/personality/history'));
    expect(hist.status).toBe(200);
    expect(hist.body.history).toHaveLength(1);
    expect(hist.body.history[0]).toMatchObject({
      key: 'humor', soul_id: 'humor', old_value: '5', new_value: '9', changed_by: 'owner',
    });
  });

  it('setting back to the default removes the stored key (zero-risk default)', async () => {
    await auth(request(app).put('/api/v1/agent/panel/sliders/humor')).send({ value: 9 });
    await auth(request(app).put('/api/v1/agent/panel/sliders/humor')).send({ value: 5 });
    const row = onboardingDb.getAgentSettings.get(MATRIX_ID);
    expect(JSON.parse(row.sliders_json)).toEqual({});
    const get = await auth(request(app).get('/api/v1/agent/panel/sliders'));
    expect(get.body.sliders.humor).toBe(5);
  });

  it('400 (not 500) on an unknown slider name', async () => {
    const res = await auth(request(app).put('/api/v1/agent/panel/sliders/telepathy')).send({ value: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_slider');
  });

  it('400 on out-of-range and non-integer values', async () => {
    for (const value of [15, -1, 5.5, 'seven', null]) {
      const res = await auth(request(app).put('/api/v1/agent/panel/sliders/humor')).send({ value });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_value');
    }
  });

  it('accepts a preset updated_by label and rejects junk', async () => {
    const ok = await auth(request(app).put('/api/v1/agent/panel/sliders/humor'))
      .send({ value: 7, updated_by: 'preset:buddy' });
    expect(ok.status).toBe(200);
    const hist = await auth(request(app).get('/api/v1/agent/panel/personality/history'));
    expect(hist.body.history[0].changed_by).toBe('preset:buddy');

    const bad = await auth(request(app).put('/api/v1/agent/panel/sliders/humor'))
      .send({ value: 7, updated_by: 'DROP TABLE' });
    expect(bad.status).toBe(400);
  });
});

describe('GET /summary', () => {
  it('reports contract, capabilities, agent identity, and preset detection', async () => {
    // Roster unreachable in tests → status must be the honest "unknown".
    const res = await auth(request(app).get('/api/v1/agent/panel/summary'));
    expect(res.status).toBe(200);
    expect(res.body.contract).toBe('windy.panel.v1');
    expect(res.body.kind).toBe('cloud');
    expect(res.body.capabilities).toEqual(['sliders', 'personality.history', 'identity']);
    expect(res.body.agent).toMatchObject({
      agent_matrix_id: MATRIX_ID,
      agent_name: 'Panel Test Agent',
      passport_number: 'ET26-PANL-TEST',
      status: 'unknown',
    });
    expect(res.body.personality.preset).toBe('custom');
    expect(res.body.personality.sliders.humor).toBe(5);
  });

  it('names the preset when the stored values exactly match one', async () => {
    const { PRESETS } = require('../lib/panel-sliders');
    for (const [name, value] of Object.entries(PRESETS.coder)) {
      await auth(request(app).put(`/api/v1/agent/panel/sliders/${name}`))
        .send({ value, updated_by: 'preset:coder' });
    }
    const res = await auth(request(app).get('/api/v1/agent/panel/summary'));
    expect(res.body.personality.preset).toBe('coder');
  });
});

describe('unsupported capabilities', () => {
  it('501 not_supported with the capability named', async () => {
    const memory = await auth(request(app).get('/api/v1/agent/panel/memory'));
    expect(memory.status).toBe(501);
    expect(memory.body).toEqual({ error: 'not_supported', capability: 'memory' });

    const snapshot = await auth(request(app).post('/api/v1/agent/panel/personality/snapshot'));
    expect(snapshot.status).toBe(501);
    expect(snapshot.body.capability).toBe('personality.snapshot');
  });
});
