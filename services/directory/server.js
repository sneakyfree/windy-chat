/**
 * Windy Chat — Contact Discovery Service
 * K3: Contact Discovery (DNA Strand K)
 *
 * This service handles finding and connecting with other Windy Chat users:
 *   1. Privacy-first hash-based contact lookup (K3.1)
 *   2. Search by name / email / phone (K3.2)
 *   3. Invite non-users via SMS/email (K3.2.2)
 *
 * Port: 8102
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const lookupRoutes = require('./routes/lookup');
const searchRoutes = require('./routes/search');
const blockRoutes = require('./routes/block');
const agentRoutes = require('./routes/agents');
const { createCorsOptions } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');
const { bodyErrorHandler } = require('../shared/body-errors');

const app = express();
const PORT = process.env.PORT || 8102;

// ── CORS — shared origin whitelist (windypro.com, windychat.com, etc.) ──
app.use(cors(createCorsOptions()));

app.use(express.json({ limit: '2mb' }));

initSentry(app, 'windy-chat-directory');

// ── Auth middleware — JWT + bot API key + legacy CHAT_API_TOKEN fallback ──
// Phase 6A: Replaced static CHAT_API_TOKEN with proper JWT validation.
// CHAT_API_TOKEN still works as fallback for backward compatibility.
const { createAuthMiddleware } = require('../shared/jwt-verify');

const authMiddleware = createAuthMiddleware();

// ── Global rate limiter ──
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ── Health check (no auth required) ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-directory',
  version: '1.0.0',
  checks: async () => ({
    twilio: !!process.env.TWILIO_ACCOUNT_SID,
    sendgrid: !!process.env.SENDGRID_API_KEY,
  }),
}));

// ── Auth-protected routes ──
app.use('/api/v1/chat/directory', authMiddleware, lookupRoutes);
app.use('/api/v1/chat/directory', authMiddleware, searchRoutes);
app.use('/api/v1/chat/directory', authMiddleware, blockRoutes);
app.use('/api/v1/chat/directory', authMiddleware, agentRoutes);

// ── 404 fallback ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use(bodyErrorHandler());
app.use(sentryErrorHandler());
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🌪️  Windy Chat Directory — listening on port ${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/health`);
    console.log(`   Lookup:  http://localhost:${PORT}/api/v1/chat/directory/lookup`);
    console.log(`   Search:  http://localhost:${PORT}/api/v1/chat/directory/search`);
  });
}

module.exports = app;
