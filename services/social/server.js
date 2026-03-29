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

const express = require('express');
const { createCorsOptions } = require('../shared/cors');
const cors = require('cors');
const { createHealthHandler } = require('../shared/health');
const { asyncHandler } = require('../shared/async-handler');
const { createAuthMiddleware } = require('../shared/jwt-verify');
const { verifiedAccounts, persistVerified } = require('./lib/store');

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
