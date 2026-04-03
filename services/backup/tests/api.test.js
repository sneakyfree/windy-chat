const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-backup-secret';
process.env.CHAT_API_TOKEN = 'test-static-token';

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
    expect(res.body.service).toBe('windy-chat-backup');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ─── Auth Required ────────────────────────────────────────────

describe('Auth required on protected routes', () => {
  it('POST /api/v1/chat/backup/create returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/backup/create')
      .send({ data: 'encrypted-blob' });
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/chat/backup/list returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/chat/backup/list');
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/chat/backup/restore returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/chat/backup/restore')
      .send({ backupId: 'test-id' });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/v1/chat/backup/delete returns 401 without auth', async () => {
    const res = await request(app)
      .delete('/api/v1/chat/backup/delete')
      .send({ backupId: 'test-id' });
    expect(res.status).toBe(401);
  });
});

// ─── Backup Create: Validation ────────────────────────────────

describe('POST /api/v1/chat/backup/create (with auth)', () => {
  it('rejects missing userId', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/backup/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ encryptedData: 'base64data' });
    expect(res.status).toBe(400);
  });

  it('rejects missing encrypted data', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/backup/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'test-user-001' });
    expect(res.status).toBe(400);
  });

  it('creates a backup (happy path)', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/backup/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId: 'test-user-001',
        encryptedData: 'base64-encrypted-blob-data',
        metadata: { messageCount: 42, roomCount: 3 },
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('backupId');
  });
});

// ─── Backup List ──────────────────────────────────────────────

describe('GET /api/v1/chat/backup/list (with auth)', () => {
  it('rejects missing userId', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/chat/backup/list')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('returns backup list', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/chat/backup/list')
      .set('Authorization', `Bearer ${token}`)
      .query({ userId: 'test-user-001' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('backups');
    expect(Array.isArray(res.body.backups)).toBe(true);
  });
});

// ─── Restore: Validation ──────────────────────────────────────

describe('POST /api/v1/chat/backup/restore (with auth)', () => {
  it('rejects missing userId', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/backup/restore')
      .set('Authorization', `Bearer ${token}`)
      .send({ backupId: 'test-id' });
    expect(res.status).toBe(400);
  });

  it('rejects missing backupId', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/chat/backup/restore')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'test-user-001' });
    expect(res.status).toBe(400);
  });
});

// ─── 404 ──────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await request(app).get('/api/v1/chat/nonexistent');
    expect(res.status).toBe(404);
  });
});
