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
const { withKeyLock } = require('../../shared/keyed-lock');
const { deriveLocalpartForWindyId } = require('../../shared/localpart');

const onboardingDb = require('../lib/db');

const router = express.Router();

// ── Config ──
const WINDY_ACCOUNT_SERVER_URL = process.env.WINDY_ACCOUNT_SERVER_URL || 'http://localhost:8098';
const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_URL = process.env.SYNAPSE_ADMIN_URL || `${SYNAPSE_URL}/_synapse/admin`;
const SYNAPSE_REGISTRATION_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET || '';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windychat.ai';

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
  // Mail-aligned localpart charset: lowercase alnum + `._-` (intersection of
  // Matrix [a-z0-9._=/-] and Mail [a-z0-9._-]). Validator allows uppercase
  // input but matchers/storage normalize to lowercase. See
  // services/shared/localpart.js for the canonical algorithm.
  return typeof val === 'string' && val.length > 0 && val.length <= 255 && /^[a-zA-Z0-9._-]+$/.test(val);
}

// ── Helpers ──

/**
 * Generate a legacy `windy_*`-style localpart from a display name.
 *
 * **Status (2026-05-18):** RETAINED only for `resolveOwnerMatrixId`,
 * which constructs a Matrix ID forward from a `sub` claim WITHOUT
 * persisting a profile (fallback for agent-owner lookup when no
 * windy_identity_id is available). Real provision write-paths (the
 * /provision + /unified-login routes) now route through
 * `deriveLocalpartForWindyId` from services/shared/localpart.js,
 * which unifies on the mail-aligned style + atomically reuses an
 * existing chat_user_id for the same windy_identity_id (race-safe;
 * see docs/windy-chat-localpart-fresh-design-2026-05-17.md).
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
    signal: AbortSignal.timeout(10000),
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
    signal: AbortSignal.timeout(10000),
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

// ── DM Room Creation ──

/**
 * Create a DM room between an agent and its owner.
 * Tries Synapse admin API first, then Matrix client-server API with agent's access token.
 * Returns { room_id, success, error }
 */
