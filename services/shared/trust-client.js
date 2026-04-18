/**
 * Windy — Eternitas Trust Client (live contract)
 *
 * Canonical consumer of the Eternitas Trust API. Contract doc is the source
 * of truth — if this client disagrees with it, the doc wins:
 *   /Users/thewindstorm/eternitas/docs/trust-api.md
 *
 *   GET {ETERNITAS_URL}/api/v1/trust/{passport}
 *     → {
 *         passport_number,
 *         status: 'active' | 'suspended' | 'revoked',
 *         integrity_score,
 *         dimensions: { honesty, reliability, compliance, safety, reputation },
 *         band: 'exceptional' | 'good' | 'fair' | 'poor' | 'critical',
 *         clearance_level: 'registered' | 'verified' | 'cleared' | 'top_secret' | 'eternal',
 *         tier_multiplier,
 *         allowed_actions: [...],   // NO `chat:` prefix — bare action names
 *         denied_actions: [...],
 *         cache_ttl_seconds,
 *         evaluated_at
 *       }
 *
 * Public, no Bearer auth. Eternitas rate-limits at 100 req/min/IP, which is
 * why we cache locally for 5 min (or the `cache_ttl_seconds` the server
 * returns, if lower). Status codes:
 *   200 → valid response, cache it
 *   404 → unknown passport, cache a short-TTL negative entry
 *   400 → bad prefix (passport doesn't start with ET or EH) — caller bug, don't cache
 *   429 → rate-limited, honor Retry-After, don't cache
 *
 * Callers should treat the returned profile as a single source of truth:
 *   - `status !== 'active'` → deny everything (don't even check actions)
 *   - `band === 'critical'`  → deny everything (allowed_actions is already [])
 *   - Otherwise check `allowed_actions.includes(...)` or `clearanceMeets(...)`
 *
 * Env vars:
 *   ETERNITAS_URL         — default http://localhost:8500 for dev
 *   ETERNITAS_USE_MOCK    — 'true' returns a deterministic stub (tests/demo)
 *   REDIS_URL             — optional shared cache across processes
 */

// `redis` is optional — when not installed (consumer hasn't added it as a
// dep) we transparently fall back to an in-memory Map.
let redis = null;
try { redis = require('redis'); } catch { /* optional dependency */ }

// Read from env at call time (not module-load) so test harnesses that set
// ETERNITAS_URL *after* requiring this module still see the override. The
// live-integration harness (tests/integration/test_trust_live.js) relies on
// this to point at its stand-in HTTP server after boot.
function eternitasUrl() {
  return process.env.ETERNITAS_URL
    || process.env.ETERNITAS_API_URL
    || 'http://localhost:8500';
}
function useMock() {
  return String(process.env.ETERNITAS_USE_MOCK || '').toLowerCase() === 'true';
}
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CACHE_NS = 'windy:chat:trust';
const DEFAULT_CACHE_TTL_SECONDS = 5 * 60;
const NEGATIVE_CACHE_TTL_SECONDS = 60; // 404 — assume the passport might exist soon
const FETCH_TIMEOUT_MS = 5000;

let redisClient = null;
let redisConnected = false;
let redisAttempted = false;
const fallback = new Map(); // key → { expiresAt, profile }

// ── Telemetry (P3-1) ─────────────────────────────────────────────────
// In-memory counters so operators / health endpoints can see cache
// effectiveness without wiring a full metrics stack. Reset at process
// restart; export getTrustClientMetrics() to surface them.
//
//   local_hits       — request served from our Redis/in-memory cache
//   local_misses     — request forwarded to Eternitas
//   upstream_hits    — of those forwarded, Eternitas reported
//                      `X-Trust-Cache: hit` (its server-side cache hit)
//   upstream_misses  — Eternitas reported `X-Trust-Cache: miss`
//                      (actual DB read)
//   fetch_errors     — network/timeout/5xx (a "null" denial from the
//                      gate layer's perspective)
//   not_found        — 404 from Eternitas (unknown passport)
//   rate_limited     — 429 from Eternitas
const metrics = {
  local_hits: 0,
  local_misses: 0,
  upstream_hits: 0,
  upstream_misses: 0,
  fetch_errors: 0,
  not_found: 0,
  rate_limited: 0,
};

