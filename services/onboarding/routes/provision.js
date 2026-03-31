/**
 * Windy Chat —  Matrix Account Provisioning Routes
 * K2.4: Onboarding Completion (DNA Strand K)
 *
 * Endpoints:
 *   POST /api/v1/chat/provision        — provision Matrix account via Synapse admin API
 *   GET  /api/v1/chat/onboarding/status — check onboarding completion state
 *
 * Flow:
 *   1. User verifies phone/email (K2.1) ✅
 *   2. User sets display name + languages (K2.2) ✅
 *   3. This service provisions a Matrix account on our Synapse (K1)
 *   4. Returns Matrix credentials to the client
 *
 * The Synapse admin API (/_synapse/admin/v1/register) is used with a
 * shared secret to create accounts. Direct Matrix registration is disabled.
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../shared/async-handler');

const onboardingDb = require('../lib/db');

const router = express.Router();

// ── Config ──
const WINDY_ACCOUNT_SERVER_URL = process.env.WINDY_ACCOUNT_SERVER_URL || 'http://localhost:8098';
const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_URL = process.env.SYNAPSE_ADMIN_URL || `${SYNAPSE_URL}/_synapse/admin`;
const SYNAPSE_REGISTRATION_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET || '';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windypro.com';

// ── Per-route rate limiter for provisioning (login-like, sensitive) ──
const provisionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many provisioning requests. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Input validation helpers ──

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

function isValidUserId(val) {
  return typeof val === 'string' && val.length > 0 && val.length <= 255 && /^[a-zA-Z0-9_-]+$/.test(val);
}

// ── Helpers ──

/**
 * Generate a Matrix-safe localpart from a display name.
 * Matrix localpart: [a-z0-9._=/-]
 */
function displayNameToLocalpart(displayName) {
  const base = displayName
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9._/-]/g, '')
    .slice(0, 32);

  if (base.length >= 3) {
    return `windy_${base}`;
  }

  // Fallback: hash-based
  const hash = crypto.createHash('sha256').update(displayName).digest('hex').slice(0, 12);
  return `windy_${hash}`;
}

/**
 * Generate HMAC for Synapse shared-secret registration.
 * See: https://element-hq.github.io/synapse/latest/admin_api/register_api.html
 */
function generateRegistrationMac(nonce, username, password, admin = false) {
  const hmac = crypto.createHmac('sha1', SYNAPSE_REGISTRATION_SECRET);
  hmac.update(nonce);
  hmac.update('\x00');
  hmac.update(username);
  hmac.update('\x00');
  hmac.update(password);
  hmac.update('\x00');
  hmac.update(admin ? 'admin' : 'notadmin');
  return hmac.digest('hex');
}

/**
 * Provision a new Matrix account on our Synapse homeserver.
 *
 * Uses the Synapse admin registration API with shared-secret HMAC:
 *   1. GET /_synapse/admin/v1/register → get nonce
 *   2. POST /_synapse/admin/v1/register → create user with HMAC
 */
