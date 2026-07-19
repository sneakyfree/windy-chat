/**
 * Windy Chat — Shared CORS Configuration
 *
 * Centralized origin allowlist shared by every Node service in the repo.
 * Extra origins can be appended via CORS_ALLOWED_ORIGINS (comma-separated).
 *
 * Surface:
 *   - createCorsMiddleware()  → preferred; returns an express middleware
 *                              that sets CORS headers on allowed origins,
 *                              short-circuits OPTIONS preflights, and sends
 *                              a 403 JSON envelope on disallowed origins.
 *                              It never throws, so Express's default error
 *                              handler never sees a "CORS: origin not
 *                              allowed" stack trace (Wave 13 Phase 4 P1-1).
 *   - createCorsOptions()     → legacy; returns options for the `cors` npm
 *                              package. Kept for back-compat. Miss path
 *                              resolves callback(null, false) instead of
 *                              throwing — the cors package then silently
 *                              omits the ACAO header, which browsers treat
 *                              as a block. No 500s.
 */
'use strict';

const DEFAULT_ORIGINS = [
  // Canonical prod hosts — chat.windychat.ai is the Wave 13 Phase 4
  // deployment target; add www.* defensively in case a future ingress
  // normalises to it. app.windychat.ai is the SPA shell users actually
  // browse to (`app.` subdomain hosts the Cloudflare Pages bundle).
  'https://chat.windychat.ai',
  'https://www.chat.windychat.ai',
  'https://app.windychat.ai',
  'https://windychat.ai',
  // windyword.ai (Word) + sibling product apex hosts — each product ships a
  // frontend that legitimately XHRs into chat's REST API (cross-product
  // integrations). The `account.` subdomain is the Word/dashboard SPA, which
  // calls Pro account-server but also cross-origin XHRs the chat onboarding
  // service (Activate-Chat flow → /chat/provision). Per canonical-domains v8
  // only the `account.` host is canonical for Word; other subdomains are banned.
  'https://windyword.ai',
  'https://www.windyword.ai',
  'https://account.windyword.ai',
  // app.windyword.ai is the hub SPA (CF Pages windypro-webapp); it XHRs the
  // windy.panel.v1 control-panel API on chat.windychat.ai cross-origin.
  'https://app.windyword.ai',
  'https://mail.windymail.ai',
  'https://windyclone.ai',
  'https://windyfly.ai',
  'https://windycode.org',
  'https://cloud.windycloud.com',
  'https://api.eternitas.ai',
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

function isOriginAllowed(origin, allowed = getAllowedOrigins()) {
  if (!origin) return true;  // server-to-server / mobile app / curl
  if (process.env.NODE_ENV !== 'production'
      && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    return true;
  }
  return allowed.includes(origin);
}

function createCorsOptions() {
  const allowed = getAllowedOrigins();

  return {
    origin: function (origin, callback) {
      if (isOriginAllowed(origin, allowed)) return callback(null, true);
      // IMPORTANT: do NOT throw — that used to hit Express's default error
      // handler and emit an HTTP 500 with a "CORS: origin not allowed"
      // stack trace in the service logs (Wave 13 Phase 4 P1-1). Returning
      // (null, false) makes the cors package silently omit the ACAO header
      // so the browser enforces the block. Callers that want an explicit
      // 403 JSON envelope should prefer createCorsMiddleware() below.
      return callback(null, false);
    },
    credentials: true,
  };
}

/**
 * Preferred express middleware. Pure implementation — no dependency on the
 * `cors` npm package — so failure modes are easy to reason about:
 *
 *   - No Origin header                → pass through (server-to-server).
 *   - Origin in allowlist             → set ACAO + ACAC + Vary; pass.
 *   - Method = OPTIONS + allowed      → emit preflight headers, end 204.
 *   - Method = OPTIONS + disallowed   → 403 JSON (browsers reject anyway,
 *                                       but attackers / curl get a clean
 *                                       envelope rather than an empty 204).
 *   - Any other method + disallowed   → 403 JSON with code CORS_ORIGIN_DENIED.
 */
function createCorsMiddleware() {
  const allowed = getAllowedOrigins();

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    if (!origin) {
      // Server-to-server / mobile app / curl — no CORS headers needed.
      return next();
    }

    if (!isOriginAllowed(origin, allowed)) {
      return res.status(403).json({
        error: 'Origin not allowed',
        code: 'CORS_ORIGIN_DENIED',
      });
    }

    // Allowed origin — set response headers.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // `Vary: Origin` tells caches the response varies by origin; stacking
    // with any pre-existing Vary header (e.g. Authorization) is harmless.
    const existingVary = res.getHeader('Vary');
    if (existingVary) {
      const parts = String(existingVary).split(',').map(s => s.trim());
      if (!parts.includes('Origin')) parts.push('Origin');
      res.setHeader('Vary', parts.join(', '));
    } else {
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      const reqMethod = req.headers['access-control-request-method'];
      const reqHeaders = req.headers['access-control-request-headers'];
      res.setHeader(
        'Access-Control-Allow-Methods',
        reqMethod || 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
      );
      if (reqHeaders) {
        res.setHeader('Access-Control-Allow-Headers', reqHeaders);
      } else {
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization,Content-Type,X-Requested-With',
        );
      }
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }

    return next();
  };
}

module.exports = {
  createCorsMiddleware,
  createCorsOptions,
  getAllowedOrigins,
  isOriginAllowed,
  DEFAULT_ORIGINS,
};
