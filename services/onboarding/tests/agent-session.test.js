/**
 * One-soul handoff — POST /api/v1/onboarding/agent/session (2026-07-05).
 *
 * The real Windy Fly presents its EPT and receives its @agent_<passport>
 * Matrix credentials. These tests pin: bearer required, invalid EPT
 * rejected, unprovisioned passport 404s, and the happy path mints a
 * fresh device session (Synapse admin mocked) + returns the DM room.
 */

process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-onboarding-secret';
process.env.CHAT_API_TOKEN = 'test-static-token';
process.env.WINDY_IDENTITY_WEBHOOK_SECRET = 'test-identity-hmac-secret';
process.env.ETERNITAS_WEBHOOK_SECRET = 'test-eternitas-hmac-secret';
process.env.SYNAPSE_ADMIN_TOKEN = 'test-admin-token';

// Control EPT verification — the JWKS round-trip is not under test here.
jest.mock('../../shared/ept-verify', () => ({
  verifyEpt: jest.fn(),
}));

const request = require('supertest');
const { verifyEpt } = require('../../shared/ept-verify');
const { app } = require('../server');
const onboardingDb = require('../lib/db');

const PASSPORT = 'ET26-SESS-TEST';
const LOCALPART = 'agent_et26-sess-test';
const MATRIX_ID = `@${LOCALPART}:chat.windychat.ai`;

beforeAll(() => {
  // Seed a provisioned agent (what a real hatch writes).
  onboardingDb.db
    .prepare(
      `INSERT OR REPLACE INTO onboarding_state
       (windy_user_id, matrix_provisioned, matrix_user_id, passport_id)
       VALUES (?, 1, ?, ?)`,
    )
    .run(LOCALPART, MATRIX_ID, PASSPORT);
  onboardingDb.db
    .prepare(
      `INSERT OR REPLACE INTO agent_rooms
       (agent_user_id, owner_user_id, room_id, agent_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(MATRIX_ID, '@owner:chat.windychat.ai', '!dmroom123:chat.windychat.ai',
         'Sess Agent', new Date().toISOString());
});

afterEach(() => jest.restoreAllMocks());

describe('POST /api/v1/onboarding/agent/session', () => {
  it('401 without a bearer', async () => {
    const res = await request(app).post('/api/v1/onboarding/agent/session');
    expect(res.status).toBe(401);
  });

  it('401 on an invalid EPT', async () => {
    verifyEpt.mockRejectedValueOnce(new Error('EPT revoked'));
    const res = await request(app)
      .post('/api/v1/onboarding/agent/session')
      .set('Authorization', 'Bearer bad-ept');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/passport token/i);
  });

  it('404 for a valid EPT whose agent was never provisioned', async () => {
    verifyEpt.mockResolvedValueOnce({ sub: 'ET26-NEVER-HATCHED', tru: 70 });
    const res = await request(app)
      .post('/api/v1/onboarding/agent/session')
      .set('Authorization', 'Bearer good-ept');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/hatch first/i);
  });

  it('mints a fresh session + returns the DM room on the happy path', async () => {
    verifyEpt.mockResolvedValueOnce({ sub: PASSPORT, tru: 70 });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'syt_fresh_token', device_id: 'FLYDEV1' }),
    });

    const res = await request(app)
      .post('/api/v1/onboarding/agent/session')
      .set('Authorization', 'Bearer good-ept');

    expect(res.status).toBe(200);
    expect(res.body.matrix_user_id).toBe(MATRIX_ID);
    expect(res.body.access_token).toBe('syt_fresh_token');
    expect(res.body.device_id).toBe('FLYDEV1');
    expect(res.body.dm_room_id).toBe('!dmroom123:chat.windychat.ai');

    // Minted via Synapse ADMIN login for exactly this user.
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain('/v1/users/');
    expect(decodeURIComponent(calledUrl)).toContain(MATRIX_ID);
  });

  it('502 when Synapse admin mint fails (never a silent empty session)', async () => {
    verifyEpt.mockResolvedValueOnce({ sub: PASSPORT, tru: 70 });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 500 });
    const res = await request(app)
      .post('/api/v1/onboarding/agent/session')
      .set('Authorization', 'Bearer good-ept');
    expect(res.status).toBe(502);
  });
});