async function createDMRoom(agentMatrixId, agentAccessToken, ownerMatrixId, agentName) {
  const roomName = `${agentName} & You`;
  const firstMessage = `Hey! I'm ${agentName}, your new Windy Fly agent. I just hatched! What would you like me to help with?`;

  let roomId = null;

  // Try 1: Synapse admin API
  if (SYNAPSE_REGISTRATION_SECRET) {
    try {
      const res = await fetch(`${SYNAPSE_ADMIN_URL}/v1/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CHAT_API_TOKEN}`,
        },
        body: JSON.stringify({
          creator: agentMatrixId,
          invite: [ownerMatrixId],
          is_direct: true,
          preset: 'trusted_private_chat',
          name: roomName,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        roomId = data.room_id;
      }
    } catch (err) {
      console.warn(`[dm-room] Synapse admin room creation failed: ${err.message}`);
    }
  }

  // Try 2: Matrix client-server API with agent's access token
  if (!roomId && agentAccessToken && !agentAccessToken.startsWith('dev_token_')) {
    try {
      const res = await fetch(`${SYNAPSE_URL}/_matrix/client/v3/createRoom`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentAccessToken}`,
        },
        body: JSON.stringify({
          invite: [ownerMatrixId],
          is_direct: true,
          preset: 'trusted_private_chat',
          name: roomName,
          initial_state: [{
            type: 'm.room.guest_access',
            state_key: '',
            content: { guest_access: 'forbidden' },
          }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        roomId = data.room_id;
      }
    } catch (err) {
      console.warn(`[dm-room] Matrix client room creation failed: ${err.message}`);
    }
  }

  // Try 3: Dev mode — generate a stub room ID (blocked in production)
  if (!roomId) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[dm-room] Failed to create DM room — no Synapse API available in production');
      return { room_id: null, success: false, error: 'DM room creation unavailable' };
    }
    roomId = `!dev_dm_${uuidv4().slice(0, 8)}:${SYNAPSE_SERVER_NAME}`;
    console.log(`[dm-room] Dev mode — stub room: ${roomId}`);
  }

  // Send first message (best effort, only if we have a real Synapse)
  if (agentAccessToken && !agentAccessToken.startsWith('dev_token_') && roomId && !roomId.startsWith('!dev_')) {
    try {
      const txnId = uuidv4();
      await fetch(`${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentAccessToken}`,
        },
        body: JSON.stringify({
          msgtype: 'm.text',
          body: firstMessage,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn(`[dm-room] Failed to send first message: ${err.message}`);
    }
  }

  return { room_id: roomId, success: true, error: null };
}

// ── Post-provision hook: seed pending agent DMs ──
//
// When an agent hatches before its owner has a Chat account, its welcome DM
// stays pending — agent_credentials.welcomed_at IS NULL. The first time the
// owner's Chat account is provisioned (via /unified-login or the
// /identity/created webhook), we flush every pending agent: create a DM
// room against the real owner Matrix ID, send the agent's welcome message,
// and mark welcomed_at. Safe to call on every login — the welcomed_at
// flag makes the flush idempotent.

const PUSH_BUS_URL = process.env.PUSH_BUS_URL || 'http://localhost:8103';
const PUSH_BUS_TOKEN = process.env.PUSH_BUS_TOKEN || '';

/**
 * Render the agent's first message in the bootcamp-demo tone:
 *   "Hi {owner}, I'm your agent. I just hatched at {time}. My passport
 *   is {passport}. What do you want me to help with first?"
 */
function renderAgentWelcome({ ownerName, hatchedAt, passportNumber }) {
  const name = ownerName || 'there';
  const when = hatchedAt
    ? new Date(hatchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'just now';
  const passport = passportNumber || 'pending';
  return `Hi ${name}, I'm your agent. I just hatched at ${when}. My passport is ${passport}. What do you want me to help with first?`;
}

/**
 * Publish an agent.hatched push event so the owner's phone buzzes the
 * moment their agent's welcome DM lands. Best-effort — failure to reach
 * the push gateway must not block the login response.
 */
async function publishHatchedPush({ ownerWindyId, agentName, roomId, avatarUrl, passportNumber }) {
  if (!PUSH_BUS_URL) return false;
  try {
    const body = {
      windy_identity_id: ownerWindyId,
      event_type: 'agent.hatched',
      title: 'Your agent just hatched!',
      body: `${agentName} is ready to chat — tap to say hi.`,
      deep_link: roomId ? `windychat://room/${roomId}` : null,
      room_id: roomId || null,
      agent_name: agentName,
      agent_avatar_url: avatarUrl || null,
      passport_number: passportNumber || null,
    };
    const res = await fetch(`${PUSH_BUS_URL}/api/v1/push/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Push-Bus-Token': PUSH_BUS_TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[provision] agent.hatched push failed: ${err.message}`);
    return false;
  }
}

/**
 * Seed any pending agent DMs for this owner. Called after the owner's
 * Matrix account is provisioned (first-login path) and after the
 * identity/created webhook. Idempotent via agent_credentials.welcomed_at.
 */
async function seedPendingAgentDMs({ ownerMatrixId, ownerWindyId, ownerName }) {
  if (!ownerMatrixId || !ownerWindyId) return { seeded: 0, rooms: [] };

  const pending = onboardingDb.getPendingAgentsForOwner.all(ownerWindyId);
  if (!pending.length) return { seeded: 0, rooms: [] };

  const rooms = [];
  for (const agent of pending) {
    try {
      // Reuse an existing room if one was already created (e.g. owner
      // signed in, came back later, agent had already opened a room).
      const existingRoom = onboardingDb.getAgentRoom.get(agent.agent_matrix_id, ownerWindyId);
      let roomId = existingRoom && !existingRoom.room_id.startsWith('!dev_')
        ? existingRoom.room_id
        : null;

      if (!roomId) {
        const created = await createDMRoom(
          agent.agent_matrix_id,
          agent.access_token,
          ownerMatrixId,
          agent.agent_name || 'Your agent',
        );
        roomId = created.room_id;
      }

      if (!roomId) {
        console.warn(`[provision] Could not establish DM room for agent ${agent.agent_matrix_id}`);
        continue;
      }

      const message = renderAgentWelcome({
        ownerName,
        hatchedAt: agent.hatched_at,
        passportNumber: agent.passport_number,
      });

      // Send the pre-seeded welcome as the agent. Dev-stub tokens skip the
      // network call but still satisfy the contract (room + seed tracked).
      if (agent.access_token && !agent.access_token.startsWith('dev_token_') && !roomId.startsWith('!dev_')) {
        try {
          const txnId = uuidv4();
          await fetch(`${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${agent.access_token}`,
            },
            body: JSON.stringify({ msgtype: 'm.text', body: message }),
            signal: AbortSignal.timeout(5000),
          });
        } catch (err) {
          console.warn(`[provision] Welcome send failed for ${agent.agent_matrix_id}: ${err.message}`);
        }
      }

      const now = new Date().toISOString();
      onboardingDb.upsertAgentRoom.run({
        agent_user_id: agent.agent_matrix_id,
        owner_user_id: ownerWindyId,
        room_id: roomId,
        agent_name: agent.agent_name,
        created_at: existingRoom?.created_at || now,
      });
      onboardingDb.markAgentWelcomed.run(now, agent.agent_matrix_id);

      // Fire the agent.hatched push so the owner's phone buzzes.
      publishHatchedPush({
        ownerWindyId,
        agentName: agent.agent_name || 'Your agent',
        roomId,
        avatarUrl: null,
        passportNumber: agent.passport_number,
      }).catch(() => { /* already logged */ });

      rooms.push({
        agent_matrix_id: agent.agent_matrix_id,
        room_id: roomId,
        agent_name: agent.agent_name,
        message,
      });
    } catch (err) {
      console.error(`[provision] seedPendingAgentDMs failed for ${agent.agent_matrix_id}:`, err.message);
    }
  }

  console.log(`[provision] Seeded ${rooms.length}/${pending.length} pending agent DM(s) for owner ${ownerWindyId}`);
  return { seeded: rooms.length, rooms };
}

/**
 * Look up an owner's Matrix user ID from their windy_identity_id or sub claim.
 * Returns the Matrix user ID or null if not found.
 */
function resolveOwnerMatrixId(ownerSub, ownerWindyId) {
  // Try looking up by windy_identity_id first
  if (ownerWindyId) {
    const profile = onboardingDb.getProfileByWindyId.get(ownerWindyId);
    if (profile) {
      const state = onboardingDb.getOnboardingState.get(profile.chat_user_id);
      if (state && state.matrix_user_id) return state.matrix_user_id;
      return `@${profile.chat_user_id}:${SYNAPSE_SERVER_NAME}`;
    }
  }
  // Construct from sub
  if (ownerSub) {
    const localpart = displayNameToLocalpart(ownerSub);
    return `@${localpart}:${SYNAPSE_SERVER_NAME}`;
  }
  return null;
}

// ── GET /api/v1/chat/agent-room ──

router.get('/agent-room', (req, res) => {
  const { agentId, ownerId } = req.query;

  if (!agentId || typeof agentId !== 'string') {
    return res.status(400).json({ error: 'agentId query param required' });
  }
  if (!ownerId || typeof ownerId !== 'string') {
    return res.status(400).json({ error: 'ownerId query param required' });
  }

  const room = onboardingDb.getAgentRoom.get(agentId, ownerId);
  if (!room) {
    return res.status(404).json({ error: 'No DM room found between agent and owner' });
  }

  res.json({
    agent_user_id: room.agent_user_id,
    owner_user_id: room.owner_user_id,
    room_id: room.room_id,
    agent_name: room.agent_name,
    created_at: room.created_at,
  });
});

// ── /eternitas/webhook — RETIRED (P2-1) ──
//
// This endpoint was the pre-Wave-2 Eternitas webhook handler. Its Matrix
// deactivate / lock / unlock logic is a subset of what the canonical
// `/api/v1/webhooks/eternitas` handler in services/social already does
// (which additionally marks social posts as suspended, removes the bot
// from rooms, flushes the trust cache, and updates the verified badge).
//
// Retired per P2-1 of the Wave-7 gap analysis — three redundant Eternitas
// webhook handlers made it easy for Eternitas config drift to point at
// a subset-of-behavior endpoint. Keeping the URL live with a 410 Gone
// so any producer still configured against it gets a clear signal
// rather than silent dropping.
router.post('/eternitas/webhook', (req, res) => {
  console.warn(
    `[onboarding] /eternitas/webhook is retired (P2-1). ` +
    `Caller should use /api/v1/webhooks/eternitas on the social service ` +
    `(see .env.example ETERNITAS_WEBHOOK_URL). ` +
    `event=${req.body?.event || 'unknown'} passport=${req.body?.passport || 'unknown'}`
  );
  res.status(410).json({
    error: 'This endpoint has been retired. Use /api/v1/webhooks/eternitas on the social service (port 8105). See eternitas/docs/webhooks.md for the current contract.',
    moved_to: '/api/v1/webhooks/eternitas',
    code: 'ENDPOINT_RETIRED',
  });
});

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

    // Race-safe localpart derivation: if this windy_identity_id already
    // has a chat_user_id (e.g., webhook fired first), reuse it. Otherwise
    // derive a fresh mail-aligned localpart. Single source of truth shared
    // with /webhooks/identity/created. See
    // docs/windy-chat-localpart-fresh-design-2026-05-17.md.
    const windyIdentityId = req.user && req.user.windy_identity_id ? req.user.windy_identity_id : chatUserId;
    const { chatUserId: localpart } = deriveLocalpartForWindyId({
      db: onboardingDb.db,
      windyIdentityId,
      displayName: sanitizedDisplayName,
    });
    const matrixUserId = `@${localpart}:${SYNAPSE_SERVER_NAME}`;

    let matrixCredentials;

    // Try 1: Provision via Windy Pro account-server (preferred — single source of truth)
    if (CHAT_API_TOKEN && WINDY_ACCOUNT_SERVER_URL) {
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

    // Try 3: Dev mode stub (blocked in production)
    if (!matrixCredentials) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({
          error: 'Chat provisioning unavailable — no account-server or Synapse configured',
        });
      }
      console.warn('⚠️  No provisioning method available — returning dev stub credentials (NODE_ENV != production)');
      matrixCredentials = {
        matrixUserId,
        accessToken: `dev_token_${uuidv4()}`,
        deviceId: `dev_device_${uuidv4().slice(0, 8)}`,
        homeServer: SYNAPSE_SERVER_NAME,
        _dev: true,
      };
    }

    // Update onboarding state in SQLite
    const passportId = req.user && (req.user.passport_id || req.user.eternitas_passport) || null;
    onboardingDb.upsertOnboardingState.run({
      windy_user_id: chatUserId,
      verified: 1,
      profile_setup: 1,
      matrix_provisioned: 1,
      matrix_user_id: matrixCredentials.matrixUserId,
      provisioned_at: new Date().toISOString(),
      passport_id: passportId,
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

// ── POST /api/v1/onboarding/unified-login ──
// "One click and you're in Chat" — seamless first-time provisioning from Windy Pro JWT.

router.post('/unified-login', asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user || !user.sub) {
    return res.status(401).json({ error: 'Valid JWT required' });
  }

  const windyIdentityId = user.windy_identity_id;
  const email = user.email || null;
  const displayName = user.display_name || user.sub;

  if (!windyIdentityId) {
    return res.status(400).json({ error: 'JWT missing windy_identity_id claim' });
  }

  // Serialize concurrent first-login bursts for the same identity. Before
  // this guard, 20 simultaneous requests for the same new user would
  // race past the getProfileByWindyId lookup, all run the provisioning
  // branch, and mint 20 different Matrix accounts / access_tokens with
  // 19 orphaned in Synapse (P1-1).
  //
  // Under the lock, request #1 provisions + writes the profile row;
  // requests #2-20 block until #1 releases, then see the existing row
  // and return `already_existed: true` without minting new credentials.
  return withKeyLock(`unified-login:${windyIdentityId}`, async () => {
  // Check if user already has a Chat profile (by windy_identity_id)
  const existing = onboardingDb.getProfileByWindyId.get(windyIdentityId);

  if (existing) {
    // Already provisioned — return existing credentials
    const state = onboardingDb.getOnboardingState.get(existing.chat_user_id);
    return res.json({
      matrix_user_id: state ? state.matrix_user_id : null,
      access_token: null, // Cannot re-issue Matrix tokens; client must re-auth via Matrix login
      home_server: SYNAPSE_SERVER_NAME,
      display_name: existing.display_name,
      already_existed: true,
      windy_identity_id: windyIdentityId,
      chat_user_id: existing.chat_user_id,
    });
  }

  // New user — provision via unified localpart derivation (mail-aligned;
  // race-safe with the /webhooks path). See
  // docs/windy-chat-localpart-fresh-design-2026-05-17.md.
  const sanitizedName = stripHtml(displayName);
  const { chatUserId: localpart } = deriveLocalpartForWindyId({
    db: onboardingDb.db,
    windyIdentityId,
    displayName: sanitizedName,
  });
  const chatUserId = localpart;
  const matrixUserId = `@${localpart}:${SYNAPSE_SERVER_NAME}`;

  let matrixCredentials;

  // Try account-server first, then direct Synapse, then stub
  if (CHAT_API_TOKEN && WINDY_ACCOUNT_SERVER_URL) {
    try {
      matrixCredentials = await provisionViaAccountServer(windyIdentityId, sanitizedName, null);
    } catch (err) {
      console.warn(`[unified-login] Account-server failed: ${err.message}`);
    }
  }

  if (!matrixCredentials && SYNAPSE_REGISTRATION_SECRET) {
    try {
      matrixCredentials = await provisionMatrixAccount(localpart, sanitizedName);
    } catch (err) {
      console.warn(`[unified-login] Synapse admin failed: ${err.message}`);
    }
  }

  if (!matrixCredentials) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        error: 'Chat provisioning unavailable — no account-server or Synapse configured',
      });
    }
    console.warn('[unified-login] No provisioning method — returning dev stub (NODE_ENV != production)');
    matrixCredentials = {
      matrixUserId,
      accessToken: `dev_token_${uuidv4()}`,
      deviceId: `dev_device_${uuidv4().slice(0, 8)}`,
      homeServer: SYNAPSE_SERVER_NAME,
      _dev: true,
    };
  }

  // Store profile
  onboardingDb.upsertProfile.run({
    chat_user_id: chatUserId,
    windy_identity_id: windyIdentityId,
    display_name: sanitizedName,
    languages: JSON.stringify(['en']),
    primary_language: 'en',
    avatar_url: null,
    created_at: new Date().toISOString(),
    onboarding_complete: 1,
  });

  // Store onboarding state
  const passportId = user.passport_id || user.eternitas_passport || null;
  onboardingDb.upsertOnboardingState.run({
    windy_user_id: chatUserId,
    verified: 1,
    profile_setup: 1,
    matrix_provisioned: 1,
    matrix_user_id: matrixCredentials.matrixUserId,
    provisioned_at: new Date().toISOString(),
    passport_id: passportId,
  });

  console.log(`[unified-login] New user: ${sanitizedName} (${windyIdentityId}) → ${matrixCredentials.matrixUserId}`);

  // Post-provisioning: create DM room if this is an agent and owner exists
  let dmRoom = null;
  const ownerSub = user.owner_sub || null;
  const ownerWindyId = user.owner_windy_identity_id || null;

  if (ownerSub || ownerWindyId) {
    const ownerMatrixId = resolveOwnerMatrixId(ownerSub, ownerWindyId);
    if (ownerMatrixId) {
      try {
        dmRoom = await createDMRoom(
          matrixCredentials.matrixUserId,
          matrixCredentials.accessToken,
          ownerMatrixId,
          sanitizedName
        );
        if (dmRoom.room_id) {
          onboardingDb.upsertAgentRoom.run({
            agent_user_id: chatUserId,
            owner_user_id: ownerSub || ownerWindyId,
            room_id: dmRoom.room_id,
            agent_name: sanitizedName,
            created_at: new Date().toISOString(),
          });
          console.log(`[unified-login] DM room created: ${dmRoom.room_id} (${sanitizedName} ↔ ${ownerMatrixId})`);
        }
      } catch (err) {
        console.warn(`[unified-login] DM room creation failed: ${err.message}`);
      }
    } else {
      console.log(`[unified-login] Owner not yet in Chat — skipping DM room creation`);
    }
  }

  // Post-provision hook: flush any agents that hatched before this owner
  // had a Chat account. Best-effort — errors are logged inside the helper.
  const pendingSeed = await seedPendingAgentDMs({
    ownerMatrixId: matrixCredentials.matrixUserId,
    ownerWindyId: windyIdentityId,
    ownerName: sanitizedName,
  });

  res.status(201).json({
    matrix_user_id: matrixCredentials.matrixUserId,
    access_token: matrixCredentials.accessToken,
    home_server: matrixCredentials.homeServer || SYNAPSE_SERVER_NAME,
    display_name: sanitizedName,
    already_existed: false,
    windy_identity_id: windyIdentityId,
    chat_user_id: chatUserId,
    room_id: dmRoom ? dmRoom.room_id : null,
    seeded_agent_rooms: pendingSeed.rooms,
  });
  }); // close withKeyLock
}));

module.exports = router;
module.exports.seedPendingAgentDMs = seedPendingAgentDMs;
module.exports.renderAgentWelcome = renderAgentWelcome;
module.exports.publishHatchedPush = publishHatchedPush;
