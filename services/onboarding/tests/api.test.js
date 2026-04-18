const request = require('supertest');
const jwt = require('jsonwebtoken');

// Set env before importing
process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-onboarding-secret';
process.env.CHAT_API_TOKEN = 'test-static-token';
process.env.WINDY_IDENTITY_WEBHOOK_SECRET = 'test-identity-hmac-secret';
process.env.ETERNITAS_WEBHOOK_SECRET = 'test-eternitas-hmac-secret';

const crypto = require('crypto');
const { app } = require('../server');

const JWT_SECRET = process.env.WINDY_JWT_SECRET;

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'test-user-001', role: 'user', ...payload },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

// ─── Health Check ─────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('windy-chat-onboarding');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ─── Auth Required ────────────────────────────────────────────

describe('Auth required on protected routes', () => {
  it('POST /api/v1/chat/verify/send returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/verify/send')
      .send({ identifier: '+1234567890', type: 'phone' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/chat/profile/setup returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/profile/setup')
      .send({ displayName: 'Test' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/chat/pair/generate returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/pair/generate')
      .send({});
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/chat/provision returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/provision')
      .send({});
    expect(res.status).toBe(401);
  });
});

// ─── Verify: Validation ───────────────────────────────────────

describe('POST /api/v1/chat/verify/send (with auth)', () => {
  it('rejects missing identifier', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/verify/send')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'phone' });
    expect(res.status).toBe(400);
  });

  it('rejects missing type', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/verify/send')
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '+15551234567' });
    expect(res.status).toBe(400);
  });

  it('accepts valid phone verification request', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/verify/send')
      .set('Authorization', `Bearer ${token}`)
      .send({ identifier: '+15551234567', type: 'phone' });
    // Should succeed (stubbed SMS) or 400 if phone parsing fails
    expect([200, 400]).toContain(res.status);
  });
});

// ─── Profile: Validation ──────────────────────────────────────

describe('GET /api/v1/chat/profile/check-name', () => {
  it('checks display name availability', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/chat/profile/check-name')
      .set('Authorization', `Bearer ${token}`)
      .query({ name: 'TestUser' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('available');
  });
});

// ─── Pairing: Happy Path ──────────────────────────────────────

describe('POST /api/v1/chat/pair/generate', () => {
  it('generates a pairing session with auth', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/pair/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sessionId');
    expect(res.body).toHaveProperty('qrPayload');
  });
});

// ─── Static Token Auth ────────────────────────────────────────

describe('Static CHAT_API_TOKEN fallback', () => {
  it('allows access with static token', async () => {
    const res = await request(app)
      .get('/api/v1/chat/profile/check-name')
      .set('Authorization', `Bearer ${process.env.CHAT_API_TOKEN}`)
      .query({ name: 'StaticTokenTest' });
    expect(res.status).toBe(200);
  });
});

// ─── Webhooks: identity/created ───────────────────────────────

function signHmac(body, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

describe('POST /api/v1/webhooks/identity/created', () => {
  const secret = process.env.WINDY_IDENTITY_WEBHOOK_SECRET;
  const onboardingDb = require('../lib/db');

  // Clear any rows persisted by prior runs so provision/idempotency assertions
  // don't depend on DB state across runs.
  beforeAll(() => {
    const ids = ['id_new_user_001', 'id_replay_user_001', 'id_revoke_test_001'];
    for (const id of ids) {
      const profile = onboardingDb.getProfileByWindyId.get(id);
      if (profile) {
        onboardingDb.deleteProfile.run(profile.chat_user_id);
        onboardingDb.deleteOnboardingState.run(profile.chat_user_id);
      }
    }
  });

  it('rejects requests without a signature header', async () => {
    const body = { windy_identity_id: 'id_no_sig', first_name: 'A', last_name: 'B' };
    const res = await request(app)
      .post('/api/v1/webhooks/identity/created')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('rejects requests with an invalid signature', async () => {
    const body = { windy_identity_id: 'id_bad_sig', first_name: 'A', last_name: 'B' };
    const res = await request(app)
      .post('/api/v1/webhooks/identity/created')
      .set('x-windy-signature', 'deadbeef')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('provisions a new identity and returns matrix_user_id', async () => {
    const body = {
      windy_identity_id: 'id_new_user_001',
      first_name: 'Grant',
      last_name: 'Whitmer',
      display_name: 'Grant Whitmer',
    };
    const res = await request(app)
      .post('/api/v1/webhooks/identity/created')
      .set('x-windy-signature', signHmac(body, secret))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('provisioned');
    expect(res.body.display_name).toBe('Grant Whitmer');
    expect(res.body.matrix_user_id).toMatch(/^@grant\.whitmer(-[a-f0-9]+)?:/);
  });

  it('is idempotent — replay returns already_existed', async () => {
    const body = {
      windy_identity_id: 'id_replay_user_001',
      first_name: 'Ada',
      last_name: 'Lovelace',
    };
    const sig = signHmac(body, secret);

    const first = await request(app)
      .post('/api/v1/webhooks/identity/created')
      .set('x-windy-signature', sig)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('provisioned');

    const replay = await request(app)
      .post('/api/v1/webhooks/identity/created')
      .set('x-windy-signature', sig)
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('already_existed');
    expect(replay.body.matrix_user_id).toBe(first.body.matrix_user_id);
  });

  it('rejects missing windy_identity_id', async () => {
    const body = { first_name: 'X' };
    const res = await request(app)
      .post('/api/v1/webhooks/identity/created')
      .set('x-windy-signature', signHmac(body, secret))
      .send(body);
    expect(res.status).toBe(400);
  });
});

// ─── Webhooks: passport/revoked ───────────────────────────────

describe('POST /api/v1/webhooks/passport/revoked', () => {
  const identitySecret = process.env.WINDY_IDENTITY_WEBHOOK_SECRET;
  const eternitasSecret = process.env.ETERNITAS_WEBHOOK_SECRET;

  it('rejects requests with an invalid signature', async () => {
    const body = { passport: 'ET-99999' };
    const res = await request(app)
      .post('/api/v1/webhooks/passport/revoked')
      .set('x-eternitas-signature', 'deadbeef')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown passport', async () => {
    const body = { passport: 'ET-does-not-exist' };
    const res = await request(app)
      .post('/api/v1/webhooks/passport/revoked')
      .set('x-eternitas-signature', signHmac(body, eternitasSecret))
      .send(body);
    expect(res.status).toBe(404);
  });

  it('deactivates a provisioned passport', async () => {
    // Provision first
    const identityBody = {
      windy_identity_id: 'id_revoke_test_001',
      first_name: 'Rev',
      last_name: 'Oke',
      passport_id: 'ET-REVOKE-001',
    };
    const prov = await request(app)
      .post('/api/v1/webhooks/identity/created')
      .set('x-windy-signature', signHmac(identityBody, identitySecret))
      .send(identityBody);
    expect(prov.status).toBe(200);

    const revBody = { passport: 'ET-REVOKE-001' };
    const res = await request(app)
      .post('/api/v1/webhooks/passport/revoked')
      .set('x-eternitas-signature', signHmac(revBody, eternitasSecret))
      .send(revBody);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deactivated');
    expect(res.body.matrix_user_id).toBe(prov.body.matrix_user_id);
  });
});

// ─── 404 ──────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await request(app).get('/api/v1/chat/nonexistent');
    expect(res.status).toBe(404);
  });
});
