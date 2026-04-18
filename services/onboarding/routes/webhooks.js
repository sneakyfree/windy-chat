/**
 * Windy Chat — Identity & Passport Webhook Routes
 *
 * Push-side onboarding: Windy Pro publishes identity.created the moment a
 * Unified Identity is provisioned, so Chat can provision the Matrix account
 * before the client ever calls /unified-login. Mirrors the pattern Windy Mail
 * uses (api/app/routes/webhooks.py) so handles stay aligned across products.
 *
 * Endpoints (no authMiddleware — HMAC-verified, service-to-service):
 *   POST /api/v1/webhooks/identity/created   — HMAC-SHA256 (WINDY_IDENTITY_WEBHOOK_SECRET)
 *   POST /api/v1/webhooks/passport/revoked   — HMAC-SHA256 (ETERNITAS_WEBHOOK_SECRET)
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../shared/async-handler');
const { invalidateTrustCache } = require('../../shared/trust-client');

const onboardingDb = require('../lib/db');

const router = express.Router();

// ── Config ──
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_URL = process.env.SYNAPSE_ADMIN_URL || `${SYNAPSE_URL}/_synapse/admin`;
const SYNAPSE_REGISTRATION_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET || '';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windyword.ai';
const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';

const IDENTITY_WEBHOOK_SECRET = process.env.WINDY_IDENTITY_WEBHOOK_SECRET || '';
const ETERNITAS_WEBHOOK_SECRET = process.env.ETERNITAS_WEBHOOK_SECRET || '';

// ── HMAC verification ──

/**
 * Constant-time HMAC-SHA256 check against the raw request body.
 *
 * Accepts both signature encodings:
 *   - `sha256=<hex>`  — live Eternitas format per docs/webhooks.md
 *   - `<hex>`         — legacy bare-hex (our Wave 2 tests, Mail's
 *                       verify_webhook_signature, and older producers)
 *
 * Taking both keeps us forward-compatible while the ecosystem migrates.
 */
