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
  res.json({
    userId: req.params.userId,
    status: 'online',
    lastSeen: new Date().toISOString(),
    verified: verifiedAccounts.has(req.params.userId),
  });
}));

// ── Routes ──
app.use('/api/v1/social/posts', postsRouter);
app.use('/api/v1/social/follow', followRouter);
app.use('/api/v1/social/notifications', notificationsRouter);
app.use('/api/v1/social/moderation', moderationRouter);

// ── Eternitas Verified Badge Management (service-to-service) ──
const serviceAuth = createAuthMiddleware();

app.post('/api/v1/social/eternitas/verify', serviceAuth, asyncHandler(async (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId is required' });
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

module.exports = { app };
