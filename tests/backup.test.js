/**
 * Tests for Windy Chat — Backup Service (K8)
 *
 * Run: node --test tests/backup.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.CHAT_API_TOKEN = 'test-token-backup';
process.env.WINDY_JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

const { app, encryptBackup, decryptBackup } = require('../services/backup/server');
const backupDb = require('../services/backup/lib/db');

let server;
let baseUrl;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CHAT_API_TOKEN}`,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

before(() => new Promise((resolve) => {
  // Clean test data to prevent pollution from prior test runs
  backupDb.db.exec('DELETE FROM backup_registry');
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); });
}));

// ── Encryption unit tests ──

describe('Encryption (AES-256-GCM)', () => {
  it('encrypts and decrypts data correctly', () => {
    const plaintext = 'Hello, this is secret chat data!';
    const password = 'my-backup-password-123';

    const encrypted = encryptBackup(Buffer.from(plaintext), password);
    assert.ok(Buffer.isBuffer(encrypted));
    assert.ok(encrypted.length > plaintext.length); // salt + iv + tag + ciphertext

    const decrypted = decryptBackup(encrypted, password);
    assert.equal(decrypted.toString(), plaintext);
  });

  it('fails with wrong password', () => {
    const encrypted = encryptBackup(Buffer.from('secret'), 'correct-password');
    assert.throws(() => {
      decryptBackup(encrypted, 'wrong-password');
    });
  });

  it('produces different ciphertext for same plaintext (random salt/iv)', () => {
    const data = Buffer.from('same data');
    const password = 'password';
    const enc1 = encryptBackup(data, password);
    const enc2 = encryptBackup(data, password);
    assert.notDeepEqual(enc1, enc2);
  });

  it('encrypted format is salt(32) + iv(12) + tag(16) + ciphertext', () => {
    const data = Buffer.from('test');
    const encrypted = encryptBackup(data, 'pass');
    // Minimum size: 32 + 12 + 16 + at least 1 byte of ciphertext
    assert.ok(encrypted.length >= 61);
  });
});

// ── Health ──

describe('GET /health', () => {
  it('returns service status with R2 status', async () => {
    const res = await request('GET', '/health', null, { Authorization: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'windy-chat-backup');
    assert.ok(res.body.uptime);
    assert.ok(res.body.dependencies);
    assert.equal(res.body.dependencies.r2, 'stubbed');
  });
});

// ── 404 ──

describe('Unknown routes', () => {
  it('returns 404 JSON', async () => {
    const res = await request('GET', '/nonexistent');
    assert.equal(res.status, 404);
  });
});

// ── Auth ──

describe('Auth', () => {
  it('rejects missing auth on create', async () => {
    const res = await request('POST', '/api/v1/chat/backup/create', {
      userId: 'user1',
      encryptedData: Buffer.from('test').toString('base64'),
    }, { Authorization: '' });
    assert.equal(res.status, 401);
  });
});

// ── Create Backup ──

describe('POST /api/v1/chat/backup/create', () => {
  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/chat/backup/create', {
      encryptedData: Buffer.from('test').toString('base64'),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId/);
  });

  it('rejects missing encryptedData', async () => {
    const res = await request('POST', '/api/v1/chat/backup/create', {
      userId: 'user1',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /encryptedData/);
  });

  it('rejects non-string encryptedData', async () => {
    const res = await request('POST', '/api/v1/chat/backup/create', {
      userId: 'user1',
      encryptedData: 12345,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid userId chars', async () => {
    const res = await request('POST', '/api/v1/chat/backup/create', {
      userId: 'user with spaces',
      encryptedData: Buffer.from('test').toString('base64'),
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid metadata type', async () => {
    const res = await request('POST', '/api/v1/chat/backup/create', {
      userId: 'user1',
      encryptedData: Buffer.from('test').toString('base64'),
      metadata: 'not-an-object',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /metadata/);
  });

  it('creates a backup with stub R2', async () => {
    const data = encryptBackup(Buffer.from('my chat messages'), 'password');
    const res = await request('POST', '/api/v1/chat/backup/create', {
      userId: 'backup_test_user',
      encryptedData: data.toString('base64'),
      metadata: { messageCount: 42 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.backupId);
    assert.ok(res.body.timestamp);
    assert.ok(res.body.size > 0);
    assert.ok(res.body.path.startsWith('backups/'));
  });
});

// ── List Backups ──

describe('GET /api/v1/chat/backup/list', () => {
  it('rejects missing userId', async () => {
    const res = await request('GET', '/api/v1/chat/backup/list');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId/);
  });

  it('returns empty for unknown user', async () => {
    const res = await request('GET', '/api/v1/chat/backup/list?userId=nobody');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.backups, []);
    assert.equal(res.body.maxBackups, 7);
  });

  it('lists backups for user who created one', async () => {
    const res = await request('GET', '/api/v1/chat/backup/list?userId=backup_test_user');
    assert.equal(res.status, 200);
    assert.ok(res.body.count >= 1);
    assert.ok(res.body.backups[0].id);
    assert.ok(res.body.backups[0].sizeFormatted);
  });
});

// ── Restore Backup ──

describe('POST /api/v1/chat/backup/restore', () => {
  it('rejects missing userId', async () => {
    const res = await request('POST', '/api/v1/chat/backup/restore', {
      backupId: 'some-id',
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing backupId', async () => {
    const res = await request('POST', '/api/v1/chat/backup/restore', {
      userId: 'user1',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /backupId/);
  });

  it('returns 404 for non-existent backup', async () => {
    const res = await request('POST', '/api/v1/chat/backup/restore', {
      userId: 'backup_test_user',
      backupId: 'nonexistent-id',
    });
    assert.equal(res.status, 404);
  });

  it('restores an existing backup (stub R2 returns null data)', async () => {
    // Get the backup ID
    const list = await request('GET', '/api/v1/chat/backup/list?userId=backup_test_user');
    const backupId = list.body.backups[0].id;

    const res = await request('POST', '/api/v1/chat/backup/restore', {
      userId: 'backup_test_user',
      backupId,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.backupId, backupId);
    assert.ok(res.body.timestamp);
  });
});

// ── Delete Backup ──

describe('DELETE /api/v1/chat/backup/delete', () => {
  it('rejects missing userId', async () => {
    const res = await request('DELETE', '/api/v1/chat/backup/delete', {
      backupId: 'some-id',
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent backup', async () => {
    const res = await request('DELETE', '/api/v1/chat/backup/delete', {
      userId: 'backup_test_user',
      backupId: 'nonexistent',
    });
    assert.equal(res.status, 404);
  });

  it('deletes an existing backup', async () => {
    // Create a fresh backup for a unique user
    const createRes = await request('POST', '/api/v1/chat/backup/create', {
      userId: 'delete_test_user',
      encryptedData: Buffer.from('delete-me').toString('base64'),
    });
    const backupId = createRes.body.backupId;

    const res = await request('DELETE', '/api/v1/chat/backup/delete', {
      userId: 'delete_test_user',
      backupId,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.deleted, backupId);

    // Verify it's gone
    const list = await request('GET', '/api/v1/chat/backup/list?userId=delete_test_user');
    assert.equal(list.body.count, 0);
  });
});

// ── Retention: max 7 backups ──

describe('Backup retention (max 7)', () => {
  it('prunes oldest backup when exceeding 7', async () => {
    const data = Buffer.from('test').toString('base64');

    // Create 8 backups
    for (let i = 0; i < 8; i++) {
      await request('POST', '/api/v1/chat/backup/create', {
        userId: 'retention_test_user',
        encryptedData: data,
        metadata: { index: i },
      });
    }

    const list = await request('GET', '/api/v1/chat/backup/list?userId=retention_test_user');
    assert.equal(list.body.count, 7);
    assert.equal(list.body.maxBackups, 7);
    // Most recent should be first (index 7)
    assert.equal(list.body.backups[0].metadata.index, 7);
  });
});
