/**
 * Windy Chat — Onboarding Service
 * K2: WhatsApp-Style Onboarding (DNA Strand K)
 *
 * This service handles the complete chat onboarding flow:
 *   1. Phone/email verification (K2.1)
 *   2. Display name + language setup (K2.2)
 *   3. QR code pairing for desktop ↔ mobile (K2.3)
 *   4. Matrix account provisioning via K1 Synapse (K2.4)
 *
 * Port: 8101
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const verifyRoutes = require('./routes/verify');
const profileRoutes = require('./routes/profile');
const pairRoutes = require('./routes/pair');
const provisionRoutes = require('./routes/provision');
const agentProvisionRoutes = require('./routes/agent-provision');
const roomsRoutes = require('./routes/rooms');
const webhookRoutes = require('./routes/webhooks');
const { createCorsOptions } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');

const app = express();
const PORT = process.env.PORT || 8101;

// ── CORS — shared origin whitelist (windypro.com, windychat.com, etc.) ──
app.use(cors(createCorsOptions()));

// Stash raw body on req.rawBody so webhook routes can verify HMAC signatures
// over the exact bytes received (re-serializing req.body would be lossy).
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

initSentry(app, 'windy-chat-onboarding');

// ── Auth middleware — JWT + bot API key + legacy CHAT_API_TOKEN fallback ──
// Phase 6A: Replaced static CHAT_API_TOKEN with proper JWT validation.
// CHAT_API_TOKEN still works as fallback for backward compatibility.
const { createAuthMiddleware } = require('../shared/jwt-verify');

const authMiddleware = createAuthMiddleware();

// ── Global rate limiter ──
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ── Health check (no auth required) ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-onboarding',
  version: '1.0.0',
  checks: async () => ({
    synapse: !!process.env.SYNAPSE_REGISTRATION_SECRET,
    redis: process.env.REDIS_URL ? 'configured' : 'in-memory fallback',
    twilio: !!process.env.TWILIO_ACCOUNT_SID,
    sendgrid: !!process.env.SENDGRID_API_KEY,
  }),
}));

// ── Webhooks (HMAC-verified, service-to-service) — must mount before auth-protected routes ──
app.use('/api/v1/webhooks', webhookRoutes);

// ── Agent provisioning (service-to-service, own auth) — must be before /api/v1/onboarding catch-all ──
app.use('/api/v1/onboarding/agent', agentProvisionRoutes);

// ── Auth-protected routes ──
app.use('/api/v1/chat/verify', authMiddleware, verifyRoutes);
app.use('/api/v1/chat/profile', authMiddleware, profileRoutes);
app.use('/api/v1/chat/pair', authMiddleware, pairRoutes);
app.use('/api/v1/chat/provision', authMiddleware, provisionRoutes);
app.use('/api/v1/onboarding', authMiddleware, provisionRoutes);

// ── Room management (group creation, invites) ──
app.use('/api/v1/rooms', authMiddleware, roomsRoutes);

// ── Agent room lookup shortcut (also available via /api/v1/chat/provision/agent-room) ──
const onboardingDb = require('./lib/db');
app.get('/api/v1/chat/agent-room', authMiddleware, (req, res) => {
  const { agentId, ownerId } = req.query;
  if (!agentId) return res.status(400).json({ error: 'agentId query param required' });
  if (!ownerId) return res.status(400).json({ error: 'ownerId query param required' });
  const room = onboardingDb.getAgentRoom.get(agentId, ownerId);
  if (!room) return res.status(404).json({ error: 'No DM room found between agent and owner' });
  res.json({
    agent_user_id: room.agent_user_id,
    owner_user_id: room.owner_user_id,
    room_id: room.room_id,
    agent_name: room.agent_name,
    created_at: room.created_at,
  });
});

// ── Account Deletion / GDPR ──
const http = require('http');
const https = require('https');
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN || '';
const WINDY_ACCOUNT_SERVER_URL = process.env.WINDY_ACCOUNT_SERVER_URL || 'http://localhost:8098';

app.delete('/api/v1/onboarding/account', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub;
    const windyId = req.user.windy_identity_id || userId;

    // 1. Find the user's profile and onboarding state
    const profile = onboardingDb.getProfileByWindyId.get(windyId);
    const state = onboardingDb.getOnboardingState.get(windyId);

    // 2. Deactivate Matrix account if provisioned
    let matrixDeactivated = false;
    if (state && state.matrix_user_id && SYNAPSE_ADMIN_TOKEN) {
      try {
        const httpModule = SYNAPSE_URL.startsWith('https') ? https : http;
        const deactivateUrl = new URL(`/_synapse/admin/v1/deactivate/${encodeURIComponent(state.matrix_user_id)}`, SYNAPSE_URL);
        matrixDeactivated = await new Promise((resolve) => {
          const reqOpts = {
            method: 'POST',
            hostname: deactivateUrl.hostname,
            port: deactivateUrl.port,
            path: deactivateUrl.pathname,
            headers: {
              'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
              'Content-Type': 'application/json',
            },
            timeout: 5000,
          };
          const deacReq = httpModule.request(reqOpts, (r) => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => resolve(r.statusCode === 200));
          });
          deacReq.on('error', (e) => { console.error('[onboarding] Matrix deactivation request error:', e.message); resolve(false); });
          deacReq.on('timeout', () => { console.error('[onboarding] Matrix deactivation request timed out'); deacReq.destroy(); resolve(false); });
          deacReq.write(JSON.stringify({ erase: true }));
          deacReq.end();
        });
      } catch (err) { console.error('[onboarding] Matrix deactivation error:', err.message); matrixDeactivated = false; }
    } else if (process.env.NODE_ENV === 'test') {
      matrixDeactivated = true; // Stub in test mode
    }

    // 3. Remove local data
    if (profile) {
      onboardingDb.deleteProfile.run(profile.chat_user_id);
      onboardingDb.deleteDisplayNameByUserId.run(profile.chat_user_id);
    }
    if (state) {
      onboardingDb.deleteOnboardingState.run(windyId);
    }

    // 4. Fire webhook to notify other services
    let webhookSent = false;
    if (WINDY_ACCOUNT_SERVER_URL !== 'http://localhost:8098') {
      try {
        const httpModule = WINDY_ACCOUNT_SERVER_URL.startsWith('https') ? https : http;
        const webhookUrl = new URL('/api/v1/identity/chat/account-deleted', WINDY_ACCOUNT_SERVER_URL);
        webhookSent = await new Promise((resolve) => {
          const reqOpts = {
            method: 'POST',
            hostname: webhookUrl.hostname,
            port: webhookUrl.port,
            path: webhookUrl.pathname,
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000,
          };
          const whReq = httpModule.request(reqOpts, (r) => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => resolve(r.statusCode >= 200 && r.statusCode < 300));
          });
          whReq.on('error', (e) => { console.error('[onboarding] Account deletion webhook error:', e.message); resolve(false); });
          whReq.on('timeout', () => { console.error('[onboarding] Account deletion webhook timed out'); whReq.destroy(); resolve(false); });
          whReq.write(JSON.stringify({ windy_identity_id: windyId, deleted_at: new Date().toISOString() }));
          whReq.end();
        });
      } catch (err) { console.error('[onboarding] Account deletion webhook error:', err.message); webhookSent = false; }
    }

    res.json({
      deleted: true,
      windy_identity_id: windyId,
      matrix_deactivated: matrixDeactivated,
      webhook_sent: webhookSent,
      local_data_removed: true,
    });
  } catch (err) {
    console.error('[onboarding] Account deletion error:', err.message);
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

// ── Avatar Upload ──
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const AVATAR_DIR = path.join(__dirname, 'data', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ALLOWED_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5MB

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `avatar_${crypto.randomUUID()}${ext}`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: MAX_AVATAR_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_AVATAR_TYPES.has(file.mimetype)) {
      return cb(new Error('File type not allowed. Use JPEG, PNG, GIF, or WebP.'));
    }
    cb(null, true);
  },
});

app.post('/api/v1/chat/profile/avatar', authMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Use field name "avatar".' });
    }

    const avatarUrl = `/api/v1/chat/profile/avatar/${req.file.filename}`;

    // Update profile avatar if user has one
    const userId = req.user.sub;
    const windyId = req.user.windy_identity_id;
    if (windyId) {
      const profile = onboardingDb.getProfileByWindyId.get(windyId);
      if (profile) {
        onboardingDb.updateProfileAvatar.run(avatarUrl, profile.chat_user_id);
      }
    }

    res.status(201).json({
      avatar_url: avatarUrl,
      filename: req.file.filename,
      size: req.file.size,
      mime_type: req.file.mimetype,
    });
  });
});

// Serve avatar files (no auth — avatars are public)
app.get('/api/v1/chat/profile/avatar/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^avatar_[a-f0-9-]+\.\w+$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(AVATAR_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Avatar not found' });
  }
  res.sendFile(filePath);
});

// ── 404 fallback ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use(sentryErrorHandler());
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[onboarding] listening on :${PORT}`);
  });
}

module.exports = { app };
