/**
 * Windy Chat — Shared CORS Configuration
 *
 * Centralized origin whitelist matching the windy-pro account-server pattern.
 * Origins configurable via CORS_ALLOWED_ORIGINS env var (comma-separated).
 */

const DEFAULT_ORIGINS = [
  // Legacy windypro.com hosts (pre-domain-migration)
  'https://windypro.com',
  'https://www.windypro.com',
  'https://app.windypro.com',
  'https://windychat.com',
  'https://www.windychat.com',
  // windyword.ai — root + every sibling Windy product. Each of these
  // hosts hosts a frontend that legitimately XHRs into chat's REST API
  // (cross-product integrations). P2-2: was missing mail/clone/fly/code.
  'https://windyword.ai',
  'https://www.windyword.ai',
  'https://chat.windyword.ai',
  'https://mail.windyword.ai',
  'https://clone.windyword.ai',
  'https://fly.windyword.ai',
  'https://code.windyword.ai',
  'https://cloud.windyword.ai',
  'https://eternitas.windyword.ai',
  // Dev servers
  'http://localhost:5173',  // Vite dev server
  'http://localhost:4173',  // Vite preview
];

function getAllowedOrigins() {
  const extra = process.env.CORS_ALLOWED_ORIGINS;
  if (extra) {
    return [...DEFAULT_ORIGINS, ...extra.split(',').map(o => o.trim()).filter(Boolean)];
  }
  return DEFAULT_ORIGINS;
}

function createCorsOptions() {
  const allowed = getAllowedOrigins();

  return {
    origin: function (origin, callback) {
      // Allow requests with no origin (server-to-server, curl, mobile apps)
      if (!origin) return callback(null, true);
      // Allow localhost in non-production
      if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      if (allowed.includes(origin)) return callback(null, true);
      callback(new Error('CORS: origin not allowed'));
    },
    credentials: true,
  };
}

module.exports = { createCorsOptions, getAllowedOrigins, DEFAULT_ORIGINS };
