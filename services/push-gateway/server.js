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

const { createCorsOptions } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { asyncHandler } = require('../shared/async-handler');
const pushDb = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 8103;

// ── CORS — shared origin whitelist (windypro.com, windychat.com, etc.) ──
app.use(cors(createCorsOptions()));

app.use(express.json({ limit: '1mb' }));

// ── Auth middleware — JWT + bot API key + legacy CHAT_API_TOKEN fallback ──
// Phase 6A: Replaced static CHAT_API_TOKEN with proper JWT validation.
// CHAT_API_TOKEN still works as fallback for backward compatibility.
// NOTE: The Matrix push endpoint (/_matrix/push/v1/notify) is server-to-server
// from Synapse and does NOT use this middleware.
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

// ── Input validation helpers ──

function isValidUserId(val) {
  return typeof val === 'string' && val.length > 0 && val.length <= 255 && /^[a-zA-Z0-9_@:.\-]+$/.test(val);
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

// ── SQLite-backed persistence (via ./lib/db) ──

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

app.post('/_matrix/push/v1/notify', asyncHandler(async (req, res) => {
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
      const tokenRow = pushDb.getToken.get(pushkey);
      const tokenEntry = tokenRow ? { userId: tokenRow.user_id, platform: tokenRow.platform, appId: tokenRow.app_id, deviceName: tokenRow.device_name } : null;
      if (tokenEntry) {
        const muteRow = pushDb.getMute.get(tokenEntry.userId, room_id);
        const mute = muteRow ? { mutedUntil: muteRow.muted_until, mentionOverride: !!muteRow.mention_override } : null;
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

      // Route to FCM, APNs, or Web Push based on platform
      const platform = tokenEntry?.platform || (app_id?.includes('ios') ? 'ios' : 'android');
      const pushPayload = { title, body, badge, roomId: room_id, eventId: event_id };

      let result;
      if (platform === 'web') {
        result = await sendWebPush(pushkey, pushPayload);
      } else if (platform === 'ios') {
        result = await sendAPNs(pushkey, pushPayload);
      } else {
        result = await sendFCM(pushkey, pushPayload);
      }

      if (!result.success) {
        rejected.push(pushkey);
      } else {
        pushDb.touchToken.run(Date.now(), pushkey);
      }
    }

    // Matrix spec: return { rejected: [...pushkeys that failed] }
    res.json({ rejected });

  } catch (err) {
    console.error('Push notify error:', err);
    res.status(500).json({ rejected: [] });
  }
}));

// ── K6.2: FCM (Android) ──

async function sendFCM(pushkey, payload) {
  if (!fcmApp) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[push] FCM not configured — FIREBASE_SERVICE_ACCOUNT required in production');
      return { success: false, error: 'FCM not configured' };
    }
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
    if (process.env.NODE_ENV === 'production') {
      console.error('[push] APNs not configured — APNS_KEY_PATH required in production');
      return { success: false, error: 'APNs not configured' };
    }
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

// ── K6.5: Web Push (VAPID) ──

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@windychat.com';

let webPushReady = false;

function initWebPush() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('⚠️  VAPID keys not configured — Web Push will be stubbed');
    return;
  }
  try {
    const webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    webPushReady = true;
    console.log('🌐 Web Push (VAPID) initialized');
  } catch (err) {
    console.error('Web Push init error:', err.message);
  }
}

async function sendWebPush(pushkey, payload) {
  if (!webPushReady) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[push] Web Push not configured — VAPID keys required in production');
      return { success: false, error: 'Web Push not configured' };
    }
    console.log(`🌐 [STUB] Web Push → ${pushkey.slice(0, 30)}...: ${payload.title} — ${payload.body}`);
    return { success: true, stub: true };
  }

  try {
    const webpush = require('web-push');
    const subscription = JSON.parse(pushkey);
    await webpush.sendNotification(subscription, JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.roomId || 'windy-chat',
      data: { room_id: payload.roomId, event_id: payload.eventId, url: '/' },
    }));
    console.log(`🌐 Web Push sent to subscription`);
    return { success: true };
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired — mark for cleanup
      console.log(`🌐 Web Push subscription expired, removing`);
      pushDb.db.prepare('DELETE FROM push_tokens WHERE pushkey = ?').run(pushkey);
      return { success: false, error: 'subscription_expired' };
    }
    console.error('Web Push send error:', err.message);
    return { success: false, error: 'Web Push delivery failed' };
  }
}

// ── GET /api/v1/chat/push/vapid-key — public VAPID key for client subscription ──

app.get('/api/v1/chat/push/vapid-key', (_req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Web Push not configured' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

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

    pushDb.upsertToken.run({
      pushkey,
      user_id: userId,
      platform,
      app_id: appId || `com.windypro.chat.${platform}`,
      device_name: sanitizedDeviceName,
      registered_at: Date.now(),
    });

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

    pushDb.upsertMute.run({
      user_id: userId,
      room_id: roomId,
      muted_until: Date.now() + ms,
      mention_override: mentionOverride !== false ? 1 : 0,
    });

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

    pushDb.deleteMute.run(userId, roomId);
    res.json({ success: true });
  } catch (err) {
    console.error('Unmute error:', err);
    res.status(500).json({ error: 'Failed to unmute conversation' });
  }
});

// ── Push token cleanup (auth required) ──

app.post('/api/v1/chat/push/prune', authMiddleware, (req, res) => {
  try {
    const pruned = pushDb.pruneTokens();
    console.log(`🧹 Manual prune: removed ${pruned} stale push token(s)`);
    res.json({ success: true, pruned });
  } catch (err) {
    console.error('Prune error:', err);
    res.status(500).json({ error: 'Failed to prune stale tokens' });
  }
});

// ── Health check (no auth required) ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-push-gateway',
  version: '1.0.0',
  checks: async () => ({
    fcm: fcmApp ? 'active' : 'stubbed',
    apns: apnProvider ? 'active' : 'stubbed',
    webPush: webPushReady ? 'active' : 'stubbed',
    registeredTokens: pushDb.tokenCount.get().cnt,
    activeMutes: pushDb.muteCount.get().cnt,
  }),
}));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Scheduled push token cleanup — every 24 hours ──

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function runScheduledCleanup() {
  try {
    const pruned = pushDb.pruneTokens();
    if (pruned > 0) {
      console.log(`🧹 Scheduled cleanup: removed ${pruned} stale push token(s)`);
    }
  } catch (err) {
    console.error('Scheduled cleanup error:', err);
  }
}

// ── Start ──
initFCM();
initAPNs();
initWebPush();

// Run cleanup on startup and schedule recurring
runScheduledCleanup();
setInterval(runScheduledCleanup, CLEANUP_INTERVAL_MS);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🌪️  Windy Chat Push Gateway — listening on port ${PORT}`);
    console.log(`   Push: POST /_matrix/push/v1/notify`);
    console.log(`   FCM: ${fcmApp ? 'active' : 'stubbed'}`);
    console.log(`   APNs: ${apnProvider ? 'active' : 'stubbed'}`);
    console.log(`   Token cleanup: every 24h (30-day stale threshold)`);
  });
}

module.exports = app;