function verifyHmac(rawBody, signature, secret) {
  if (!secret || !signature || !rawBody) return false;

  // Normalize: strip the `sha256=` prefix if present. Case-insensitive on
  // the prefix only — the hex itself is lowercased by our comparison.
  let sig = String(signature).trim();
  const prefixMatch = sig.match(/^sha256=(.+)$/i);
  if (prefixMatch) sig = prefixMatch[1];

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Middleware factory that captures the raw body (for HMAC) and verifies
 * the signature header.
 *
 * Fail-closed when the secret is unset, regardless of NODE_ENV. The
 * previous "skip verification when NODE_ENV !== 'production'" path was
 * a foot-gun — a container deployed without NODE_ENV explicitly set
 * (easy to miss in Dockerfiles and pm2 configs) would accept
 * unauthenticated revoke-the-world webhooks.
 *
 * Tests that need to bypass verification must set the secret to a
 * known value (see tests/webhooks.test.js) — there is no auth-disabled
 * mode anymore.
 */
function hmacMiddleware({ header, secret, name }) {
  return (req, res, next) => {
    if (!secret) {
      console.error(`[webhooks] ${name} secret not configured — rejecting`);
      return res.status(503).json({ error: `${name} webhook secret not configured` });
    }
    const signature = req.headers[header.toLowerCase()];
    if (!signature) {
      return res.status(401).json({ error: 'Missing signature header' });
    }
    // express.json() with the verify hook stashes the raw body on req.rawBody.
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    if (!verifyHmac(raw, signature, secret)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    next();
  };
}

// ── Mail-aligned localpart generation ──

/**
 * Generate a Matrix localpart aligned with Mail's email_local algorithm so
 * @grant.whitmer:chat.windyword.ai matches grant.whitmer@windymail.ai.
 *
 * Priority: first+last → username → email local-part → display_name.
 * Matrix allows `[a-z0-9._=/-]` in localparts; Mail allows `[a-z0-9._-]`.
 * We use the narrower intersection to guarantee handle parity.
 */
function mailAlignedLocalpart({ firstName, lastName, username, email, displayName }) {
  let base;
  if (firstName && lastName) {
    base = `${firstName}.${lastName}`;
  } else if (username) {
    base = username;
  } else if (email && email.includes('@')) {
    base = email.split('@')[0];
  } else {
    base = (displayName || '').replace(/\s+/g, '.');
  }
  base = base.toLowerCase().trim().replace(/[^a-z0-9._-]/g, '');
  if (!base || !/^[a-z0-9]/.test(base)) {
    base = `user-${crypto.randomBytes(2).toString('hex')}`;
  }
  return base.slice(0, 32);
}

/**
 * Find an unused localpart by appending a short hex suffix on collision.
 * Collision check: the onboarding profile table (single source of truth for
 * this service's handles).
 */
function resolveUniqueLocalpart(base) {
  const existing = onboardingDb.db
    .prepare('SELECT 1 FROM user_profiles WHERE chat_user_id = ?')
    .get(base);
  if (!existing) return base;

  // Try up to 3 times with random suffixes
  for (let i = 0; i < 3; i++) {
    const suffix = crypto.randomBytes(3).toString('hex');
    const candidate = `${base}-${suffix}`.slice(0, 32);
    const taken = onboardingDb.db
      .prepare('SELECT 1 FROM user_profiles WHERE chat_user_id = ?')
      .get(candidate);
    if (!taken) return candidate;
  }
  throw new Error(`Could not generate unique localpart for base="${base}"`);
}

// ── Synapse admin helpers ──

function generateRegistrationMac(nonce, username, password, admin = false) {
  const h = crypto.createHmac('sha1', SYNAPSE_REGISTRATION_SECRET);
  h.update(nonce); h.update('\x00');
  h.update(username); h.update('\x00');
  h.update(password); h.update('\x00');
  h.update(admin ? 'admin' : 'notadmin');
  return h.digest('hex');
}

async function provisionMatrixAccount(localpart, displayName) {
  if (!SYNAPSE_REGISTRATION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SYNAPSE_REGISTRATION_SECRET not set in production');
    }
    // Dev stub — matches provision.js fallback behavior
    return {
      matrixUserId: `@${localpart}:${SYNAPSE_SERVER_NAME}`,
      accessToken: `dev_token_${uuidv4()}`,
      deviceId: `dev_device_${uuidv4().slice(0, 8)}`,
      homeServer: SYNAPSE_SERVER_NAME,
      _dev: true,
    };
  }

  const nonceRes = await fetch(`${SYNAPSE_ADMIN_URL}/v1/register`, {
    method: 'GET',
    signal: AbortSignal.timeout(10000),
  });
  if (!nonceRes.ok) throw new Error(`Synapse nonce failed: ${nonceRes.status}`);
  const { nonce } = await nonceRes.json();

  const password = crypto.randomBytes(32).toString('hex');
  const mac = generateRegistrationMac(nonce, localpart, password, false);

  const regRes = await fetch(`${SYNAPSE_ADMIN_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, username: localpart, password, displayname: displayName, admin: false, mac }),
    signal: AbortSignal.timeout(10000),
  });
  if (!regRes.ok) throw new Error(`Synapse registration failed: ${regRes.status}`);
  const result = await regRes.json();
  return {
    matrixUserId: result.user_id || `@${localpart}:${SYNAPSE_SERVER_NAME}`,
    accessToken: result.access_token,
    deviceId: result.device_id,
    homeServer: SYNAPSE_SERVER_NAME,
  };
}

async function deactivateMatrixAccount(matrixUserId) {
  const url = `${SYNAPSE_ADMIN_URL}/v1/deactivate/${encodeURIComponent(matrixUserId)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHAT_API_TOKEN}`,
      },
      body: JSON.stringify({ erase: false }), // preserve rooms for audit
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[webhooks] Synapse deactivate fetch failed: ${err.message}`);
    return false;
  }
}

// ── POST /api/v1/webhooks/identity/created ──
//
// Called by Windy Pro (account-server) the moment a Unified Identity is
// created. Provisions the Matrix account eagerly — no wait for the client
// to call /unified-login. Idempotent: returns "already_existed" on replay.
//
// Body: {
//   windy_identity_id: string (required),
//   first_name?: string,
//   last_name?: string,
//   username?: string,
//   email?: string,
//   display_name?: string,
//   passport_id?: string,
//   timestamp?: string
// }

