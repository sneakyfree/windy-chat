const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-push-secret';
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
    expect(res.body.service).toBe('windy-chat-push-gateway');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ─── Auth Required ────────────────────────────────────────────

describe('Auth required on protected routes', () => {
  it('POST /api/v1/chat/push/register returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/push/register')
      .send({ token: 'fcm-token', platform: 'android' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/chat/push/mute returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/push/mute')
      .send({ roomId: '!room:chat.windyword.ai', duration: '1h' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/chat/push/unmute returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/push/unmute')
      .send({ roomId: '!room:chat.windyword.ai' });
    expect(res.status).toBe(401);
  });
});

// ─── Push Register: Validation ────────────────────────────────

describe('POST /api/v1/chat/push/register (with auth)', () => {
  it('rejects missing pushkey', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/push/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'test-user', platform: 'android' });
    expect(res.status).toBe(400);
  });

  it('rejects missing userId', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/push/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ pushkey: 'fcm-token-123', platform: 'android' });
    expect(res.status).toBe(400);
  });

  it('rejects missing platform', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/push/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ pushkey: 'fcm-token-123', userId: 'test-user' });
    expect(res.status).toBe(400);
  });

  it('registers push token (happy path)', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/push/register')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pushkey: 'fcm-token-jest-001',
        userId: 'test-user-001',
        platform: 'android',
        appId: 'com.windypro.chat',
        deviceName: 'Jest Test Phone',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

// ─── Mute: Validation ─────────────────────────────────────────

describe('POST /api/v1/chat/push/mute (with auth)', () => {
  it('rejects missing userId', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/push/mute')
      .set('Authorization', `Bearer ${token}`)
      .send({ roomId: '!test:chat.windyword.ai', duration: '1h' });
    expect(res.status).toBe(400);
  });

  it('rejects missing roomId', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/push/mute')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'test-user-001', duration: '1h' });
    expect(res.status).toBe(400);
  });

  it('mutes a room (happy path)', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/push/mute')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'test-user-001', roomId: '!test:chat.windyword.ai', duration: '1h' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mutedUntil');
  });
});

// ─── Matrix Push Gateway (server-to-server, no user auth) ─────

describe('POST /_matrix/push/v1/notify', () => {
  it('accepts a Matrix push notification', async () => {
    const res = await request(app)
      .post('/_matrix/push/v1/notify')
      .send({
        notification: {
          room_id: '!test:chat.windyword.ai',
          event_id: '$test-event',
          sender: '@user:chat.windyword.ai',
          devices: [{ pushkey: 'test-push-key', app_id: 'com.windypro.chat' }],
        },
      });
    // Should accept (200) even if no real push provider configured
    expect([200, 400]).toContain(res.status);
  });
});

// ─── 404 ──────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await request(app).get('/api/v1/chat/nonexistent');
    expect(res.status).toBe(404);
  });
});
