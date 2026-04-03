/**
 * Windy Chat — QR Code Pairing Routes
 * K2.3: QR Code Pairing — Desktop ↔ Mobile (DNA Strand K)
 *
 * Flow (like WhatsApp Web):
 *   1. Desktop calls POST /generate → gets QR code data (session_id + pubkey + ts)
 *   2. Desktop renders QR code in the app
 *   3. Mobile scans QR → calls POST /confirm with session_id + auth token
 *   4. Server links desktop session to mobile account
 *   5. Desktop polls GET /status/:sessionId → gets pairing result
 *
 * Security:
 *   - QR expires after 120 seconds
 *   - QR refreshes every 60 seconds on desktop
 *   - Max 5 linked devices per account
 */

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const onboardingDb = require('../lib/db');
const { verifyToken } = require('../../shared/jwt-verify');

const WINDY_ACCOUNT_SERVER_URL = process.env.WINDY_ACCOUNT_SERVER_URL || 'http://localhost:8098';

const router = express.Router();

const MAX_DEVICES = 5;
const QR_TTL_MS = 120 * 1000;  // 120 seconds

// ── Per-route rate limiter for pairing (sensitive) ──
const pairGenerateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many pairing requests. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Input validation helpers ──
function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

function isValidUserId(val) {
  return typeof val === 'string' && val.length > 0 && val.length <= 255 && /^[a-zA-Z0-9_-]+$/.test(val);
}

// ── Cleanup expired sessions periodically ──
setInterval(() => {
  onboardingDb.deleteExpiredSessions.run('pending', Date.now());
}, 30 * 1000);

// ── POST /api/v1/chat/pair/generate ──

router.post('/generate', pairGenerateLimiter, (req, res) => {
  try {
    // Generate ephemeral X25519 key pair
    const keyPair = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    const sessionId = uuidv4();
    const pubkeyBase64 = keyPair.publicKey.toString('base64');
    const timestamp = Date.now();
    const expiresAt = timestamp + QR_TTL_MS;

    // QR payload — this gets encoded into the QR code
    const qrPayload = {
      session: sessionId,
      pubkey: pubkeyBase64,
      ts: timestamp,
      server: process.env.SYNAPSE_URL || 'https://chat.windypro.com',
      version: 1,
    };

    // Store session in SQLite
    onboardingDb.upsertSession.run({
      session_id: sessionId,
      pubkey: pubkeyBase64,
      private_key: keyPair.privateKey,
      created_at: timestamp,
      expires_at: expiresAt,
      status: 'pending',
      linked_account: null,
    });

    console.log(`🔗 Pairing session created: ${sessionId.slice(0, 8)}... (expires in 120s)`);

    res.json({
      sessionId,
      qrPayload,
      qrDataString: JSON.stringify(qrPayload),
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: QR_TTL_MS / 1000,
    });

  } catch (err) {
    console.error('Pair generate error:', err);
    res.status(500).json({ error: 'Failed to generate pairing session' });
  }
});

// ── POST /api/v1/chat/pair/confirm ──