function getTrustClientMetrics() {
  const total = metrics.local_hits + metrics.local_misses;
  const localHitRate = total > 0 ? metrics.local_hits / total : null;
  const upstreamTotal = metrics.upstream_hits + metrics.upstream_misses;
  const upstreamHitRate = upstreamTotal > 0 ? metrics.upstream_hits / upstreamTotal : null;
  return {
    ...metrics,
    local_hit_rate: localHitRate === null ? null : Math.round(localHitRate * 1000) / 1000,
    upstream_hit_rate: upstreamHitRate === null ? null : Math.round(upstreamHitRate * 1000) / 1000,
    total_requests: total,
  };
}

function _resetMetricsForTest() {
  for (const k of Object.keys(metrics)) metrics[k] = 0;
}

async function getRedis() {
  if (redisAttempted) return redisConnected ? redisClient : null;
  redisAttempted = true;
  if (!redis) return null;
  try {
    redisClient = redis.createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: (r) => (r > 5 ? false : Math.min(r * 200, 2000)),
      },
    });
    redisClient.on('error', () => { redisConnected = false; });
    redisClient.on('connect', () => { redisConnected = true; });
    await redisClient.connect();
    redisConnected = true;
    return redisClient;
  } catch (err) {
    console.warn(`[trust-client] Redis unavailable (${err.message}) — using in-memory cache`);
    redisClient = null;
    redisConnected = false;
    return null;
  }
}

async function cacheGet(key) {
  const client = await getRedis();
  if (client && redisConnected) {
    try {
      const raw = await client.get(`${CACHE_NS}:${key}`);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('[trust-client] Redis GET failed:', err.message);
    }
  }
  const entry = fallback.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.profile;
  if (entry) fallback.delete(key);
  return null;
}

async function cacheSet(key, profile, ttlSeconds) {
  const ttl = ttlSeconds || DEFAULT_CACHE_TTL_SECONDS;
  const client = await getRedis();
  if (client && redisConnected) {
    try {
      await client.set(`${CACHE_NS}:${key}`, JSON.stringify(profile), { EX: ttl });
      return;
    } catch (err) {
      console.warn('[trust-client] Redis SET failed:', err.message);
    }
  }
  fallback.set(key, { profile, expiresAt: Date.now() + ttl * 1000 });
}

// ── Mock mode ─────────────────────────────────────────────────────────
// Deterministic stub keyed off substrings in the passport. Used in tests
// and dev before Eternitas is live. Real gating must run with
// ETERNITAS_USE_MOCK=false against the actual endpoint.