router.post(
  '/identity/created',
  hmacMiddleware({ header: 'x-windy-signature', secret: IDENTITY_WEBHOOK_SECRET, name: 'identity' }),
  asyncHandler(async (req, res) => {
    const {
      windy_identity_id,
      first_name,
      last_name,
      username,
      email,
      display_name,
      passport_id,
    } = req.body || {};

    if (!windy_identity_id || typeof windy_identity_id !== 'string') {
      return res.status(400).json({ error: 'windy_identity_id is required' });
    }

    // Idempotency — return existing record on replay
    const existing = onboardingDb.getProfileByWindyId.get(windy_identity_id);
    if (existing) {
      const state = onboardingDb.getOnboardingState.get(existing.chat_user_id);
      return res.status(200).json({
        matrix_user_id: state ? state.matrix_user_id : `@${existing.chat_user_id}:${SYNAPSE_SERVER_NAME}`,
        status: 'already_existed',
        display_name: existing.display_name,
      });
    }

    const resolvedDisplayName = (display_name || [first_name, last_name].filter(Boolean).join(' ') || username || 'Windy user').slice(0, 100);
    const base = mailAlignedLocalpart({ firstName: first_name, lastName: last_name, username, email, displayName: resolvedDisplayName });
    const localpart = resolveUniqueLocalpart(base);

    let creds;
    try {
      creds = await provisionMatrixAccount(localpart, resolvedDisplayName);
    } catch (err) {
      console.error('[webhooks] identity/created provisioning failed:', err.message);
      return res.status(502).json({ error: 'Matrix provisioning failed' });
    }

    const now = new Date().toISOString();
    onboardingDb.upsertProfile.run({
      chat_user_id: localpart,
      windy_identity_id,
      display_name: resolvedDisplayName,
      languages: JSON.stringify(['en']),
      primary_language: 'en',
      avatar_url: null,
      created_at: now,
      onboarding_complete: 1,
    });
    onboardingDb.upsertOnboardingState.run({
      windy_user_id: localpart,
      verified: 1,
      profile_setup: 1,
      matrix_provisioned: 1,
      matrix_user_id: creds.matrixUserId,
      provisioned_at: now,
      passport_id: passport_id || null,
    });

    console.log(`[webhooks] identity/created: ${windy_identity_id} → ${creds.matrixUserId}`);

    return res.status(200).json({
      matrix_user_id: creds.matrixUserId,
      status: 'provisioned',
      display_name: resolvedDisplayName,
    });
  }),
);

// ── POST /api/v1/webhooks/passport/revoked ──
//
// Called by Eternitas when a passport is revoked. Deactivates the Matrix
// account (erase=false so rooms remain for audit).

router.post(
  '/passport/revoked',
  hmacMiddleware({ header: 'x-eternitas-signature', secret: ETERNITAS_WEBHOOK_SECRET, name: 'eternitas' }),
  asyncHandler(async (req, res) => {
    const passport = req.body?.passport || req.body?.passport_id;
    if (!passport || typeof passport !== 'string') {
      return res.status(400).json({ error: 'passport is required' });
    }

    let state = onboardingDb.getOnboardingStateByPassport.get(passport);
    if (!state) state = onboardingDb.getOnboardingState.get(`bot_${passport}`);
    if (!state || !state.matrix_user_id) {
      return res.status(404).json({ error: 'Passport not found', passport });
    }

    const ok = await deactivateMatrixAccount(state.matrix_user_id);
    if (!ok) {
      console.warn(`[webhooks] passport/revoked: Synapse deactivate failed for ${state.matrix_user_id}`);
    }

    // Flush the shared trust cache so the just-revoked passport can't pass
    // another gate check within the 5-min cache window. Safe to call even
    // when no entry exists.
    const trustCacheFlushed = await invalidateTrustCache(passport);

    console.log(`[webhooks] passport/revoked: ${passport} → deactivated ${state.matrix_user_id} (trust_cache_flushed=${trustCacheFlushed})`);

    return res.status(200).json({
      status: 'deactivated',
      matrix_user_id: state.matrix_user_id,
      passport,
      trust_cache_flushed: trustCacheFlushed,
    });
  }),
);

// ── POST /api/v1/webhooks/trust/changed ──
//
// Belt-and-suspenders: Eternitas fires this whenever a passport's
// trust_score, clearance_level, or allowed_actions change — not only on
// revocation. Handler just nukes the cache entry so the next gate check
// re-fetches the authoritative profile.

router.post(
  '/trust/changed',
  hmacMiddleware({ header: 'x-eternitas-signature', secret: ETERNITAS_WEBHOOK_SECRET, name: 'eternitas' }),
  asyncHandler(async (req, res) => {
    const passport = req.body?.passport || req.body?.passport_id;
    if (!passport || typeof passport !== 'string') {
      return res.status(400).json({ error: 'passport is required' });
    }
    const flushed = await invalidateTrustCache(passport);
    console.log(`[webhooks] trust/changed: ${passport} (cache_flushed=${flushed})`);
    return res.status(200).json({ status: 'cache_flushed', passport, flushed });
  }),
);

module.exports = router;
module.exports._internals = { mailAlignedLocalpart, verifyHmac };
