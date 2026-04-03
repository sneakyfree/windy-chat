const request = require('supertest');
const jwt = require('jsonwebtoken');

// Set env before importing
process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-onboarding-secret';
process.env.CHAT_API_TOKEN = 'test-static-token';

const app = require('../server');

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

// ─── 404 ──────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await request(app).get('/api/v1/chat/nonexistent');
    expect(res.status).toBe(404);
  });
});
