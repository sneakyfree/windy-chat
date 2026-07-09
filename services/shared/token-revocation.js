/**
 * Blacklist-aware token check against the windy-pro account-server.
 *
 * RS256/JWKS verification (jwt-verify.js) is purely cryptographic — a
 * token blacklisted at account-server logout keeps a valid signature for
 * its full 15-min TTL, so "log out everywhere" was not true at Chat
 * (launch P0 #2, LAUNCH-READINESS-2026-07-08.md). This module closes it
 * by calling the account-server's blacklist-aware
 * `GET /api/v1/identity/validate-token` with the caller's own token.
 *
 * Verdicts are cached in-process per token hash for
 * IDENTITY_VALIDATE_TTL_SECONDS (default 30), so a logged-out token is
 * rejected within one TTL window and a live session adds at most one
 * cross-service round-trip per window per service instance.
 *
 * Failure semantics (ADR-026 §4): account-server unreachable → serve a
 * stale positive verdict up to IDENTITY_VALIDATE_MAX_STALE_SECONDS
 * (default 300), beyond that fail CLOSED in production
 * (RevocationUnavailableError → 503 at the middleware), fail OPEN in
 * dev/test so local flows work without a running account-server.
 *
 * Response mapping:
 *   200           → active (cache positive)
 *   401           → revoked/blacklisted/expired at the authority
 *                   (TokenRevokedError → 401)
 *   404           → valid signature, no identity row — not a revocation
 *                   signal (logout always yields 401); treat as active
 *   5xx / network → stale-grace then fail closed (prod) / open (dev)
 *
 * IDENTITY_VALIDATE_ENABLED=false is the ops kill-switch.
 */

const crypto = require('crypto');

const TIMEOUT_MS = 5000;
const PRUNE_THRESHOLD = 1024;

// tokenHash → { at: epoch-ms, active: bool }
const cache = new Map();

class TokenRevokedError extends Error {
  constructor() {
    super('Token revoked');
    this.name = 'TokenRevokedError';
  }
}

class RevocationUnavailableError extends Error {
  constructor(reason) {
    super(`Revocation status unavailable: ${reason}`);
    this.name = 'RevocationUnavailableError';
  }
}

function config() {
  return {
    enabled: process.env.IDENTITY_VALIDATE_ENABLED !== 'false',
    accountServerUrl:
      process.env.WINDY_ACCOUNT_SERVER_URL || 'http://localhost:8098',
    ttlMs:
      parseInt(process.env.IDENTITY_VALIDATE_TTL_SECONDS || '30', 10) * 1000,
    maxStaleMs:
      parseInt(process.env.IDENTITY_VALIDATE_MAX_STALE_SECONDS || '300', 10) *
      1000,
    isProduction: process.env.NODE_ENV === 'production',
  };
}

function prune(now, maxStaleMs) {
  if (cache.size < PRUNE_THRESHOLD) return;
  for (const [key, entry] of cache) {
    if (now - entry.at > maxStaleMs) cache.delete(key);
  }
}

function failOrGrace(entry, now, cfg, reason) {
  if (entry && entry.active && now - entry.at < cfg.maxStaleMs) {
    console.warn(
      `[token-revocation] validate-token ${reason}; serving ${Math.round(
        (now - entry.at) / 1000
      )}s-stale positive verdict`
    );
    return;
  }
  if (!cfg.isProduction) {
    console.warn(
      `[token-revocation] validate-token ${reason} — failing OPEN (non-production)`
    );
    return;
  }
  console.error(
    `[token-revocation] validate-token ${reason} and no stale verdict — failing CLOSED`
  );
  throw new RevocationUnavailableError(reason);
}

/**
 * Throws TokenRevokedError if the account-server says the token is
 * revoked, RevocationUnavailableError if the authority is unreachable
 * past the stale allowance in production. Resolves when active.
 */
async function ensureTokenActive(token, { fetchImpl = fetch } = {}) {
  const cfg = config();
  if (!cfg.enabled) return;

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();

  const entry = cache.get(tokenHash);
  if (entry && now - entry.at < cfg.ttlMs) {
    if (entry.active) return;
    throw new TokenRevokedError();
  }

  prune(now, cfg.maxStaleMs);

  let resp;
  try {
    resp = await fetchImpl(
      `${cfg.accountServerUrl}/api/v1/identity/validate-token`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
  } catch (err) {
    return failOrGrace(entry, now, cfg, `unreachable: ${err.message}`);
  }

  if (resp.status === 401) {
    cache.set(tokenHash, { at: now, active: false });
    throw new TokenRevokedError();
  }

  if (resp.status === 200 || resp.status === 404) {
    cache.set(tokenHash, { at: now, active: true });
    return;
  }

  return failOrGrace(entry, now, cfg, `unexpected status ${resp.status}`);
}

/** Test hook — drop all cached verdicts. */
function resetCache() {
  cache.clear();
}

module.exports = {
  ensureTokenActive,
  resetCache,
  TokenRevokedError,
  RevocationUnavailableError,
};
