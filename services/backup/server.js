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
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const pathModule = require('path');
const { createCorsMiddleware } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { createVersionHandler } = require('../shared/version');
const { asyncHandler } = require('../shared/async-handler');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');
const { bodyErrorHandler } = require('../shared/body-errors');
const backupDb = require('./lib/db');

const app = express();
// Behind host nginx (single hop) — trust it so express-rate-limit keys on the
// real client IP, not nginx's 127.0.0.1 (which buckets all clients together).
// Mirrors push-gateway (fixed 2026-05-08); the sibling services were missed.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8104;

// ── CORS — shared allowlist with explicit 403 on disallowed origins
// (Wave 14; replaces throwing cors(createCorsOptions()) which 500'd).
app.use(createCorsMiddleware());

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
    if (!WINDY_CLOUD_SERVICE_TOKEN) {
      console.warn('⚠️  WINDY_CLOUD_URL is set but WINDY_CLOUD_SERVICE_TOKEN is missing — cloud uploads will fail until it is provisioned');
    }
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
// The cloud kernel's archive contract (windy-cloud api/app/routes/archive.py
// + auth/webhook.py): uploads are POST /api/v1/archive/chat authenticated by
// X-Service-Token, multipart form with `file` + `metadata` (JSON string) +
// `filename` + `windy_identity_id` — required for service-token callers; the
// kernel files the object under <identity>/windy_chat/chat_backup/<filename>.
// Retrieval and deletion are USER-authenticated (Bearer JWT verified against
// the same JWKS the kernel trusts), so those calls forward the requesting
// user's own token: GET /api/v1/archive/retrieve/windy_chat/<filename> and
// DELETE /api/v1/storage/files/<file_id>.
const http = require('http');
const https = require('https');

const WINDY_CLOUD_SERVICE_TOKEN =
  process.env.WINDY_CLOUD_SERVICE_TOKEN || process.env.WINDY_CLOUD_TOKEN || '';
const CLOUD_PRODUCT = 'windy_chat';
// Mirror K8.1.3's keep-last-7 on the kernel side: the kernel prunes the
// oldest chat_backup objects beyond this count per identity, which covers
// callers that can't perform an authenticated remote delete.
const CLOUD_RETENTION_COUNT = 7;

// The kernel sanitizes path separators out of filenames, so flatten our
// backup path the same way for upload AND retrieval.
function cloudFilenameFor(storagePath) {
  return storagePath.split('/').filter(Boolean).join('_');
}

