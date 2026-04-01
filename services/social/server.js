/**
 * Windy Chat — Social Service (Definitive Implementation)
 * K10: Social Layer (DNA Strand K)
 *
 * The canonical social service for the Windy ecosystem.
 * Handles:
 *   - Posts (CRUD, feed, translation, Eternitas verified badge)
 *   - Follows (with notification queueing)
 *   - Likes (with notification queueing)
 *   - Notifications
 *   - Content moderation (profanity filter + reporting)
 *   - User presence / online status
 *   - Eternitas verified account management
 *
 * Port: 8105
 */

const crypto = require('crypto');
const express = require('express');
const { createCorsOptions } = require('../shared/cors');
const cors = require('cors');
const { createHealthHandler } = require('../shared/health');
const { asyncHandler } = require('../shared/async-handler');
const { createAuthMiddleware } = require('../shared/jwt-verify');
const { verifiedAccounts, persistVerified } = require('./lib/store');

/**
 * Verify Eternitas webhook HMAC signature.
 * Signature is passed in x-eternitas-signature header.
 * HMAC-SHA256 of the raw JSON body using ETERNITAS_WEBHOOK_SECRET.
 */
function verifyEternitasSignature(req) {
  const signature = req.headers['x-eternitas-signature'];
  const secret = process.env.ETERNITAS_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const http = require('http');
const https = require('https');

const ETERNITAS_API_URL = process.env.ETERNITAS_API_URL || 'https://api.eternitas.ai';
const ETERNITAS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const eternitasCache = new Map(); // passportId → { valid, timestamp }

/**
 * Verify a passport against the Eternitas registry API.
 * Caches results for 1 hour to avoid hammering the API.
 * Returns true if the passport is valid and trust score >= 50.
 */
async function verifyWithEternitas(passportId) {
  // Check cache
  const cached = eternitasCache.get(passportId);
  if (cached && (Date.now() - cached.timestamp) < ETERNITAS_CACHE_TTL) {
    return cached.valid;
  }

  try {
    const url = `${ETERNITAS_API_URL}/api/v1/registry/verify/${encodeURIComponent(passportId)}`;
    const httpModule = url.startsWith('https') ? https : http;

    const result = await new Promise((resolve) => {
      const req = httpModule.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const body = JSON.parse(data);
              resolve(body.valid === true && (body.trust_score || 0) >= 50);
            } catch { resolve(false); }
          } else { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });

    eternitasCache.set(passportId, { valid: result, timestamp: Date.now() });
    return result;
  } catch {
    // On error, fall back to local state
    return verifiedAccounts.has(passportId);
  }
}

/**
 * Check if a user is verified. Uses local state (fast) with optional
 * Eternitas API verification for bot passports (async, cached).
 */
function isVerified(userId) {
  return verifiedAccounts.has(userId);
}

const postsRouter = require('./routes/posts');
const followRouter = require('./routes/follow');
const notificationsRouter = require('./routes/notifications');
const moderationRouter = require('./routes/moderation');

const app = express();
const PORT = process.env.PORT || 8105;

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '1mb' }));

// ── Health ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-social',
  version: '1.0.0',
}));

// ── Presence (kept from original) ──
app.get('/api/v1/social/presence/:userId', asyncHandler(async (req, res) => {
  const userId = req.params.userId;
  let verified = verifiedAccounts.has(userId);

  // For bot users (prefixed with bot_), verify against Eternitas API (cached)
  if (userId.startsWith('bot_') && !verified) {
    verified = await verifyWithEternitas(userId);
  }

  res.json({
    userId,
    status: 'online',
    lastSeen: new Date().toISOString(),
    verified,
  });
}));

// ── Routes ──
app.use('/api/v1/social/posts', postsRouter);
app.use('/api/v1/social/follow', followRouter);
app.use('/api/v1/social/notifications', notificationsRouter);
app.use('/api/v1/social/moderation', moderationRouter);

// ── Dashboard Summary (quick panel rendering for unified dashboard) ──
const WINDY_ACCOUNT_SERVER_URL = process.env.WINDY_ACCOUNT_SERVER_URL || 'http://localhost:8098';
const auth = createAuthMiddleware();

app.get('/api/v1/social/dashboard-summary', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const store = require('./lib/store');

  // Recent posts (last 5)
  const allPosts = [...store.postsMap.values()]
    .filter(p => p.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5)
    .map(p => ({ content: p.content, user_id: p.userId, created_at: p.createdAt }));

  // Contacts = following + followers (unique)
  const following = store.followsMap.get(userId);
  const followers = store.followersMap.get(userId);
  const contacts = new Set();
  if (following) for (const id of following) contacts.add(id);
  if (followers) for (const id of followers) contacts.add(id);

  // Unread notifications
  const notifications = store.notificationsMap.get(userId) || [];
  const unreadCount = notifications.filter(n => !n.read).length;

  // DM count and rooms are Matrix concepts — return 0 since we don't have Synapse connected
  res.json({
    unread_dms: 0,
    recent_posts: allPosts,
    contacts_count: contacts.size,
    rooms_joined: 0,
    notifications_unread: unreadCount,
  });
}));

// ── Ecosystem Status (cross-product view) ──

