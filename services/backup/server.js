/**
 * Windy Chat — Cloud Backup & Sync Service
 * K8: Chat Cloud Backup and Sync (DNA Strand K)
 *
 * Encrypted backup of chat data to Cloudflare R2 (S3-compatible).
 * Zero-knowledge: server CANNOT decrypt backups.
 *
 * K8.1 Encrypted chat backup (AES-256-GCM, PBKDF2 key derivation)
 * K8.2 Restore on new device
 * K8.3 Soul File integration
 *
 * Port: 8104
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const pathModule = require('path');
const { createCorsOptions } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { asyncHandler } = require('../shared/async-handler');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');
const backupDb = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 8104;

// ── CORS — shared origin whitelist (windypro.com, windychat.com, etc.) ──
app.use(cors(createCorsOptions()));

app.use(express.json({ limit: '1mb' }));

initSentry(app, 'windy-chat-backup');

// ── Auth middleware — JWT + bot API key + legacy CHAT_API_TOKEN fallback ──
// Phase 6A: Replaced static CHAT_API_TOKEN with proper JWT validation.
// CHAT_API_TOKEN still works as fallback for backward compatibility.
const { createAuthMiddleware } = require('../shared/jwt-verify');

const authMiddleware = createAuthMiddleware();

// ── Global rate limiter ──
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ── Input validation helpers ──

function isValidUserId(val) {
  return typeof val === 'string' && val.length > 0 && val.length <= 255 && /^[a-zA-Z0-9_-]+$/.test(val);
}

// ── SQLite-backed persistence (via ./lib/db) ──

// ── Storage Config ──
// Two modes:
//   1. Windy Cloud API (preferred) — routes backups through Windy Cloud at WINDY_CLOUD_URL
//   2. Direct R2/S3 (fallback) — connects directly to Cloudflare R2 via S3-compatible API
const WINDY_CLOUD_URL = process.env.WINDY_CLOUD_URL || '';
const R2_BUCKET = process.env.R2_BUCKET || 'windy-chat-backups';
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';

let s3Client = null;
let storageMode = 'stub'; // 'windy-cloud' | 'r2-direct' | 'stub'

function initStorage() {
  if (WINDY_CLOUD_URL) {
    storageMode = 'windy-cloud';
    console.log(`☁️  Backup storage: Windy Cloud API (${WINDY_CLOUD_URL})`);
    return;
  }

  if (R2_ENDPOINT && R2_ACCESS_KEY) {
    try {
      const { S3Client } = require('@aws-sdk/client-s3');
      s3Client = new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
      });
      storageMode = 'r2-direct';
      console.log('☁️  Backup storage: Direct R2/S3');
    } catch (err) {
      console.error('R2 init error:', err.message);
    }
    return;
  }

  console.warn('⚠️  No backup storage configured — backups will be stubbed');
}

// ── Windy Cloud API helpers ──
const http = require('http');
const https = require('https');

function cloudRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, WINDY_CLOUD_URL);
    const httpModule = url.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CHAT_API_TOKEN || ''}`,
      },
      timeout: 30000,
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = httpModule.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`Windy Cloud ${method} ${path}: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Windy Cloud request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function uploadToStorage(path, data, metadata) {
  if (storageMode === 'windy-cloud') {
    await cloudRequest('POST', '/api/v1/archive/code-settings', JSON.stringify({
      type: 'chat-backup',
      path,
      data: data.toString('base64'),
      metadata,
    }));
    return;
  }
  if (storageMode === 'r2-direct' && s3Client) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: path,
      Body: data,
      ContentType: 'application/octet-stream',
      Metadata: metadata,
    }));
    return;
  }
  console.log(`☁️  [STUB] Backup stored: ${path} (${formatSize(data.length)})`);
}

async function downloadFromStorage(path) {
  if (storageMode === 'windy-cloud') {
    const result = await cloudRequest('GET', `/api/v1/archive/code-settings?type=chat-backup&path=${encodeURIComponent(path)}`);
    return Buffer.from(result.data, 'base64');
  }
  if (storageMode === 'r2-direct' && s3Client) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const response = await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: path }));
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  console.log(`☁️  [STUB] Restore: ${path}`);
  return null;
}

async function deleteFromStorage(path) {
  if (storageMode === 'windy-cloud') {
    await cloudRequest('DELETE', `/api/v1/archive/code-settings?type=chat-backup&path=${encodeURIComponent(path)}`);
    return;
  }
  if (storageMode === 'r2-direct' && s3Client) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));
    return;
  }
  console.log(`🗑️  [STUB] Would delete backup: ${path}`);
}

// ── K8.1.2: Backup Encryption Helpers ──

/**
 * Derive backup encryption key from password using PBKDF2.
 * 100K iterations for brute-force resistance.
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
}

/**
 * Encrypt backup data with AES-256-GCM (authenticated encryption).
 * Server CANNOT decrypt — zero-knowledge.
 */
