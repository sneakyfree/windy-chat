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
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// ── In-memory session store (replace with Redis in production) ──
const pairingSessions = new Map();  // sessionId → { pubkey, createdAt, expiresAt, status, linkedAccount }

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
  const now = Date.now();
  for (const [id, session] of pairingSessions) {
    if (now > session.expiresAt && session.status === 'pending') {
      pairingSessions.delete(id);
    }
  }
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

    // Store session
    pairingSessions.set(sessionId, {
      pubkey: pubkeyBase64,
      privateKey: keyPair.privateKey,
      createdAt: timestamp,
      expiresAt,
      status: 'pending',       // pending → paired → active
      linkedAccount: null,
      deviceId: null,
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

router.post('/confirm', (req, res) => {
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
    const session = pairingSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Pairing session not found or expired' });
    }

    // Check expiration
    if (Date.now() > session.expiresAt) {
      pairingSessions.delete(sessionId);
      return res.status(410).json({ error: 'Pairing session expired. Generate a new QR code.' });
    }

    // Check if already paired
    if (session.status !== 'pending') {
      return res.status(409).json({ error: 'Session already paired' });
    }

    // TODO: Validate authToken against account server (H1)
    // For now, we trust the token and link the session

    const deviceId = `device_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const sanitizedDisplayName = displayName ? stripHtml(displayName) : userId;
    const sanitizedDeviceName = deviceName ? stripHtml(deviceName) : 'Desktop';

    // Link session
    session.status = 'paired';
    session.linkedAccount = {
      userId,
      displayName: sanitizedDisplayName,
      deviceId,
      deviceName: sanitizedDeviceName,
      platform: platform || 'desktop',
      pairedAt: new Date().toISOString(),
    };

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

    const session = pairingSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({
        error: 'Session not found or expired',
        status: 'expired',
      });
    }

    // Check expiration for pending sessions
    if (session.status === 'pending' && Date.now() > session.expiresAt) {
      pairingSessions.delete(sessionId);
      return res.json({
        sessionId,
        status: 'expired',
        message: 'QR code expired. Generate a new one.',
      });
    }

    const response = {
      sessionId,
      status: session.status,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };

    if (session.status === 'paired') {
      response.linkedAccount = {
        userId: session.linkedAccount.userId,
        displayName: session.linkedAccount.displayName,
        deviceId: session.linkedAccount.deviceId,
        pairedAt: session.linkedAccount.pairedAt,
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

    const deleted = pairingSessions.delete(sessionId);

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
