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
const adminTelemetry = require('../../shared/admin-telemetry');
const {
  deriveLocalpartForWindyId,
  mailAlignedLocalpart: sharedMailAlignedLocalpart,
} = require('../../shared/localpart');

const onboardingDb = require('../lib/db');

const router = express.Router();

// ── Config ──
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_URL = process.env.SYNAPSE_ADMIN_URL || `${SYNAPSE_URL}/_synapse/admin`;
const SYNAPSE_REGISTRATION_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET || '';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windychat.ai';
const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN || '';

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
 * the signature header. Skipping auth when the secret is unset is *only*
 * allowed outside production — matches the behavior in provision.js.
 */
function hmacMiddleware({ header, secret, name }) {
  return (req, res, next) => {
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: `${name} webhook secret not configured` });
      }
      console.warn(`[webhooks] ${name} secret not set — skipping signature verification (NODE_ENV != production)`);
      return next();
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

// mailAlignedLocalpart + resolveUniqueLocalpart moved to
// services/shared/localpart.js (2026-05-18 unification — single source
// of truth between this webhook path and the /provision path so the
// same windy_identity_id always gets the same @handle regardless of
// which route fires first). Local symbol kept as a thin re-export
// for the test surface that exposes _internals.
const mailAlignedLocalpart = sharedMailAlignedLocalpart;

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
  // The Synapse admin API only accepts a server-admin USER token
  // (SYNAPSE_ADMIN_TOKEN, @windy_service_admin). CHAT_API_TOKEN is chat's
  // internal service token — Synapse rejects it with M_UNKNOWN_TOKEN, which
  // silently broke every passport-revoked deactivation until 2026-07-05.
  // server.js and social/eternitas-webhook.js already use the admin token.
  if (!SYNAPSE_ADMIN_TOKEN) {
    console.warn(`[webhooks] Synapse deactivate skipped for ${matrixUserId}: SYNAPSE_ADMIN_TOKEN not set`);
    return false;
  }
  const url = `${SYNAPSE_ADMIN_URL}/v1/deactivate/${encodeURIComponent(matrixUserId)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ erase: false }), // preserve rooms for audit
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[webhooks] Synapse deactivate ${res.status} for ${matrixUserId}`);
    }
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
      adminTelemetry.emit({
        service: 'chat-onboarding',
        event_type: 'hatch.owner_chat_provisioned',
        actor_type: 'human',
        actor_id: windy_identity_id,
        metadata: { already_existed: true, via: 'identity_webhook' },
      });
      return res.status(200).json({
        matrix_user_id: state ? state.matrix_user_id : `@${existing.chat_user_id}:${SYNAPSE_SERVER_NAME}`,
        status: 'already_existed',
        display_name: existing.display_name,
      });
    }

    const resolvedDisplayName = (display_name || [first_name, last_name].filter(Boolean).join(' ') || username || 'Windy user').slice(0, 100);
    // Unified entry point — race-safe with the /provision path. If
    // /provision already created a profile for this windy_identity_id,
    // we reuse it; otherwise we derive a fresh mail-aligned localpart.
    const { chatUserId: localpart } = deriveLocalpartForWindyId({
      db: onboardingDb.db,
      windyIdentityId: windy_identity_id,
      firstName: first_name,
      lastName: last_name,
      username,
      email,
      displayName: resolvedDisplayName,
    });

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

    // Hatch-funnel beat (ADR-WA-001 §3), mirroring provision.js: the
    // human's chat identity exists. Most owners are provisioned through
    // THIS eager webhook (signup → identity.created), not /provision —
    // without this emit the funnel undercounts owners to near zero.
    adminTelemetry.emit({
      service: 'chat-onboarding',
      event_type: 'hatch.owner_chat_provisioned',
      actor_type: 'human',
      actor_id: windy_identity_id,
      metadata: { already_existed: false, via: 'identity_webhook' },
    });

    // Post-provision hook — flush pending agent DM welcomes. If this owner
    // had agents hatch before they existed in Chat, their rooms + seeded
    // welcome messages land here. Lazy-required to avoid a circular import
    // when provision.js pulls from the same db module at startup.
    let seeded = [];
    try {
      const { seedPendingAgentDMs } = require('./provision');
      const result = await seedPendingAgentDMs({
        ownerMatrixId: creds.matrixUserId,
        ownerWindyId: windy_identity_id,
        ownerName: resolvedDisplayName,
      });
      seeded = result.rooms;
    } catch (err) {
      console.warn(`[webhooks] identity/created: seedPendingAgentDMs failed: ${err.message}`);
    }

    return res.status(200).json({
      matrix_user_id: creds.matrixUserId,
      status: 'provisioned',
      display_name: resolvedDisplayName,
      seeded_agent_rooms: seeded,
    });
  }),
);

// Farewell text posted into the agent's rooms just before deactivation.
// Without it, revocation leaves the owner messaging a silent ghost — the
// DM simply never answers again with no explanation (grandma-lifecycle
// stress finding, 2026-07-08). Warm, jargon-free, and honest.
const RETIREMENT_FAREWELL =
  "This agent has been retired and can't reply anymore. Your conversation " +
  'history stays right here. You can hatch a new agent anytime from your ' +
  'Windy account.';

/**
 * Post a retirement notice into every room the agent is joined to, AS the
 * agent, right before deactivation. Uses the Synapse admin login-as API to
 * mint a token; deactivation immediately afterwards invalidates it.
 * Best-effort: any failure is logged and returns the count posted so far —
 * a missing farewell must never block the revocation itself.
 */
