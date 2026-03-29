/**
 * Windy Chat — Shared CORS Configuration
 *
 * Centralized origin whitelist matching the windy-pro account-server pattern.
 * Origins configurable via CORS_ALLOWED_ORIGINS env var (comma-separated).
 */

const DEFAULT_ORIGINS = [
  'https://windypro.com',
  'https://www.windypro.com',
  'https://windychat.com',
  'https://www.windychat.com',
  'https://chat.windypro.com',
  'https://windypro.thewindstorm.uk',
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
