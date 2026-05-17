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
const rateLimit = require('express-rate-limit');

const { createCorsMiddleware } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { createVersionHandler } = require('../shared/version');
const { asyncHandler } = require('../shared/async-handler');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');
const { bodyErrorHandler } = require('../shared/body-errors');
const pushDb = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 8103;

// ── Trust the single reverse proxy in front (Caddy on the chat EC2).
// Without this, express-rate-limit's keyGenerator throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every rate-limited request
// because it sees the X-Forwarded-For header but Express's default
// trust-proxy=false flag tells it not to honor it. Result before this
// line: every POST /api/v1/chat/push/register returned 401 to the
// caller — the validator throws, the global error handler renders
// 401 "Invalid or expired token" with no log trace of the real cause.
// Caught 2026-05-08 morning during the post-overnight-merge smoke.
app.set('trust proxy', 1);

// ── CORS — shared allowlist with explicit 403 on disallowed origins
// (Wave 14; replaces throwing cors(createCorsOptions()) which 500'd).
app.use(createCorsMiddleware());

app.use(express.json({ limit: '1mb' }));

initSentry(app, 'windy-chat-push-gateway');

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

/**
 * Wave 12 H-1: block horizontal privilege escalation on push endpoints.
 *
 * Returns true iff the authenticated caller may act on behalf of `bodyUserId`:
 *   • service-to-service calls (CHAT_API_TOKEN → req.user.role === 'service')
 *     are allowed to target any user — this is how the account-server
 *     re-provisions push tokens server-side.
 *   • human callers must pass a userId matching their JWT identity claim
 *     (windy_identity_id preferred, sub as fallback).
 *
 * Before this gate any valid Pro JWT could register a pushkey under a
 * victim's account and hijack every notification fanned out for them —
 * see docs/HARDENING_REPORT.md H-1 for the full repro.
 */
function callerOwnsUserId(req, bodyUserId) {
  if (!req.user) return false;
  if (req.user.role === 'service') return true;
  const claim = req.user.windy_identity_id || req.user.sub;
  return typeof claim === 'string' && claim === bodyUserId;
}

// ── SQLite-backed persistence (via ./lib/db) ──

// ── FCM / APNs / Web Push providers ──
// As of feat/push-delivery-live-fcm-apns-webpush the actual SDK calls live
// in dedicated, unit-testable modules under ./lib/providers/. Server.js
// retains thin wrappers (sendFCM / sendAPNs / sendWebPush) that translate
// the provider modules' `{ ok, ... }` contract back into the legacy
// `{ success, ... }` shape that the Matrix push handler + routes/notify.js
// depend on. Don't break that wrapper contract without auditing both
// call sites.

const fcmProvider = require('./lib/providers/fcm');
const apnsProvider = require('./lib/providers/apns');
const webPushProvider = require('./lib/providers/web-push');

function initFCM() {
  const ok = fcmProvider.init();
  if (!ok) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — FCM pushes will be stubbed');
    } else {
      console.error('FCM init failed — check FIREBASE_SERVICE_ACCOUNT path / contents');
    }
    return;
  }
  console.log('🔥 FCM initialized');
}

function initAPNs() {
  const ok = apnsProvider.init();
  if (!ok) {
    const missing = !(process.env.APNS_KEY_PATH && process.env.APNS_KEY_ID
      && process.env.APNS_TEAM_ID && process.env.APNS_BUNDLE_ID);
    if (missing) {
      console.warn('⚠️  APNs not configured (need APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID) — iOS pushes will be stubbed');
    } else {
      console.error('APNs init failed — check that APNS_KEY_PATH is readable');
    }
    return;
  }
  console.log('🍎 APNs initialized');
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
//
// Wave 12 M-2: explicit event_type → Android notification channel map.
// Before this fix every non-`agent.hatched` event landed on the
// `chat_messages` channel — mail, cloud, passport, and fly notifications
// all rode the chat channel, so per-channel mutes and sounds were wrong
// for cross-service events fanned through the shared push bus.
//
// Clients (windy-pro-mobile, windy-pro desktop Web Push) must create
// these channels on first launch via NotificationManager.createNotificationChannel.
// Unknown / unspecified event types fall back to `chat_messages` — it's
// the safe default for legacy Synapse /_matrix/push/v1/notify events
// that have no `eventType` in the payload.
const FCM_CHANNEL_BY_EVENT = {
  'chat': 'chat_messages',
  'agent.hatched': 'agent_hatched',
  'agent': 'agent_updates',
  'fly': 'agent_updates',
  'mail': 'mail',
  'cloud': 'system',
  'passport': 'security',
  'eternitas': 'security',
};

function channelForEvent(eventType) {
  if (!eventType || typeof eventType !== 'string') return 'chat_messages';
  // Prefer exact match (e.g. `agent.hatched`), then family prefix
  // (e.g. `mail.inbound` → `mail`), then fall back to the chat channel.
  if (FCM_CHANNEL_BY_EVENT[eventType]) return FCM_CHANNEL_BY_EVENT[eventType];
  const family = eventType.split('.')[0];
  return FCM_CHANNEL_BY_EVENT[family] || 'chat_messages';
}

async function sendFCM(pushkey, payload) {
  if (!fcmProvider.isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[push] FCM not configured — FIREBASE_SERVICE_ACCOUNT required in production');
      return { success: false, error: 'FCM not configured' };
    }
    console.log(`📱 [STUB] FCM → ${pushkey.slice(0, 12)}...: ${payload.title} — ${payload.body}`);
    return { success: true, stub: true };
  }

  const result = await fcmProvider.send(pushkey, payload, {
    channelId: channelForEvent(payload.eventType),
  });
  if (result.ok) {
    console.log(`📱 FCM sent to ${pushkey.slice(0, 12)}...`);
    return { success: true, messageId: result.messageId };
  }
  console.error('FCM send error:', result.error);
  return { success: false, error: result.error || 'FCM delivery failed' };
}