function mockProfile(passport) {
  // Passport-name conventions the gates test against:
  //   contains "EXCEPTIONAL" → band=exceptional, clearance=eternal, every action allowed
  //   contains "CRITICAL"    → band=critical, all actions denied, status=active
  //   contains "SUSPENDED"   → status=suspended
  //   contains "REVOKED"     → status=revoked
  //   contains "TOP"         → clearance=top_secret, band=good, top-tier actions
  //   otherwise              → clearance=cleared, band=good, baseline-cleared actions
  const p = passport.toUpperCase();
  if (p.includes('CRITICAL')) {
    return {
      passport_number: passport, status: 'active',
      integrity_score: 200, dimensions: {},
      band: 'critical', clearance_level: 'cleared', tier_multiplier: 0,
      allowed_actions: [], denied_actions: ALL_ACTIONS,
      cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS, evaluated_at: new Date().toISOString(),
    };
  }
  if (p.includes('SUSPENDED')) {
    return {
      passport_number: passport, status: 'suspended',
      integrity_score: 500, dimensions: {},
      band: 'fair', clearance_level: 'cleared', tier_multiplier: 0,
      allowed_actions: [], denied_actions: ALL_ACTIONS,
      cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS, evaluated_at: new Date().toISOString(),
    };
  }
  if (p.includes('REVOKED')) {
    return {
      passport_number: passport, status: 'revoked',
      integrity_score: 0, dimensions: {},
      band: 'critical', clearance_level: 'registered', tier_multiplier: 0,
      allowed_actions: [], denied_actions: ALL_ACTIONS,
      cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS, evaluated_at: new Date().toISOString(),
    };
  }
  if (p.includes('EXCEPTIONAL')) {
    return {
      passport_number: passport, status: 'active',
      integrity_score: 950, dimensions: {},
      band: 'exceptional', clearance_level: 'eternal', tier_multiplier: 5.0,
      allowed_actions: [...ALL_ACTIONS], denied_actions: [],
      cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS, evaluated_at: new Date().toISOString(),
    };
  }
  if (p.includes('TOP')) {
    return {
      passport_number: passport, status: 'active',
      integrity_score: 820, dimensions: {},
      band: 'good', clearance_level: 'top_secret', tier_multiplier: 2.0,
      allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages', 'commit_push', 'broadcast', 'mention_strangers'],
      denied_actions: ['bypass_rate_caps'],
      cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS, evaluated_at: new Date().toISOString(),
    };
  }
  return {
    passport_number: passport, status: 'active',
    integrity_score: 780, dimensions: {},
    band: 'good', clearance_level: 'cleared', tier_multiplier: 1.5,
    allowed_actions: ['read', 'send', 'execute', 'dm_bots', 'install_packages'],
    denied_actions: ['commit_push', 'broadcast', 'mention_strangers', 'bypass_rate_caps'],
    cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS, evaluated_at: new Date().toISOString(),
  };
}

// ── Main API ──────────────────────────────────────────────────────────

/**
 * Fetch a trust profile for a passport. Returns null only when Eternitas
 * is unreachable — a 404 (unknown passport) returns a negative profile
 * with status='not_found' that should be treated as deny.
 */