function encryptBackup(data, password) {
  const salt = crypto.randomBytes(32);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: salt(32) + iv(12) + authTag(16) + ciphertext
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt backup data.
 */
function decryptBackup(encryptedData, password) {
  const salt = encryptedData.subarray(0, 32);
  const iv = encryptedData.subarray(32, 44);
  const authTag = encryptedData.subarray(44, 60);
  const ciphertext = encryptedData.subarray(60);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Health check (no auth required) ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-backup',
  version: '1.0.0',
  checks: async () => ({
    storage: storageMode,
    registeredUsers: backupDb.countDistinctUsers.get().cnt,
  }),
}));

// ── POST /api/v1/chat/backup/create (auth required) ──

app.post('/api/v1/chat/backup/create', authMiddleware, asyncHandler(async (req, res) => {
  try {
    const { userId, encryptedData, metadata } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    if (!encryptedData || typeof encryptedData !== 'string') {
      return res.status(400).json({ error: 'encryptedData is required and must be a base64 string' });
    }

    // Validate size (express.json limit is 1mb, also check decoded size)
    const dataSize = Buffer.byteLength(encryptedData, 'base64');
    if (dataSize > 500 * 1024 * 1024) {
      return res.status(413).json({ error: 'Backup too large. Max 500MB.' });
    }

    // Validate metadata if provided
    if (metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) {
      return res.status(400).json({ error: 'metadata must be an object' });
    }

    const backupId = uuidv4();
    const timestamp = new Date().toISOString();
    const path = `backups/${userId}/${timestamp.replace(/[:.]/g, '-')}.enc`;

    await uploadToStorage(path, Buffer.from(encryptedData, 'base64'), {
      'x-windy-user': userId,
      'x-windy-backup-id': backupId,
    });

    // Register backup in SQLite
    backupDb.insertBackup.run({
      id: backupId,
      user_id: userId,
      windy_identity_id: req.user.windy_identity_id || null,
      timestamp,
      size: dataSize,
      path,
      metadata: JSON.stringify(metadata || {}),
    });

    // K8.1.3: Keep last 7 daily backups — prune oldest
    const backupCount = backupDb.countUserBackups.get(userId).cnt;
    if (backupCount > 7) {
      const pruned = backupDb.getOldestBackups.all(userId, 7);
      for (const old of pruned) {
        try {
          await deleteFromStorage(old.path);
          console.log(`🗑️  Deleted pruned backup: ${old.path}`);
        } catch (err) {
          console.error(`🗑️  Failed to delete pruned backup: ${old.path}`, err.message);
        }
      }
      backupDb.deleteOldBackups.run(userId, userId, 7);
      console.log(`🗑️  Pruned ${pruned.length} old backup(s) for ${userId.slice(0, 12)}`);
    }

    console.log(`☁️  Backup created: ${userId.slice(0, 12)} → ${formatSize(dataSize)}`);

    res.status(201).json({
      success: true,
      backupId,
      timestamp,
      size: dataSize,
      path,
    });

  } catch (err) {
    console.error('Backup create error:', err);
    res.status(500).json({ error: 'Backup failed' });
  }
}));

// ── GET /api/v1/chat/backup/list (auth required) ──

