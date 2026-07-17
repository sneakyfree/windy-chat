/**
 * Windy Cloud kernel archive-contract tests.
 *
 * The kernel (windy-cloud api/app/routes/archive.py + auth/webhook.py)
 * expects uploads as: POST /api/v1/archive/chat with X-Service-Token +
 * multipart form fields `file`, `metadata` (JSON string), `filename`,
 * `windy_identity_id`. Retrieval forwards the USER's own bearer to
 * GET /api/v1/archive/retrieve/windy_chat/<filename>.
 *
 * These tests run the backup service against a mock kernel and assert the
 * exact wire shape — the pre-fix client sent `Authorization: Bearer
 * CHAT_API_TOKEN` + a JSON body, which the real kernel 401s.
 */
const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-backup-secret';
process.env.CHAT_API_TOKEN = 'test-static-token';
process.env.WINDY_CLOUD_SERVICE_TOKEN = 'test-cloud-service-token';

const SERVICE_TOKEN = process.env.WINDY_CLOUD_SERVICE_TOKEN;
const IDENTITY = '11111111-2222-3333-4444-555555555555';

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 'contract-user-001', role: 'user', windy_identity_id: IDENTITY, ...payload },
    process.env.WINDY_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

// ── Mock kernel ──────────────────────────────────────────────
const received = [];
const mockKernel = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/archive/chat') {
      res.end(JSON.stringify({
        file_id: 'mock-file-id-123',
        key: `${IDENTITY}/windy_chat/chat_backup/mock.enc`,
        product: 'windy_chat',
        type: 'chat_backup',
        size: 42,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v1/archive/retrieve/windy_chat/')) {
      // kernel returns raw file bytes
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(Buffer.from('restored-bytes'));
      return;
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/v1/storage/files/')) {
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: 'Not found' }));
  });
});

let app;

beforeAll((done) => {
  mockKernel.listen(0, '127.0.0.1', () => {
    const { port } = mockKernel.address();
    process.env.WINDY_CLOUD_URL = `http://127.0.0.1:${port}`;
    ({ app } = require('../server'));
    done();
  });
});

afterAll((done) => {
  mockKernel.close(done);
});

describe('Windy Cloud kernel archive contract', () => {
  it('uploads via X-Service-Token multipart with windy_identity_id (POST /api/v1/archive/chat)', async () => {
    const res = await request(app)
      .post('/api/v1/chat/backup/create')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        userId: 'contract-user-001',
        encryptedData: Buffer.from('encrypted-blob').toString('base64'),
        metadata: { note: 'contract-test' },
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const upload = received.find(r => r.method === 'POST' && r.url === '/api/v1/archive/chat');
    expect(upload).toBeDefined();
    // Kernel auth: X-Service-Token, NOT Authorization: Bearer
    expect(upload.headers['x-service-token']).toBe(SERVICE_TOKEN);
    expect(upload.headers.authorization).toBeUndefined();
    // Multipart body carrying the required fields
    expect(upload.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = upload.body.toString('utf8');
    expect(body).toContain('name="windy_identity_id"');
    expect(body).toContain(IDENTITY);
    expect(body).toContain('name="file"');
    expect(body).toContain('name="filename"');
    expect(body).toContain('name="metadata"');
    expect(body).toContain('"retention_count":7');
    expect(body).toContain('encrypted-blob');
  });

  it('rejects cloud backup for callers without a windy_identity_id', async () => {
    const res = await request(app)
      .post('/api/v1/chat/backup/create')
      .set('Authorization', `Bearer ${makeToken({ windy_identity_id: undefined })}`)
      .send({
        userId: 'contract-user-002',
        encryptedData: Buffer.from('x').toString('base64'),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/windy_identity_id/);
  });

  it('restores by forwarding the user bearer to GET /archive/retrieve/windy_chat/…', async () => {
    const token = makeToken();
    const create = await request(app)
      .post('/api/v1/chat/backup/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId: 'contract-user-001',
        encryptedData: Buffer.from('encrypted-blob').toString('base64'),
      });
    expect(create.status).toBe(201);

    const res = await request(app)
      .post('/api/v1/chat/backup/restore')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'contract-user-001', backupId: create.body.backupId });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.encryptedData, 'base64').toString('utf8')).toBe('restored-bytes');

    const retrieve = received.find(r => r.method === 'GET' && r.url.startsWith('/api/v1/archive/retrieve/windy_chat/'));
    expect(retrieve).toBeDefined();
    // User's own JWT, not the service token
    expect(retrieve.headers.authorization).toBe(`Bearer ${token}`);
    expect(retrieve.headers['x-service-token']).toBeUndefined();
    // Flattened filename (kernel strips path separators)
    expect(decodeURIComponent(retrieve.url.split('/').pop())).toMatch(/^backups_contract-user-001_.+\.enc$/);
  });

  it('deletes via DELETE /storage/files/<kernel file_id> with the user bearer', async () => {
    const token = makeToken();
    const create = await request(app)
      .post('/api/v1/chat/backup/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId: 'contract-user-003',
        encryptedData: Buffer.from('to-delete').toString('base64'),
      });
    expect(create.status).toBe(201);

    const res = await request(app)
      .delete('/api/v1/chat/backup/delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'contract-user-003', backupId: create.body.backupId });
    expect(res.status).toBe(200);

    const del = received.find(r => r.method === 'DELETE' && r.url === '/api/v1/storage/files/mock-file-id-123');
    expect(del).toBeDefined();
    expect(del.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('does not leak kernel file ids in the list response', async () => {
    const res = await request(app)
      .get('/api/v1/chat/backup/list?userId=contract-user-001')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    for (const b of res.body.backups) {
      expect(b.metadata).not.toHaveProperty('_cloud');
    }
  });
});