function buildMultipart(fields, file) {
  const boundary = '----WindyBackup' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`
  ));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function cloudRequest({ method, path: requestPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, WINDY_CLOUD_URL);
    const httpModule = url.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers },
      timeout: 30000,
    };
    if (body) opts.headers['Content-Length'] = body.length;
    const req = httpModule.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(
          `Windy Cloud ${method} ${url.pathname}: ${res.statusCode} ${data.toString('utf8').slice(0, 200)}`
        ));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Windy Cloud request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// Extract a forwardable end-user JWT from the incoming request. The legacy
// static CHAT_API_TOKEN is not a kernel-valid credential — return null so
// cloud calls that need a user token fail with a clear error instead.
function bearerFrom(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || (process.env.CHAT_API_TOKEN && token === process.env.CHAT_API_TOKEN)) return null;
  return token;
}

async function uploadToStorage(path, data, metadata, cloud = {}) {
  if (storageMode === 'windy-cloud') {
    if (!WINDY_CLOUD_SERVICE_TOKEN) {
      throw new Error('WINDY_CLOUD_SERVICE_TOKEN is not configured — cannot upload to Windy Cloud');
    }
    if (!cloud.identityId) {
      throw new Error('windy_identity_id is required for Windy Cloud backup uploads');
    }
    const filename = cloudFilenameFor(path);
    const multipart = buildMultipart(
      {
        windy_identity_id: cloud.identityId,
        filename,
        metadata: JSON.stringify({
          encrypted: true,
          retention_count: CLOUD_RETENTION_COUNT,
          source: 'windy-chat',
          ...metadata,
        }),
      },
      { filename, contentType: 'application/octet-stream', data },
    );
    const raw = await cloudRequest({
      method: 'POST',
      path: '/api/v1/archive/chat',
      headers: {
        'X-Service-Token': WINDY_CLOUD_SERVICE_TOKEN,
        'Content-Type': multipart.contentType,
      },
      body: multipart.body,
    });
    let parsed = {};
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { /* tolerate empty body */ }
    return { file_id: parsed.file_id, key: parsed.key };
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
    return null;
  }
  console.log(`☁️  [STUB] Backup stored: ${path} (${formatSize(data.length)})`);
  return null;
}

async function downloadFromStorage(path, cloud = {}) {
  if (storageMode === 'windy-cloud') {
    if (!cloud.bearer) {
      throw new Error('Cloud restore requires the requesting user\'s own token');
    }
    return await cloudRequest({
      method: 'GET',
      path: `/api/v1/archive/retrieve/${CLOUD_PRODUCT}/${encodeURIComponent(cloudFilenameFor(path))}`,
      headers: { 'Authorization': `Bearer ${cloud.bearer}` },
    });
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

async function deleteFromStorage(path, cloud = {}) {
  if (storageMode === 'windy-cloud') {
    if (cloud.bearer && cloud.fileId) {
      await cloudRequest({
        method: 'DELETE',
        path: `/api/v1/storage/files/${encodeURIComponent(cloud.fileId)}`,
        headers: { 'Authorization': `Bearer ${cloud.bearer}` },
      });
    } else {
      // No forwardable user token or no kernel file id — the kernel's
      // retention_count prunes surplus backups server-side.
      console.log(`☁️  Skipped remote delete (kernel retention handles pruning): ${path}`);
    }
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

// ── MF1: /version (deployment identity, no auth, no DB) ──
app.get('/version', createVersionHandler({
  service: 'windy-chat-backup',
  version: '1.0.0',
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

    // The cloud kernel requires the owner's windy_identity_id on every
    // service-token upload — it decides whose storage the backup lands in.
    const windyIdentityId = req.user.windy_identity_id || null;
    if (storageMode === 'windy-cloud' && !windyIdentityId) {
      return res.status(400).json({ error: 'Cloud backup requires a Windy account token (missing windy_identity_id)' });
    }

    const backupId = uuidv4();
    const timestamp = new Date().toISOString();
    const path = `backups/${userId}/${timestamp.replace(/[:.]/g, '-')}.enc`;

    const cloudFile = await uploadToStorage(path, Buffer.from(encryptedData, 'base64'), {
      'x-windy-user': userId,
      'x-windy-backup-id': backupId,
    }, { identityId: windyIdentityId });

    // Register backup in SQLite. The kernel-assigned file id rides in the
    // row metadata (_cloud) so later delete calls can target it.
    backupDb.insertBackup.run({
      id: backupId,
      user_id: userId,
      windy_identity_id: windyIdentityId,
      timestamp,
      size: dataSize,
      path,
      metadata: JSON.stringify({
        ...(metadata || {}),
        ...(cloudFile && cloudFile.file_id ? { _cloud: cloudFile } : {}),
      }),
    });

    // K8.1.3: Keep last 7 daily backups — prune oldest
    const backupCount = backupDb.countUserBackups.get(userId).cnt;
    if (backupCount > 7) {
      const bearer = bearerFrom(req);
      const pruned = backupDb.getOldestBackups.all(userId, 7);
      for (const old of pruned) {
        try {
          let oldCloudId = null;
          try { oldCloudId = (JSON.parse(old.metadata || '{}')._cloud || {}).file_id || null; } catch { /* legacy rows */ }
          await deleteFromStorage(old.path, { bearer, fileId: oldCloudId });
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
        // _cloud carries kernel-internal file ids — not part of the client contract
        metadata: (({ _cloud, ...rest }) => rest)(b.metadata || {}),
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

    // The kernel's retrieve endpoint is user-authenticated — forward the
    // requesting user's own token (the kernel trusts the same JWKS).
    const bearer = bearerFrom(req);
    if (storageMode === 'windy-cloud' && !bearer) {
      return res.status(400).json({ error: 'Cloud restore requires your own login token' });
    }

    const rawData = await downloadFromStorage(backup.path, { bearer });
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
      await deleteFromStorage(removed.path, {
        bearer: bearerFrom(req),
        fileId: ((removed.metadata || {})._cloud || {}).file_id || null,
      });
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
app.use(bodyErrorHandler());
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

module.exports = {
  app,
  encryptBackup,
  decryptBackup,
  // exposed for contract tests
  _cloudInternals: { buildMultipart, cloudFilenameFor },
};