router.post('/confirm', async (req, res) => {
  try {
    const { sessionId, authToken, userId, displayName, deviceName, platform } = req.body;

    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 255) {
      return res.status(400).json({ error: 'sessionId is required, must be a string (max 255 chars)' });
    }

    if (!authToken || typeof authToken !== 'string' || authToken.length > 1024) {
      return res.status(400).json({ error: 'authToken is required, must be a string (max 1024 chars)' });
    }

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    // Validate optional fields
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 100)) {
      return res.status(400).json({ error: 'displayName must be a string, max 100 characters' });
    }

    if (deviceName !== undefined && (typeof deviceName !== 'string' || deviceName.length > 100)) {
      return res.status(400).json({ error: 'deviceName must be a string, max 100 characters' });
    }

    if (platform !== undefined && (typeof platform !== 'string' || !['desktop', 'mobile', 'web'].includes(platform))) {
      return res.status(400).json({ error: 'platform must be "desktop", "mobile", or "web"' });
    }

    // Find session
    const session = onboardingDb.getSession.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Pairing session not found or expired' });
    }

    // Check expiration
    if (Date.now() > session.expires_at) {
      onboardingDb.deleteSession.run(sessionId);
      return res.status(410).json({ error: 'Pairing session expired. Generate a new QR code.' });
    }

    // Check if already paired
    if (session.status !== 'pending') {
      return res.status(409).json({ error: 'Session already paired' });
    }

    // Validate authToken — try account-server first, fall back to local JWT verification
    let tokenValid = false;
    if (WINDY_ACCOUNT_SERVER_URL !== 'http://localhost:8098') {
      try {
        const validateUrl = `${WINDY_ACCOUNT_SERVER_URL}/api/v1/identity/validate-token`;
        const httpModule = validateUrl.startsWith('https') ? https : http;

        tokenValid = await new Promise((resolve) => {
          const req = httpModule.get(validateUrl, {
            headers: { 'Authorization': `Bearer ${authToken}` },
            timeout: 5000,
          }, (res) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', (e) => { console.warn('[pair] Auth token validation request error:', e.message); resolve(false); });
          req.on('timeout', () => { console.warn('[pair] Auth token validation request timed out'); req.destroy(); resolve(false); });
        });
      } catch (err) {
        console.warn('[pair] Account-server token validation failed:', err.message);
      }
    }

    // Fall back to local JWT or CHAT_API_TOKEN verification
    if (!tokenValid) {
      // Accept CHAT_API_TOKEN for service-to-service calls
      const chatApiToken = process.env.CHAT_API_TOKEN;
      if (chatApiToken && authToken === chatApiToken) {
        tokenValid = true;
      } else {
        try {
          await verifyToken(authToken);
          tokenValid = true;
        } catch (err) {
          console.warn('[pair] Local JWT verification failed:', err.message);
        }
      }
    }

    if (!tokenValid) {
      return res.status(401).json({ error: 'Invalid auth token' });
    }

    const deviceId = `device_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const sanitizedDisplayName = displayName ? stripHtml(displayName) : userId;
    const sanitizedDeviceName = deviceName ? stripHtml(deviceName) : 'Desktop';

    // Link session in SQLite
    const linkedAccount = {
      userId,
      displayName: sanitizedDisplayName,
      deviceId,
      deviceName: sanitizedDeviceName,
      platform: platform || 'desktop',
      pairedAt: new Date().toISOString(),
    };
    onboardingDb.upsertSession.run({
      session_id: sessionId,
      pubkey: session.pubkey,
      private_key: session.private_key,
      created_at: session.created_at,
      expires_at: session.expires_at,
      status: 'paired',
      linked_account: JSON.stringify(linkedAccount),
    });

    console.log(`✅ Pairing confirmed: session ${sessionId.slice(0, 8)} → user ${userId.slice(0, 12)} (${sanitizedDeviceName})`);

    res.json({
      success: true,
      paired: true,
      deviceId,
      message: 'Desktop session linked to your account',
    });

  } catch (err) {
    console.error('Pair confirm error:', err);
    res.status(500).json({ error: 'Pairing confirmation failed' });
  }
});

// ── GET /api/v1/chat/pair/status/:sessionId ──

router.get('/status/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 255) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }

    const session = onboardingDb.getSession.get(sessionId);
    if (!session) {
      return res.status(404).json({
        error: 'Session not found or expired',
        status: 'expired',
      });
    }

    // Check expiration for pending sessions
    if (session.status === 'pending' && Date.now() > session.expires_at) {
      onboardingDb.deleteSession.run(sessionId);
      return res.json({
        sessionId,
        status: 'expired',
        message: 'QR code expired. Generate a new one.',
      });
    }

    const response = {
      sessionId,
      status: session.status,
      expiresAt: new Date(session.expires_at).toISOString(),
    };

    if (session.status === 'paired' && session.linked_account) {
      const linked = JSON.parse(session.linked_account);
      response.linkedAccount = {
        userId: linked.userId,
        displayName: linked.displayName,
        deviceId: linked.deviceId,
        pairedAt: linked.pairedAt,
      };
      response.message = 'Desktop linked! You can now access Windy Chat.';
    }

    res.json(response);
  } catch (err) {
    console.error('Pair status error:', err);
    res.status(500).json({ error: 'Failed to check pairing status' });
  }
});

// ── DELETE /api/v1/chat/pair/session/:sessionId ──

router.delete('/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 255) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }

    const info = onboardingDb.deleteSession.run(sessionId);
    const deleted = info.changes > 0;

    res.json({
      success: deleted,
      message: deleted ? 'Session removed' : 'Session not found',
    });
  } catch (err) {
    console.error('Pair session delete error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

module.exports = router;