async function getTrustProfile(passport) {
  if (!passport || typeof passport !== 'string') return null;

  if (useMock()) {
    return mockProfile(passport);
  }

  const cached = await cacheGet(passport);
  if (cached) {
    metrics.local_hits += 1;
    return cached;
  }
  metrics.local_misses += 1;

  const url = `${eternitasUrl().replace(/\/+$/, '')}/api/v1/trust/${encodeURIComponent(passport)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // Record Eternitas's own cache hint if present (P3-1).
    const upstreamCache = res.headers.get('x-trust-cache');
    if (upstreamCache === 'hit') metrics.upstream_hits += 1;
    else if (upstreamCache === 'miss') metrics.upstream_misses += 1;

    if (res.status === 404) {
      metrics.not_found += 1;
      const negative = { passport_number: passport, status: 'not_found', allowed_actions: [], denied_actions: [] };
      await cacheSet(passport, negative, NEGATIVE_CACHE_TTL_SECONDS);
      return negative;
    }
    if (res.status === 400) {
      metrics.fetch_errors += 1;
      console.warn(`[trust-client] 400 bad-prefix for ${passport}`);
      return null; // caller bug — don't cache
    }
    if (res.status === 429) {
      metrics.rate_limited += 1;
      const retryAfter = res.headers.get('retry-after');
      console.warn(`[trust-client] 429 rate-limited for ${passport} (retry after ${retryAfter || '?'}s)`);
      return null;
    }
    if (!res.ok) {
      metrics.fetch_errors += 1;
      console.warn(`[trust-client] Eternitas ${res.status} for ${passport}`);
      return null;
    }

    const body = await res.json();
    // Pass the full body through — callers want status, band, clearance_level,
    // tier_multiplier, etc. — not just an opinion about valid/invalid.
    const profile = {
      passport_number: body.passport_number || passport,
      status: body.status || 'active',
      integrity_score: body.integrity_score ?? null,
      dimensions: body.dimensions || {},
      band: body.band || 'poor',
      clearance_level: body.clearance_level || 'registered',
      tier_multiplier: body.tier_multiplier ?? 0,
      allowed_actions: Array.isArray(body.allowed_actions) ? body.allowed_actions : [],
      denied_actions: Array.isArray(body.denied_actions) ? body.denied_actions : [],
      cache_ttl_seconds: body.cache_ttl_seconds || DEFAULT_CACHE_TTL_SECONDS,
      evaluated_at: body.evaluated_at || new Date().toISOString(),
    };
    // Respect the server's cache hint if it's shorter than our default
    const ttl = Math.min(profile.cache_ttl_seconds, DEFAULT_CACHE_TTL_SECONDS);
    await cacheSet(passport, profile, ttl);
    return profile;
  } catch (err) {
    metrics.fetch_errors += 1;
    console.warn(`[trust-client] fetch failed for ${passport}: ${err.message}`);
    return null;
  }
}

/**
 * Remove the cached trust profile for a passport so the next
 * getTrustProfile call re-fetches from Eternitas. Used by the
 * passport.revoked and trust.changed webhook handlers to kill
 * stale authorization decisions within the cache TTL window.
 *
 * Idempotent: returns true if an entry existed anywhere (Redis or
 * fallback), false otherwise. Never throws.
 */
async function invalidateTrustCache(passport) {
  if (!passport || typeof passport !== 'string') return false;
  let existed = false;

  const client = await getRedis();
  if (client && redisConnected) {
    try {
      const count = await client.del(`${CACHE_NS}:${passport}`);
      if (count > 0) existed = true;
    } catch (err) {
      console.warn('[trust-client] Redis DEL failed:', err.message);
    }
  }

  if (fallback.delete(passport)) existed = true;
  return existed;
}

// ── Clearance level ordering per trust-api.md ──
// registered < verified < cleared < top_secret < eternal
const CLEARANCE_RANK = {
  registered: 0,
  verified: 1,
  cleared: 2,
  top_secret: 3,
  eternal: 4,
};

function clearanceMeets(level, required) {
  const a = CLEARANCE_RANK[level] ?? -1;
  const b = CLEARANCE_RANK[required] ?? Number.MAX_SAFE_INTEGER;
  return a >= b;
}

/**
 * Shortcut: is this passport usable at all right now? Callers that just
 * want to reject suspended/revoked/critical in one line can use this
 * before checking specific actions.
 */
function isActive(profile) {
  if (!profile) return false;
  if (profile.status !== 'active') return false;
  if (profile.band === 'critical') return false;
  return true;
}

// Action vocabulary from trust-api.md. Kept in code so the mock can emit
// consistent denied_actions lists. Not exported — consumers should read
// these off of real profiles, not hardcode.
const ALL_ACTIONS = Object.freeze([
  'read', 'send', 'execute', 'dm_bots', 'install_packages',
  'commit_push', 'broadcast', 'mention_strangers', 'bypass_rate_caps',
]);

// ── Test helpers ──

function _setCacheForTest(passport, profile) {
  fallback.set(passport, { profile, expiresAt: Date.now() + DEFAULT_CACHE_TTL_SECONDS * 1000 });
}
function _clearCacheForTest() { fallback.clear(); }
function _getCacheForTest(passport) {
  const entry = fallback.get(passport);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { fallback.delete(passport); return null; }
  return entry.profile;
}

module.exports = {
  getTrustProfile,
  invalidateTrustCache,
  clearanceMeets,
  isActive,
  getTrustClientMetrics,
  CLEARANCE_RANK,
  _setCacheForTest,
  _clearCacheForTest,
  _getCacheForTest,
  _resetMetricsForTest,
};