// ── K6.3: APNs (iOS) ──

async function sendAPNs(pushkey, payload) {
  if (!apnsProvider.isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[push] APNs not configured — APNS_KEY_PATH required in production');
      return { success: false, error: 'APNs not configured' };
    }
    console.log(`🍎 [STUB] APNs → ${pushkey.slice(0, 12)}...: ${payload.title} — ${payload.body}`);
    return { success: true, stub: true };
  }

  const result = await apnsProvider.send(pushkey, payload);
  if (result.ok) {
    console.log(`🍎 APNs sent to ${pushkey.slice(0, 12)}...`);
    return { success: true, messageId: result.messageId };
  }
  console.error('APNs send error:', result.error);
  return { success: false, error: result.error || 'APNs delivery failed' };
}

// ── K6.5: Web Push (VAPID) ──

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';

function initWebPush() {
  const ok = webPushProvider.init();
  if (!ok) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      console.warn('⚠️  VAPID keys not configured — Web Push will be stubbed');
    } else {
      console.error('Web Push init failed — check web-push package + VAPID key format');
    }
    return;
  }
  console.log('🌐 Web Push (VAPID) initialized');
}

async function sendWebPush(pushkey, payload) {
  if (!webPushProvider.isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[push] Web Push not configured — VAPID keys required in production');
      return { success: false, error: 'Web Push not configured' };
    }
    console.log(`🌐 [STUB] Web Push → ${pushkey.slice(0, 30)}...: ${payload.title} — ${payload.body}`);
    return { success: true, stub: true };
  }

  const result = await webPushProvider.send(pushkey, payload);
  if (result.ok) {
    console.log(`🌐 Web Push sent to subscription`);
    return { success: true };
  }
  if (result.expired) {
    // 404 / 410 from the push service → endpoint is dead. The provider module
    // is intentionally DB-agnostic; we do the cleanup here so all server-side
    // state-mutation stays in server.js.
    console.log(`🌐 Web Push subscription expired, removing`);
    try {
      pushDb.db.prepare('DELETE FROM push_tokens WHERE pushkey = ?').run(pushkey);
    } catch (dbErr) {
      console.error('Failed to delete expired subscription:', dbErr.message);
    }
    return { success: false, error: 'subscription_expired' };
  }
  console.error('Web Push send error:', result.error);
  return { success: false, error: result.error || 'Web Push delivery failed' };
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

    if (!callerOwnsUserId(req, userId)) {
      return res.status(403).json({
        error: 'forbidden',
        detail: 'userId must match authenticated user',
      });
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
      // Fallback bundle ID is informational only (not used for routing —
      // APNs topic comes from APNS_BUNDLE_ID env). Default reflects the
      // canonical Windy Pro bundle (`uk.thewindstorm.windypro`) per the
      // Apple Developer App ID registration — was `com.windypro.chat`,
      // a brand-split-era artifact that never matched any real client.
      app_id: appId || 'uk.thewindstorm.windypro',
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

    if (!callerOwnsUserId(req, userId)) {
      return res.status(403).json({
        error: 'forbidden',
        detail: 'userId must match authenticated user',
      });
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

    if (!callerOwnsUserId(req, userId)) {
      return res.status(403).json({
        error: 'forbidden',
        detail: 'userId must match authenticated user',
      });
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

// ── Test push (admin-only, for verifying credentials) ──

app.post('/api/v1/chat/push/test', authMiddleware, asyncHandler(async (req, res) => {
  const { pushkey, platform, title, body } = req.body;

  if (!pushkey || typeof pushkey !== 'string') {
    return res.status(400).json({ error: 'pushkey is required' });
  }
  if (!platform || !['android', 'ios', 'web'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be android, ios, or web' });
  }

  // Wave 12 M-1: constrain test pushes to pushkeys owned by the caller.
  // Before this gate any valid JWT could trigger a send to any
  // registered pushkey — turning the diagnostic into an outbound-spam
  // channel + token-validity oracle. Service callers are exempt so
  // ops tools can still exercise arbitrary tokens.
  if (req.user?.role !== 'service') {
    const row = pushDb.getToken.get(pushkey);
    const claim = req.user?.windy_identity_id || req.user?.sub;
    if (!row || row.user_id !== claim) {
      return res.status(403).json({
        error: 'forbidden',
        detail: 'pushkey must be registered to authenticated user',
      });
    }
    if (row.platform !== platform) {
      return res.status(400).json({
        error: 'platform mismatch',
        detail: `pushkey is registered as ${row.platform}`,
      });
    }
  }

  const payload = {
    title: title || 'Windy Chat Test',
    body: body || 'Test notification — push is working!',
    roomId: 'test',
    eventId: 'test',
    badge: 1,
  };

  let result;
  if (platform === 'web') {
    result = await sendWebPush(pushkey, payload);
  } else if (platform === 'ios') {
    result = await sendAPNs(pushkey, payload);
  } else {
    result = await sendFCM(pushkey, payload);
  }

  if (result.success) {
    res.json({ success: true, platform, stub: result.stub || false });
  } else {
    res.status(502).json({ success: false, platform, error: result.error });
  }
}));

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
// Status vocabulary per provider:
//   'unconfigured' — env vars missing OR init failed (e.g. service-account JSON unreadable)
//   'ok'           — configured and either no sends yet or the last send succeeded
//   'failed'       — configured but the most recent send threw / rejected
// This is the contract the layer-1 audit asked for — clearer than the old
// binary 'active' / 'stubbed' which couldn't distinguish "we have keys but
// the SDK is throwing on every send" from "no keys at all".
app.get('/health', createHealthHandler({
  service: 'windy-chat-push-gateway',
  version: '1.0.0',
  checks: async () => ({
    fcm: fcmProvider.status(),
    apns: apnsProvider.status(),
    webPush: webPushProvider.status(),
    registeredTokens: pushDb.tokenCount.get().cnt,
    activeMutes: pushDb.muteCount.get().cnt,
  }),
}));

// ── MF1: /version (deployment identity, no auth, no DB) ──
app.get('/version', createVersionHandler({
  service: 'windy-chat-push-gateway',
  version: '1.0.0',
}));

// ── Digest & engagement notifications ──
const digestRoutes = require('./routes/digest');
app.use('/api/v1/chat/push/digest', authMiddleware, digestRoutes);
app.use('/api/v1/chat/push', authMiddleware, digestRoutes); // notify-owner at /api/v1/chat/push/notify-owner

// ── Shared notification bus (cross-service publish endpoint) ──
// Mail/Chat-homeserver/Clone/Fly/Code POST here with a windy_identity_id
// and the gateway fans out to every device the user has registered.
// Auth: X-Push-Bus-Token header (service-to-service).
app.locals.transports = { sendFCM, sendAPNs, sendWebPush };
const notifyRoutes = require('./routes/notify');
app.use('/api/v1/push', notifyRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ──
app.use(bodyErrorHandler());
app.use(sentryErrorHandler());
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

// Run cleanup on startup and schedule recurring.
//
// .unref() is load-bearing: without it, the 24h interval pins the libuv
// event loop open, so any process that requires this module (notably the
// four node:test files in tests/) never exits. CI runs since 2026-05-08
// (PR #45 wired three new test files into `node --test`) were cancelling
// at the 6h job ceiling — every test would pass cleanly, then the runner
// would sit on the open handle until GitHub killed the job. Most recent
// repro: run 25935826544 (Unit Tests (push-gateway), 6h0m14s, last test
// log at 18:57:30, cancel at 00:57:27).
// `.unref()` tells Node "this handle is fine to drop on its own" without
// changing prod behaviour (in prod, `app.listen()` keeps the loop alive).
runScheduledCleanup();
setInterval(runScheduledCleanup, CLEANUP_INTERVAL_MS).unref();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🌪️  Windy Chat Push Gateway — listening on port ${PORT}`);
    console.log(`   Push: POST /_matrix/push/v1/notify`);
    console.log(`   FCM:     ${fcmProvider.status()}`);
    console.log(`   APNs:    ${apnsProvider.status()}`);
    console.log(`   WebPush: ${webPushProvider.status()}`);
    console.log(`   Token cleanup: every 24h (30-day stale threshold)`);
  });
}

module.exports = app;
module.exports.channelForEvent = channelForEvent;
module.exports.FCM_CHANNEL_BY_EVENT = FCM_CHANNEL_BY_EVENT;
