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
const { createCorsOptions } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');

const app = express();
const PORT = process.env.PORT || 8101;

// ── CORS — shared origin whitelist (windypro.com, windychat.com, etc.) ──
app.use(cors(createCorsOptions()));

app.use(express.json({ limit: '5mb' }));

// ── Auth middleware — JWT + bot API key + legacy CHAT_API_TOKEN fallback ──
// Phase 6A: Replaced static CHAT_API_TOKEN with proper JWT validation.
// CHAT_API_TOKEN still works as fallback for backward compatibility.
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

// ── Auth-protected routes ──
app.use('/api/v1/chat/verify', authMiddleware, verifyRoutes);
app.use('/api/v1/chat/profile', authMiddleware, profileRoutes);
app.use('/api/v1/chat/pair', authMiddleware, pairRoutes);
app.use('/api/v1/chat/provision', authMiddleware, provisionRoutes);
app.use('/api/v1/onboarding', authMiddleware, provisionRoutes);

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

// ── 404 fallback ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`🌪️  Windy Chat Onboarding — listening on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Verify: http://localhost:${PORT}/api/v1/chat/verify/send`);
  console.log(`   Profile: http://localhost:${PORT}/api/v1/chat/profile/setup`);
  console.log(`   Pair: http://localhost:${PORT}/api/v1/chat/pair/generate`);
});

module.exports = app;
