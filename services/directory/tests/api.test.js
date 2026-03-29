const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-directory-secret';
process.env.JWT_SECRET = 'test-directory-secret';
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
    expect(res.body.service).toBe('windy-chat-directory');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ─── Auth Required ────────────────────────────────────────────

describe('Auth required on protected routes', () => {
  it('POST /api/v1/chat/directory/lookup returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/directory/lookup')
      .send({ hashes: ['abc123'] });
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/chat/directory/search returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/v1/chat/directory/search')
      .query({ q: 'test' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/chat/directory/invite returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/directory/invite')
      .send({ type: 'sms', to: '+15551234567' });
    expect(res.status).toBe(401);
  });
});

// ─── Salt Endpoint ────────────────────────────────────────────

describe('GET /api/v1/chat/directory/salt', () => {
  it('returns salt with auth', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/chat/directory/salt')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('salt');
    expect(res.body).toHaveProperty('algorithm');
  });
});

// ─── Lookup: Validation ───────────────────────────────────────

describe('POST /api/v1/chat/directory/lookup', () => {
  it('rejects missing hashes array', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/directory/lookup')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects invalid hash format', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/directory/lookup')
      .set('Authorization', `Bearer ${token}`)
      .send({ hashes: ['abc123'] });
    expect(res.status).toBe(400);
  });

  it('accepts valid SHA256 hashes', async () => {
    const token = makeToken();
    const validHash = 'a'.repeat(64); // valid 64-char hex string
    const res = await request(app)
      .post('/api/v1/chat/directory/lookup')
      .set('Authorization', `Bearer ${token}`)
      .send({ hashes: [validHash] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('matches');
  });
});

// ─── Search: Validation ───────────────────────────────────────

describe('GET /api/v1/chat/directory/search', () => {
  it('rejects query shorter than 2 chars', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/chat/directory/search')
      .set('Authorization', `Bearer ${token}`)
      .query({ q: 'a' });
    expect(res.status).toBe(400);
  });

  it('returns results for valid query', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/chat/directory/search')
      .set('Authorization', `Bearer ${token}`)
      .query({ q: 'test' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(Array.isArray(res.body.results)).toBe(true);
  });
});

// ─── Register in Directory ────────────────────────────────────

describe('POST /api/v1/chat/directory/register', () => {
  it('registers a user in the directory', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/directory/register')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId: 'windy_test123',
        displayName: 'Test User',
        email: 'test@example.com',
      });
    expect([200, 201]).toContain(res.status);
  });
});

// ─── 404 ──────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await request(app).get('/api/v1/chat/nonexistent');
    expect(res.status).toBe(404);
  });
});
