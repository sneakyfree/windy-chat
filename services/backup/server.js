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

const fs = require('fs');
const pathModule = require('path');

const app = express();
const PORT = process.env.PORT || 8104;

// ── CORS — explicit origin whitelist ──
const ALLOWED_ORIGINS = [
  'https://windypro.thewindstorm.uk',
  'https://chat.windypro.com',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    // SEC-M3: Only allow localhost in non-production environments
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// ── Auth middleware — JWT + bot API key + legacy CHAT_API_TOKEN fallback ──
// Phase 6A: Replaced static CHAT_API_TOKEN with proper JWT validation.
// CHAT_API_TOKEN still works as fallback for backward compatibility.
const { createAuthMiddleware } = require('../shared/jwt-verify');

const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';
if (!CHAT_API_TOKEN && !process.env.JWT_SECRET) {
  console.error('❌ Either JWT_SECRET or CHAT_API_TOKEN must be set.');
  process.exit(1);
}

const authMiddleware = createAuthMiddleware({
  fallbackToken: CHAT_API_TOKEN || undefined,
});

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

// ── In-memory stores with file-based persistence (M2) ──
const backupRegistry = new Map(); // userId → [{ version, timestamp, size, path }]

const BACKUP_DATA_DIR = pathModule.join(__dirname, 'data');
const BACKUP_REGISTRY_FILE = pathModule.join(BACKUP_DATA_DIR, 'backup-registry.json');

function loadBackupRegistry() {
  try {
    if (fs.existsSync(BACKUP_REGISTRY_FILE)) {
      const raw = fs.readFileSync(BACKUP_REGISTRY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.registry && typeof data.registry === 'object') {
        for (const [key, value] of Object.entries(data.registry)) {
          backupRegistry.set(key, value);
        }
      }
      console.log(`[Backup] Loaded ${backupRegistry.size} user backup registries from disk`);
    }
  } catch (err) {
    console.error('[Backup] Failed to load persisted registry:', err.message);
  }
}

function persistBackupRegistry() {
  try {
    if (!fs.existsSync(BACKUP_DATA_DIR)) {
      fs.mkdirSync(BACKUP_DATA_DIR, { recursive: true });
    }
    const data = {
      registry: Object.fromEntries(backupRegistry),
    };
    fs.writeFileSync(BACKUP_REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Backup] Failed to persist registry:', err.message);
  }
}

// Load persisted data on startup
loadBackupRegistry();

// ── R2/S3 Config ──
const R2_BUCKET = process.env.R2_BUCKET || 'windy-chat-backups';
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';

let s3Client = null;

function initR2() {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY) {
    console.warn('⚠️  R2/S3 not configured — backups will be stubbed');
    return;
  }
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
    });
    console.log('☁️  R2 storage initialized');
  } catch (err) {
    console.error('R2 init error:', err.message);
  }
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
app.get('/health', (_req, res) => {
  res.json({
    service: 'windy-chat-backup',
    status: 'ok',
    version: '1.0.0',
    r2: !!s3Client,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/v1/chat/backup/create (auth required) ──

app.post('/api/v1/chat/backup/create', authMiddleware, async (req, res) => {
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

    if (s3Client) {
      // Upload to R2
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: path,
        Body: Buffer.from(encryptedData, 'base64'),
        ContentType: 'application/octet-stream',
        Metadata: {
          'x-windy-user': userId,
          'x-windy-backup-id': backupId,
        },
      }));
    } else {
      console.log(`☁️  [STUB] Backup stored: ${path} (${formatSize(dataSize)})`);
    }

    // Register backup
    const userBackups = backupRegistry.get(userId) || [];
    userBackups.unshift({
      id: backupId,
      timestamp,
      size: dataSize,
      path,
      metadata: metadata || {},
    });

    // K8.1.3: Keep last 7 daily backups
    if (userBackups.length > 7) {
      const pruned = userBackups.splice(7);
      // M3: Actually delete pruned backups from R2
      for (const old of pruned) {
        if (s3Client) {
          try {
            const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
            await s3Client.send(new DeleteObjectCommand({
              Bucket: R2_BUCKET,
              Key: old.path,
            }));
            console.log(`🗑️  Deleted pruned backup from R2: ${old.path}`);
          } catch (err) {
            console.error(`🗑️  Failed to delete pruned backup from R2: ${old.path}`, err.message);
          }
        } else {
          console.log(`🗑️  [STUB] Would delete pruned backup: ${old.path}`);
        }
      }
      console.log(`🗑️  Pruned ${pruned.length} old backup(s) for ${userId.slice(0, 12)}`);
    }

    backupRegistry.set(userId, userBackups);
    persistBackupRegistry();

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
});

// ── GET /api/v1/chat/backup/list (auth required) ──

app.get('/api/v1/chat/backup/list', authMiddleware, (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    const backups = backupRegistry.get(userId) || [];

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

app.post('/api/v1/chat/backup/restore', authMiddleware, async (req, res) => {
  try {
    const { userId, backupId } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    if (!backupId || typeof backupId !== 'string' || backupId.length > 255) {
      return res.status(400).json({ error: 'backupId is required, max 255 characters' });
    }

    const userBackups = backupRegistry.get(userId) || [];
    const backup = userBackups.find(b => b.id === backupId);

    if (!backup) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    let encryptedData;

    if (s3Client) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const response = await s3Client.send(new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: backup.path,
      }));
      const chunks = [];
      for await (const chunk of response.Body) chunks.push(chunk);
      encryptedData = Buffer.concat(chunks).toString('base64');
    } else {
      console.log(`☁️  [STUB] Restore: ${backup.path}`);
      encryptedData = null;
    }

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
});

// ── DELETE /api/v1/chat/backup/delete (auth required) ──

app.delete('/api/v1/chat/backup/delete', authMiddleware, async (req, res) => {
  try {
    const { userId, backupId } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    if (!backupId || typeof backupId !== 'string' || backupId.length > 255) {
      return res.status(400).json({ error: 'backupId is required, max 255 characters' });
    }

    const userBackups = backupRegistry.get(userId) || [];
    const idx = userBackups.findIndex(b => b.id === backupId);

    if (idx === -1) return res.status(404).json({ error: 'Backup not found' });

    const removed = userBackups.splice(idx, 1)[0];
    backupRegistry.set(userId, userBackups);
    persistBackupRegistry();

    // M3: Actually delete from R2
    if (s3Client) {
      try {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        await s3Client.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET,
          Key: removed.path,
        }));
        console.log(`🗑️  Deleted backup from R2: ${removed.path}`);
      } catch (err) {
        console.error(`🗑️  Failed to delete backup from R2: ${removed.path}`, err.message);
      }
    } else {
      console.log(`🗑️  [STUB] Would delete backup: ${removed.path}`);
    }

    res.json({ success: true, deleted: removed.id });
  } catch (err) {
    console.error('Backup delete error:', err);
    res.status(500).json({ error: 'Failed to delete backup' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Start ──
initR2();
app.listen(PORT, () => {
  console.log(`🌪️  Windy Chat Backup — listening on port ${PORT}`);
  console.log(`   R2: ${s3Client ? 'active' : 'stubbed'}`);
});

module.exports = { app, encryptBackup, decryptBackup };
