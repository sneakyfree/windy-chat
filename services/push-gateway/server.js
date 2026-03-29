/**
 * Windy Chat — Push Notification Gateway
 * K6: Push Notifications (DNA Strand K)
 *
 * Matrix push gateway that receives events from Synapse and forwards
 * to FCM (Android) and APNs (iOS).
 *
 * K6.1 Matrix Push Gateway (receives POST /_matrix/push/v1/notify)
 * K6.2 Firebase Cloud Messaging (Android)
 * K6.3 Apple Push Notification Service (iOS)
 * K6.4 Per-conversation mute
 *
 * Port: 8103
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8103;

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
// NOTE: The Matrix push endpoint (/_matrix/push/v1/notify) is server-to-server
// from Synapse and does NOT use this middleware.
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
  max: 100,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ── Input validation helpers ──

function isValidUserId(val) {
  return typeof val === 'string' && val.length > 0 && val.length <= 255 && /^[a-zA-Z0-9_@:.\-]+$/.test(val);
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

// ── In-memory stores with file-based persistence (M1) ──
const pushTokens = new Map();  // pushkey → { userId, platform, appId, token, deviceName }
const muteSettings = new Map();  // `${userId}:${roomId}` → { mutedUntil, mentionOverride }

const PUSH_DATA_DIR = path.join(__dirname, 'data');
const PUSH_TOKENS_FILE = path.join(PUSH_DATA_DIR, 'push-tokens.json');

function loadPushData() {
  try {
    if (fs.existsSync(PUSH_TOKENS_FILE)) {
      const raw = fs.readFileSync(PUSH_TOKENS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.pushTokens && typeof data.pushTokens === 'object') {
        for (const [key, value] of Object.entries(data.pushTokens)) {
          pushTokens.set(key, value);
        }
      }
      if (data.muteSettings && typeof data.muteSettings === 'object') {
        for (const [key, value] of Object.entries(data.muteSettings)) {
          muteSettings.set(key, value);
        }
      }
      console.log(`[Push] Loaded ${pushTokens.size} push tokens, ${muteSettings.size} mute settings from disk`);
    }
  } catch (err) {
    console.error('[Push] Failed to load persisted data:', err.message);
  }
}

function persistPushData() {
  try {
    if (!fs.existsSync(PUSH_DATA_DIR)) {
      fs.mkdirSync(PUSH_DATA_DIR, { recursive: true });
    }
    const data = {
      pushTokens: Object.fromEntries(pushTokens),
      muteSettings: Object.fromEntries(muteSettings),
    };
    fs.writeFileSync(PUSH_TOKENS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Push] Failed to persist data:', err.message);
  }
}

// Load persisted data on startup
loadPushData();

// ── FCM / APNs setup ──

let fcmApp = null;
let apnProvider = null;

function initFCM() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountPath) {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — FCM pushes will be stubbed');
    return;
  }
  try {
    const admin = require('firebase-admin');
    const serviceAccount = require(serviceAccountPath);
    fcmApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('🔥 FCM initialized');
  } catch (err) {
    console.error('FCM init error:', err.message);
  }
}

function initAPNs() {
  const keyPath = process.env.APNS_KEY_PATH;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;

  if (!keyPath || !keyId || !teamId) {
    console.warn('⚠️  APNs not configured — iOS pushes will be stubbed');
    return;
  }
  try {
    const apn = require('apn');
    apnProvider = new apn.Provider({
      token: { key: keyPath, keyId, teamId },
      production: process.env.NODE_ENV === 'production',
    });
    console.log('🍎 APNs initialized');
  } catch (err) {
    console.error('APNs init error:', err.message);
  }
}

// ── K6.1: Matrix Push Gateway endpoint ──
// Synapse sends POST /_matrix/push/v1/notify with notification payload
// NOTE: This endpoint is called by Synapse server-to-server, not by clients.
// Auth is NOT applied here — Synapse authenticates via its own mechanism.

app.post('/_matrix/push/v1/notify', async (req, res) => {
  try {
    const { notification } = req.body;

    if (!notification || typeof notification !== 'object') {
      return res.status(400).json({ rejected: [] });
    }

    const {
      room_id,
      event_id,
      sender,
      sender_display_name,
      type,
      prio,
      devices,
      counts,
    } = notification;

    // Validate devices array
    if (devices !== undefined && !Array.isArray(devices)) {
      return res.status(400).json({ rejected: [] });
    }

    const rejected = [];

    for (const device of (devices || [])) {
      if (!device || typeof device !== 'object') continue;
      const { pushkey, app_id } = device;

      if (!pushkey || typeof pushkey !== 'string') continue;

      // Check mute settings
      const tokenEntry = pushTokens.get(pushkey);
      if (tokenEntry) {
        const muteKey = `${tokenEntry.userId}:${room_id}`;
        const mute = muteSettings.get(muteKey);
        if (mute && mute.mutedUntil > Date.now()) {
          // Check mention override
          const isMention = type === 'm.room.message' && notification.content?.body?.includes('@');
          if (!mute.mentionOverride || !isMention) {
            continue; // Skip — muted
          }
        }
      }

      // K6.1.3: Privacy — strip message content
      const title = sender_display_name || sender || 'Windy Chat';
      const body = 'New message'; // Never leak content in notification
      const badge = counts?.unread || 0;

      // Route to FCM or APNs based on pushkey/app_id
      const platform = tokenEntry?.platform || (app_id?.includes('ios') ? 'ios' : 'android');

      if (platform === 'ios') {
        const result = await sendAPNs(pushkey, { title, body, badge, roomId: room_id, eventId: event_id });
        if (!result.success) rejected.push(pushkey);
      } else {
        const result = await sendFCM(pushkey, { title, body, badge, roomId: room_id, eventId: event_id });
        if (!result.success) rejected.push(pushkey);
      }
    }

    // Matrix spec: return { rejected: [...pushkeys that failed] }
    res.json({ rejected });

  } catch (err) {
    console.error('Push notify error:', err);
    res.status(500).json({ rejected: [] });
  }
});

// ── K6.2: FCM (Android) ──

async function sendFCM(pushkey, payload) {
  if (!fcmApp) {
    console.log(`📱 [STUB] FCM → ${pushkey.slice(0, 12)}...: ${payload.title} — ${payload.body}`);
    return { success: true, stub: true };
  }

  try {
    const admin = require('firebase-admin');
    const message = {
      token: pushkey,
      data: {
        room_id: payload.roomId || '',
        event_id: payload.eventId || '',
        type: 'chat_message',
      },
      notification: {
        title: payload.title,
        body: payload.body,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'chat_messages',
          sound: 'default',
          defaultVibrateTimings: true,
          notificationCount: payload.badge,
        },
      },
    };

    await admin.messaging().send(message);
    console.log(`📱 FCM sent to ${pushkey.slice(0, 12)}...`);
    return { success: true };
  } catch (err) {
    console.error('FCM send error:', err.message);
    return { success: false, error: 'FCM delivery failed' };
  }
}

// ── K6.3: APNs (iOS) ──

async function sendAPNs(pushkey, payload) {
  if (!apnProvider) {
    console.log(`🍎 [STUB] APNs → ${pushkey.slice(0, 12)}...: ${payload.title} — ${payload.body}`);
    return { success: true, stub: true };
  }

  try {
    const apn = require('apn');
    const note = new apn.Notification();
    note.alert = { title: payload.title, body: payload.body };
    note.badge = payload.badge;
    note.sound = 'default';
    note.topic = process.env.APNS_BUNDLE_ID || 'com.windypro.chat';
    note.payload = { room_id: payload.roomId, event_id: payload.eventId };
    note.pushType = 'alert';
    note.priority = 10;

    const result = await apnProvider.send(note, pushkey);
    if (result.failed.length > 0) {
      return { success: false, error: 'APNs delivery failed' };
    }
    console.log(`🍎 APNs sent to ${pushkey.slice(0, 12)}...`);
    return { success: true };
  } catch (err) {
    console.error('APNs send error:', err.message);
    return { success: false, error: 'APNs delivery failed' };
  }
}

// ── Push token registration (auth required) ──

const pushRegisterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many push registration attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/v1/chat/push/register', pushRegisterLimiter, authMiddleware, (req, res) => {
  try {
    const { pushkey, userId, platform, appId, deviceName } = req.body;

    if (!pushkey || typeof pushkey !== 'string' || pushkey.length > 1024) {
      return res.status(400).json({ error: 'pushkey is required, max 1024 characters' });
    }

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, max 255 characters, alphanumeric + hyphens' });
    }

    if (!platform || typeof platform !== 'string' || !['android', 'ios', 'web'].includes(platform)) {
      return res.status(400).json({ error: 'platform is required, must be "android", "ios", or "web"' });
    }

    // Validate optional fields
    if (appId !== undefined && (typeof appId !== 'string' || appId.length > 255)) {
      return res.status(400).json({ error: 'appId must be a string, max 255 characters' });
    }

    if (deviceName !== undefined && (typeof deviceName !== 'string' || deviceName.length > 100)) {
      return res.status(400).json({ error: 'deviceName must be a string, max 100 characters' });
    }

    const sanitizedDeviceName = deviceName ? stripHtml(deviceName) : 'Unknown';

    pushTokens.set(pushkey, {
      userId,
      platform,
      appId: appId || `com.windypro.chat.${platform}`,
      deviceName: sanitizedDeviceName,
      registeredAt: Date.now(),
    });
    persistPushData();

    console.log(`🔔 Push token registered: ${platform} for ${userId.slice(0, 12)}`);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Push register error:', err);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

// ── K6.4: Per-conversation mute (auth required) ──

app.post('/api/v1/chat/push/mute', authMiddleware, (req, res) => {
  try {
    const { userId, roomId, duration, mentionOverride } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, max 255 characters, alphanumeric + hyphens' });
    }

    if (!roomId || typeof roomId !== 'string' || roomId.length > 255) {
      return res.status(400).json({ error: 'roomId is required, max 255 characters' });
    }

    if (duration !== undefined && typeof duration !== 'string') {
      return res.status(400).json({ error: 'duration must be a string' });
    }

    const durations = {
      '1h': 60 * 60 * 1000,
      '8h': 8 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
      '1w': 7 * 24 * 60 * 60 * 1000,
      'forever': 100 * 365 * 24 * 60 * 60 * 1000,
    };

    const ms = durations[duration] || durations['1h'];
    const muteKey = `${userId}:${roomId}`;

    muteSettings.set(muteKey, {
      mutedUntil: Date.now() + ms,
      mentionOverride: mentionOverride !== false,
    });
    persistPushData();

    res.json({ success: true, mutedUntil: new Date(Date.now() + ms).toISOString() });
  } catch (err) {
    console.error('Mute error:', err);
    res.status(500).json({ error: 'Failed to mute conversation' });
  }
});

app.post('/api/v1/chat/push/unmute', authMiddleware, (req, res) => {
  try {
    const { userId, roomId } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, max 255 characters' });
    }

    if (!roomId || typeof roomId !== 'string' || roomId.length > 255) {
      return res.status(400).json({ error: 'roomId is required, max 255 characters' });
    }

    muteSettings.delete(`${userId}:${roomId}`);
    persistPushData();
    res.json({ success: true });
  } catch (err) {
    console.error('Unmute error:', err);
    res.status(500).json({ error: 'Failed to unmute conversation' });
  }
});

// ── Health check (no auth required) ──
app.get('/health', (_req, res) => {
  res.json({
    service: 'windy-chat-push-gateway',
    status: 'ok',
    version: '1.0.0',
    fcm: !!fcmApp,
    apns: !!apnProvider,
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──
initFCM();
initAPNs();

app.listen(PORT, () => {
  console.log(`🌪️  Windy Chat Push Gateway — listening on port ${PORT}`);
  console.log(`   Push: POST /_matrix/push/v1/notify`);
  console.log(`   FCM: ${fcmApp ? 'active' : 'stubbed'}`);
  console.log(`   APNs: ${apnProvider ? 'active' : 'stubbed'}`);
});

module.exports = app;
