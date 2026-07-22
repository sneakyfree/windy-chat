/**
 * Windy Chat — Hub Service
 * Hub Mode (exec-guide-hub-mode-2026-07-06): bridged-platform connection
 * manager. Wraps the mautrix bridgev2 provisioning API so clients can
 * connect/disconnect their Telegram/Slack/WhatsApp/Discord accounts, and
 * owns the connected_platforms store.
 *
 * Port: 8109 (8106 is translation; agent-roster moved to 8110 to resolve a
 * former double-book; 8107-8108 are media/call-history).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const hubRoutes = require('./routes/hub');
const { createCorsMiddleware } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { createVersionHandler } = require('../shared/version');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');
const { bodyErrorHandler } = require('../shared/body-errors');
const { createAuthMiddleware } = require('../shared/jwt-verify');
const { listConfiguredPlatforms } = require('./lib/bridges');

const app = express();
// Behind host nginx (single hop) — key rate limits on the real client IP.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8109;

app.use(createCorsMiddleware());
app.use(express.json({ limit: '1mb' }));

initSentry(app, 'windy-chat-hub');

app.get('/health', createHealthHandler({
  service: 'windy-chat-hub',
  checks: async () => ({
    configured_platforms: listConfiguredPlatforms().map((p) => p.key).join(',') || 'none',
  }),
}));
app.get('/version', createVersionHandler({ service: 'windy-chat-hub' }));

// Provisioning calls are interactive (a human typing codes), not bulk.
app.use('/api/v1/hub', rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use('/api/v1/hub', createAuthMiddleware(), hubRoutes);

app.use(bodyErrorHandler());
app.use(sentryErrorHandler());
// Final error handler — never leak stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[hub] unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    const configured = listConfiguredPlatforms().map((p) => p.key);
    console.log(`[hub] listening on :${PORT} — configured platforms: ${configured.join(', ') || '(none)'}`);
  });
}

module.exports = app;