app.get('/api/v1/chat/backup/list', authMiddleware, (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    const backups = backupDb.getUserBackups.all(userId).map(backupDb.rowToBackup);

    res.json({
      userId,
      backups: backups.map(b => ({
        id: b.id,
        timestamp: b.timestamp,
        size: b.size,
        sizeFormatted: formatSize(b.size),
        metadata: b.metadata,
      })),
      count: backups.length,
      maxBackups: 7,
    });
  } catch (err) {
    console.error('Backup list error:', err);
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// ── POST /api/v1/chat/backup/restore (auth required) ──

app.post('/api/v1/chat/backup/restore', authMiddleware, asyncHandler(async (req, res) => {
  try {
    const { userId, backupId } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    if (!backupId || typeof backupId !== 'string' || backupId.length > 255) {
      return res.status(400).json({ error: 'backupId is required, max 255 characters' });
    }

    const backupRow = backupDb.getBackup.get(userId, backupId);
    const backup = backupDb.rowToBackup(backupRow);

    if (!backup) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    const rawData = await downloadFromStorage(backup.path);
    const encryptedData = rawData ? rawData.toString('base64') : null;

    res.json({
      success: true,
      backupId: backup.id,
      timestamp: backup.timestamp,
      size: backup.size,
      encryptedData,
      message: 'Decrypt this backup on your device with your backup password',
    });

  } catch (err) {
    console.error('Backup restore error:', err);
    res.status(500).json({ error: 'Restore failed' });
  }
}));

// ── DELETE /api/v1/chat/backup/delete (auth required) ──

app.delete('/api/v1/chat/backup/delete', authMiddleware, asyncHandler(async (req, res) => {
  try {
    const { userId, backupId } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    if (!backupId || typeof backupId !== 'string' || backupId.length > 255) {
      return res.status(400).json({ error: 'backupId is required, max 255 characters' });
    }

    const removedRow = backupDb.getBackup.get(userId, backupId);
    if (!removedRow) return res.status(404).json({ error: 'Backup not found' });

    const removed = backupDb.rowToBackup(removedRow);
    backupDb.deleteBackup.run(userId, backupId);

    try {
      await deleteFromStorage(removed.path);
      console.log(`🗑️  Deleted backup: ${removed.path}`);
    } catch (err) {
      console.error(`🗑️  Failed to delete backup: ${removed.path}`, err.message);
    }

    res.json({ success: true, deleted: removed.id });
  } catch (err) {
    console.error('Backup delete error:', err);
    res.status(500).json({ error: 'Failed to delete backup' });
  }
}));

// ── POST /api/v1/chat/backup/schedule — trigger scheduled backup for a user ──
app.post('/api/v1/chat/backup/schedule', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const windyId = req.user.windy_identity_id || userId;

  // Store schedule preference
  backupDb.db.exec(`
    CREATE TABLE IF NOT EXISTS backup_schedule (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      interval_hours INTEGER DEFAULT 24,
      last_scheduled TEXT,
      created_at TEXT NOT NULL
    )
  `);

  const intervalHours = Math.max(1, Math.min(168, parseInt(req.body.interval_hours) || 24));
  backupDb.db.prepare(`
    INSERT OR REPLACE INTO backup_schedule (user_id, enabled, interval_hours, created_at)
    VALUES (?, 1, ?, datetime('now'))
  `).run(windyId, intervalHours);

  console.log(`📅 Backup schedule set: ${windyId} every ${intervalHours}h`);
  res.json({ scheduled: true, interval_hours: intervalHours });
}));

// ── GET /api/v1/chat/backup/schedule — get schedule status ──
app.get('/api/v1/chat/backup/schedule', authMiddleware, (req, res) => {
  const windyId = req.user.windy_identity_id || req.user.sub;
  try {
    const row = backupDb.db.prepare('SELECT * FROM backup_schedule WHERE user_id = ?').get(windyId);
    res.json(row ? { scheduled: true, enabled: !!row.enabled, interval_hours: row.interval_hours, last_scheduled: row.last_scheduled } : { scheduled: false });
  } catch {
    res.json({ scheduled: false });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ──
app.use(sentryErrorHandler());
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Scheduled backup runner — checks every hour for users due for backup ──
const SCHEDULE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

function runScheduledBackups() {
  try {
    backupDb.db.exec(`
      CREATE TABLE IF NOT EXISTS backup_schedule (
        user_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 1,
        interval_hours INTEGER DEFAULT 24,
        last_scheduled TEXT,
        created_at TEXT NOT NULL
      )
    `);

    const due = backupDb.db.prepare(`
      SELECT * FROM backup_schedule
      WHERE enabled = 1
      AND (last_scheduled IS NULL OR datetime(last_scheduled, '+' || interval_hours || ' hours') < datetime('now'))
    `).all();

    for (const schedule of due) {
      console.log(`📅 Scheduled backup due for ${schedule.user_id}`);
      backupDb.db.prepare('UPDATE backup_schedule SET last_scheduled = datetime(\'now\') WHERE user_id = ?').run(schedule.user_id);
      // The actual backup is client-initiated (encrypted on device).
      // This schedule tracks *intent* — the client polls GET /schedule and triggers backup.
    }

    if (due.length > 0) {
      console.log(`📅 ${due.length} scheduled backup(s) marked as due`);
    }
  } catch (err) {
    console.error('Scheduled backup check error:', err.message);
  }
}

// ── Start ──
initStorage();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🌪️  Windy Chat Backup — listening on port ${PORT}`);
    console.log(`   Storage: ${storageMode}`);
  });
  // Run scheduled backup check on startup and every hour
  runScheduledBackups();
  setInterval(runScheduledBackups, SCHEDULE_CHECK_INTERVAL);
}

module.exports = { app, encryptBackup, decryptBackup };
