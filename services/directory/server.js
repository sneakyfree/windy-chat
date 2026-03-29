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

const app = express();
const PORT = process.env.PORT || 8102;

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

app.use(express.json({ limit: '2mb' }));

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
  max: 60,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ── Health check (no auth required) ──
app.get('/health', (_req, res) => {
  res.json({
    service: 'windy-chat-directory',
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── Auth-protected routes ──
app.use('/api/v1/chat/directory', authMiddleware, lookupRoutes);
app.use('/api/v1/chat/directory', authMiddleware, searchRoutes);

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
  console.log(`🌪️  Windy Chat Directory — listening on port ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   Lookup:  http://localhost:${PORT}/api/v1/chat/directory/lookup`);
  console.log(`   Search:  http://localhost:${PORT}/api/v1/chat/directory/search`);
});

module.exports = app;