async function provisionMatrixAccount(localpart, displayName) {
  // Step 1: Get nonce
  const nonceRes = await fetch(`${SYNAPSE_ADMIN_URL}/v1/register`, {
    method: 'GET',
  });

  if (!nonceRes.ok) {
    throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  }

  const { nonce } = await nonceRes.json();

  // Generate a random password (user logs in via Windy auth, not Matrix password)
  const password = crypto.randomBytes(32).toString('hex');

  // Generate HMAC
  const mac = generateRegistrationMac(nonce, localpart, password, false);

  // Step 2: Register
  const regRes = await fetch(`${SYNAPSE_ADMIN_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce,
      username: localpart,
      password,
      displayname: displayName,
      admin: false,
      mac,
    }),
  });

  if (!regRes.ok) {
    throw new Error(`Synapse registration failed: ${regRes.status}`);
  }

  const result = await regRes.json();

  return {
    matrixUserId: result.user_id || `@${localpart}:${SYNAPSE_SERVER_NAME}`,
    accessToken: result.access_token,
    deviceId: result.device_id,
    homeServer: SYNAPSE_SERVER_NAME,
  };
}

/**
 * Provision via Windy Pro account-server (preferred path).
 * The account-server is the single source of truth for identity and handles
 * the Synapse admin API call internally.
 *
 * POST {WINDY_ACCOUNT_SERVER_URL}/api/v1/identity/chat/provision
 * Body: { windy_identity_id, display_name, avatar_url }
 * Returns: { matrix_user_id, access_token, device_id, home_server }
 */
async function provisionViaAccountServer(windyIdentityId, displayName, avatarUrl) {
  const url = `${WINDY_ACCOUNT_SERVER_URL}/api/v1/identity/chat/provision`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHAT_API_TOKEN}`,
    },
    body: JSON.stringify({
      windy_identity_id: windyIdentityId,
      display_name: displayName,
      avatar_url: avatarUrl || null,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Account-server provision failed: ${res.status} ${body.error || ''}`);
  }

  const result = await res.json();
  return {
    matrixUserId: result.matrix_user_id,
    accessToken: result.access_token,
    deviceId: result.device_id,
    homeServer: result.home_server || SYNAPSE_SERVER_NAME,
  };
}

// ── POST /api/v1/chat/provision ──

router.post('/', provisionLimiter, asyncHandler(async (req, res) => {
  try {
    const { chatUserId, displayName, verificationToken } = req.body;

    // Input validation
    if (!chatUserId || !isValidUserId(chatUserId)) {
      return res.status(400).json({
        error: 'chatUserId is required, alphanumeric + hyphens/underscores, max 255 chars',
        hint: 'Complete profile setup (K2.2) first',
      });
    }

    if (!displayName || typeof displayName !== 'string' || displayName.length > 100) {
      return res.status(400).json({
        error: 'displayName is required, max 100 characters',
      });
    }

    if (!verificationToken || typeof verificationToken !== 'string' || verificationToken.length > 255) {
      return res.status(401).json({
        error: 'Verification required',
        hint: 'Complete phone/email verification (K2.1) first',
      });
    }

    const sanitizedDisplayName = stripHtml(displayName);

    // Generate Matrix localpart from display name
    const localpart = displayNameToLocalpart(sanitizedDisplayName);
    const matrixUserId = `@${localpart}:${SYNAPSE_SERVER_NAME}`;

    let matrixCredentials;
    const windyIdentityId = req.user && req.user.windy_identity_id ? req.user.windy_identity_id : chatUserId;

    // Try 1: Provision via Windy Pro account-server (preferred — single source of truth)
    if (CHAT_API_TOKEN && WINDY_ACCOUNT_SERVER_URL !== 'http://localhost:8098') {
      try {
        matrixCredentials = await provisionViaAccountServer(windyIdentityId, sanitizedDisplayName, null);
        console.log(`🏠 Provisioned via account-server: ${sanitizedDisplayName} → ${matrixCredentials.matrixUserId}`);
      } catch (err) {
        console.warn(`Account-server provision failed (${err.message}), falling back to direct Synapse`);
      }
    }

    // Try 2: Direct Synapse admin API (fallback for dev or when account-server is down)
    if (!matrixCredentials && SYNAPSE_REGISTRATION_SECRET) {
      try {
        matrixCredentials = await provisionMatrixAccount(localpart, sanitizedDisplayName);
        console.log(`🏠 Provisioned via Synapse admin: ${sanitizedDisplayName} → ${matrixCredentials.matrixUserId}`);
      } catch (err) {
        console.error('Matrix provisioning failed:', err.message);
        return res.status(502).json({
          error: 'Failed to provision Matrix account',
          hint: 'Is the Synapse homeserver running? Check deploy/synapse/',
        });
      }
    }

    // Try 3: Dev mode stub
    if (!matrixCredentials) {
      console.warn('⚠️  No provisioning method available — returning stub credentials');
      matrixCredentials = {
        matrixUserId,
        accessToken: `dev_token_${uuidv4()}`,
        deviceId: `dev_device_${uuidv4().slice(0, 8)}`,
        homeServer: SYNAPSE_SERVER_NAME,
        _dev: 'Stub credentials (no account-server or Synapse configured)',
      };
    }

    // Update onboarding state in SQLite
    onboardingDb.upsertOnboardingState.run({
      windy_user_id: chatUserId,
      verified: 1,
      profile_setup: 1,
      matrix_provisioned: 1,
      matrix_user_id: matrixCredentials.matrixUserId,
      provisioned_at: new Date().toISOString(),
    });

    console.log(`🏠 Matrix account provisioned: ${sanitizedDisplayName} → ${matrixCredentials.matrixUserId}`);

    res.status(201).json({
      success: true,
      matrix: matrixCredentials,
      onboarding: {
        complete: true,
        steps: {
          verified: true,
          profileSetup: true,
          matrixProvisioned: true,
        },
      },
      message: `Welcome to Windy Chat, ${sanitizedDisplayName}! Your account is ready.`,
    });

  } catch (err) {
    console.error('Provision error:', err);
    res.status(500).json({ error: 'Account provisioning failed' });
  }
}));

// ── GET /api/v1/chat/onboarding/status ──

router.get('/onboarding/status', (req, res) => {
  try {
    const { chatUserId } = req.query;

    if (!chatUserId) {
      return res.status(400).json({ error: 'chatUserId query param required' });
    }

    if (!isValidUserId(chatUserId)) {
      return res.status(400).json({ error: 'chatUserId must be alphanumeric + hyphens/underscores, max 255 chars' });
    }

    const row = onboardingDb.getOnboardingState.get(chatUserId);

    if (!row) {
      return res.json({
        chatUserId,
        complete: false,
        steps: {
          verified: false,
          profileSetup: false,
          matrixProvisioned: false,
        },
        nextStep: 'verify',
        message: 'Start by verifying your phone or email',
      });
    }

    const state = {
      verified: !!row.verified,
      profileSetup: !!row.profile_setup,
      matrixProvisioned: !!row.matrix_provisioned,
      matrixUserId: row.matrix_user_id,
      provisionedAt: row.provisioned_at,
    };

    const nextStep = !state.verified ? 'verify'
      : !state.profileSetup ? 'profile'
      : !state.matrixProvisioned ? 'provision'
      : null;

    res.json({
      chatUserId,
      complete: state.matrixProvisioned,
      matrixUserId: state.matrixUserId || null,
      steps: {
        verified: state.verified,
        profileSetup: state.profileSetup,
        matrixProvisioned: state.matrixProvisioned,
      },
      nextStep,
      provisionedAt: state.provisionedAt || null,
    });
  } catch (err) {
    console.error('Onboarding status error:', err);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

module.exports = router;