async function postRetirementFarewell(matrixUserId) {
  if (!SYNAPSE_ADMIN_TOKEN) return 0;
  const adminHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
  };
  let posted = 0;
  try {
    const loginRes = await fetch(
      `${SYNAPSE_ADMIN_URL}/v1/users/${encodeURIComponent(matrixUserId)}/login`,
      { method: 'POST', headers: adminHeaders, body: JSON.stringify({}), signal: AbortSignal.timeout(10000) },
    );
    if (!loginRes.ok) return 0;
    const agentToken = (await loginRes.json()).access_token;
    if (!agentToken) return 0;

    const roomsRes = await fetch(
      `${SYNAPSE_ADMIN_URL}/v1/users/${encodeURIComponent(matrixUserId)}/joined_rooms`,
      { headers: adminHeaders, signal: AbortSignal.timeout(10000) },
    );
    if (!roomsRes.ok) return 0;
    // Agents live in their owner DM plus at most a handful of rooms; the
    // slice is a runaway guard, not a policy.
    const rooms = ((await roomsRes.json()).joined_rooms || []).slice(0, 20);
    for (const roomId of rooms) {
      const txn = `retire${Date.now()}_${posted}`;
      const res = await fetch(
        `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
          body: JSON.stringify({ msgtype: 'm.notice', body: RETIREMENT_FAREWELL }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (res.ok) posted += 1;
    }
  } catch (err) {
    console.warn(`[webhooks] retirement farewell failed for ${matrixUserId}: ${err.message}`);
  }
  return posted;
}

// ── POST /api/v1/webhooks/passport/revoked ──
//
// Called by Eternitas when a passport is revoked. Posts a farewell notice
// into the agent's rooms, then deactivates the Matrix account
// (erase=false so rooms remain for audit).

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

    const farewellsPosted = await postRetirementFarewell(state.matrix_user_id);

    const ok = await deactivateMatrixAccount(state.matrix_user_id);
    if (!ok) {
      console.warn(`[webhooks] passport/revoked: Synapse deactivate failed for ${state.matrix_user_id}`);
    }

    // Delete the roster credentials row so the agent-roster reconciler
    // prunes the runner (otherwise it 401-loops against the deactivated
    // account until the next service restart).
    const credentialsDeleted = onboardingDb.deleteAgentCredentialsByPassport.run(passport).changes;

    // Flush the shared trust cache so the just-revoked passport can't pass
    // another gate check within the 5-min cache window. Safe to call even
    // when no entry exists.
    const trustCacheFlushed = await invalidateTrustCache(passport);

    console.log(`[webhooks] passport/revoked: ${passport} → deactivated ${state.matrix_user_id} (farewells=${farewellsPosted}, credentials_deleted=${credentialsDeleted}, trust_cache_flushed=${trustCacheFlushed})`);

    return res.status(200).json({
      status: 'deactivated',
      matrix_user_id: state.matrix_user_id,
      passport,
      farewells_posted: farewellsPosted,
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

// ── POST /api/v1/webhooks/eternitas ──
//
// Unified Eternitas receiver. Eternitas dispatches ALL events for a platform to
// ONE webhook_url with the type in the X-Eternitas-Event header (it does NOT
// append per-event paths like /passport/revoked). Every other platform
// (Mail/Search/etc.) registers a single /webhooks endpoint; chat had only the
// per-event handlers above and was never registered, so revocations never
// reached Matrix. Register chat's platform webhook_url here and route by event:
// passport revoke/suspend → deactivate the Matrix account; any trust/integrity
// change → flush the shared trust cache.
router.post(
  '/eternitas',
  hmacMiddleware({ header: 'x-eternitas-signature', secret: ETERNITAS_WEBHOOK_SECRET, name: 'eternitas' }),
  asyncHandler(async (req, res) => {
    const event = String(req.get('x-eternitas-event') || req.body?.event || '').toLowerCase();
    const passport = req.body?.passport || req.body?.passport_id;
    if (!passport || typeof passport !== 'string') {
      return res.status(400).json({ error: 'passport is required' });
    }

    const isRevocation =
      event.startsWith('passport.revoked') || event.startsWith('passport.suspended');
    let deactivated = false;
    let matrixUserId = null;
    let farewellsPosted = 0;
    if (isRevocation) {
      let state = onboardingDb.getOnboardingStateByPassport.get(passport);
      if (!state) state = onboardingDb.getOnboardingState.get(`bot_${passport}`);
      if (state && state.matrix_user_id) {
        matrixUserId = state.matrix_user_id;
        farewellsPosted = await postRetirementFarewell(matrixUserId);
        deactivated = await deactivateMatrixAccount(matrixUserId);
        if (!deactivated) {
          console.warn(`[webhooks] eternitas ${event}: Synapse deactivate failed for ${matrixUserId}`);
        }
      }
      // Roster cleanup regardless of whether chat had a Matrix account —
      // the reconciler prunes the runner once this row is gone.
      const credentialsDeleted = onboardingDb.deleteAgentCredentialsByPassport.run(passport).changes;
      if (credentialsDeleted) {
        console.log(`[webhooks] eternitas ${event}: pruned ${credentialsDeleted} roster credentials row(s) for ${passport}`);
      }
    }

    // Always flush so the next trust-gate check re-fetches the authoritative
    // profile within the 5-min cache window (safe even when no entry exists).
    const trustCacheFlushed = await invalidateTrustCache(passport);
    console.log(
      `[webhooks] eternitas ${event}: ${passport} (deactivated=${deactivated} matrix=${matrixUserId} farewells=${farewellsPosted} cache_flushed=${trustCacheFlushed})`,
    );

    return res.status(200).json({
      status: 'ok',
      event,
      passport,
      deactivated,
      matrix_user_id: matrixUserId,
      farewells_posted: farewellsPosted,
      trust_cache_flushed: trustCacheFlushed,
    });
  }),
);

module.exports = router;
module.exports._internals = { mailAlignedLocalpart, verifyHmac };