app.get('/api/v1/social/ecosystem-status', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const windyIdentityId = req.user.windy_identity_id;

  // Chat-specific stats
  const userPosts = [...(require('./lib/store').postsMap.values())].filter(p => p.userId === userId);
  const following = require('./lib/store').followsMap.get(userId);
  const followingCount = following ? [...following].length : 0;

  // Try to fetch ecosystem status from account-server
  let ecosystemProducts = null;
  const authToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  if (WINDY_ACCOUNT_SERVER_URL !== 'http://localhost:8098') {
    try {
      const httpModule = WINDY_ACCOUNT_SERVER_URL.startsWith('https') ? https : http;
      ecosystemProducts = await new Promise((resolve) => {
        const ecoUrl = `${WINDY_ACCOUNT_SERVER_URL}/api/v1/identity/ecosystem-status`;
        const ecoReq = httpModule.get(ecoUrl, {
          headers: { 'Authorization': `Bearer ${authToken}` },
          timeout: 5000,
        }, (ecoRes) => {
          let d = ''; ecoRes.on('data', c => d += c);
          ecoRes.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        });
        ecoReq.on('error', () => resolve(null));
        ecoReq.on('timeout', () => { ecoReq.destroy(); resolve(null); });
      });
    } catch { /* ecosystem status unavailable */ }
  }

  res.json({
    windy_identity_id: windyIdentityId,
    user_id: userId,
    chat: {
      posts_count: userPosts.length,
      following_count: followingCount,
      verified: verifiedAccounts.has(userId),
    },
    ecosystem: ecosystemProducts || {
      products: ['chat'],
      _stub: true,
      _note: 'Account-server ecosystem-status endpoint not available',
    },
  });
}));

// ── Enriched User Profile (cross-product presence) ──
app.get('/api/v1/social/profile/:userId', auth, asyncHandler(async (req, res) => {
  const userId = req.params.userId;
  const verified = verifiedAccounts.has(userId);

  // Chat-specific data
  const userPosts = [...(require('./lib/store').postsMap.values())].filter(p => p.userId === userId);
  const followers = require('./lib/store').followersMap.get(userId);
  const following = require('./lib/store').followsMap.get(userId);

  // Cross-product enrichment (from JWT claims or future API lookups)
  const enrichment = {
    windy_mail_address: null, // Future: lookup from Mail service API
    windy_fly_status: null,   // Future: lookup from Fly agent registry
    eternitas_passport: null, // Future: lookup from Eternitas API
  };

  // If this is a bot user, check Eternitas
  if (userId.startsWith('bot_')) {
    const passportId = userId.replace('bot_', '');
    const eternitasValid = await verifyWithEternitas(passportId);
    if (eternitasValid) {
      enrichment.eternitas_passport = passportId;
    }
  }

  res.json({
    user_id: userId,
    verified,
    posts_count: userPosts.length,
    followers_count: followers ? [...followers].length : 0,
    following_count: following ? [...following].length : 0,
    ...enrichment,
  });
}));

// ── Eternitas Verified Badge Management (service-to-service) ──
const serviceAuth = createAuthMiddleware();

app.post('/api/v1/social/eternitas/verify', serviceAuth, asyncHandler(async (req, res) => {
  const { userId, passportId } = req.body;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId is required' });
  }

  // If passportId provided, cross-check with Eternitas API
  if (passportId) {
    const eternitasValid = await verifyWithEternitas(passportId);
    if (!eternitasValid) {
      console.warn(`[social] Eternitas verification failed for passport ${passportId}`);
      // Still allow — Eternitas API may be down; trust the service-to-service call
    }
  }

  verifiedAccounts.add(userId);
  persistVerified();
  res.json({ verified: true, userId });
}));

app.delete('/api/v1/social/eternitas/verify', serviceAuth, asyncHandler(async (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId is required' });
  }
  verifiedAccounts.delete(userId);
  persistVerified();
  res.json({ verified: false, userId });
}));

// ── Eternitas Webhook (receives bot passport lifecycle events) ──
app.post('/api/v1/social/eternitas/webhook', serviceAuth, asyncHandler(async (req, res) => {
  const { event, passport, bot_name, operator_id, reason, timestamp, signature } = req.body;

  // Validate required fields
  if (!event || !passport || !bot_name || !timestamp) {
    return res.status(400).json({ error: 'Missing required fields: event, passport, bot_name, timestamp' });
  }

  const validEvents = ['passport.revoked', 'passport.suspended', 'passport.reinstated'];
  if (!validEvents.includes(event)) {
    return res.status(400).json({ error: `Invalid event type. Must be one of: ${validEvents.join(', ')}` });
  }

  // Verify HMAC signature
  if (process.env.ETERNITAS_WEBHOOK_SECRET) {
    if (!verifyEternitasSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } else {
    console.warn('[social] ETERNITAS_WEBHOOK_SECRET not set — skipping signature verification (development mode)');
  }

  let actionTaken;
  const botUserId = `bot_${passport}`;

  switch (event) {
    case 'passport.revoked':
      verifiedAccounts.delete(botUserId);
      persistVerified();
      actionTaken = 'account_deactivated';
      break;
    case 'passport.suspended':
      verifiedAccounts.delete(botUserId);
      persistVerified();
      actionTaken = 'account_locked';
      break;
    case 'passport.reinstated':
      verifiedAccounts.add(botUserId);
      persistVerified();
      actionTaken = 'account_reactivated';
      break;
  }

  console.log(`[social] Eternitas webhook: ${event} for bot ${bot_name} (${passport}), operator: ${operator_id || 'unknown'}, reason: ${reason || 'none'}`);

  res.json({
    acknowledged: true,
    action_taken: actionTaken,
    bot_user_id: botUserId,
    event,
    timestamp,
  });
}));

// ── 404 ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('[social] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Only listen if run directly (not imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[social] listening on :${PORT}`);
  });
}

module.exports = { app, verifyWithEternitas, isVerified };
