/**
 * Windy Chat — Bot/Agent Provisioning Route
 *
 * Service-to-service endpoint for provisioning Matrix accounts for
 * agents hatched via `windy go`. No OTP needed — trust is via
 * CHAT_SERVICE_TOKEN.
 *
 * POST /api/v1/onboarding/agent
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../shared/async-handler');
const onboardingDb = require('../lib/db');

const router = express.Router();

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_URL = process.env.SYNAPSE_ADMIN_URL || `${SYNAPSE_URL}/_synapse/admin`;
const SYNAPSE_REGISTRATION_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET || '';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windyword.ai';
const CHAT_SERVICE_TOKEN = process.env.CHAT_SERVICE_TOKEN || process.env.CHAT_API_TOKEN || '';

const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many agent provisioning requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Service token auth middleware.
 * Only accepts CHAT_SERVICE_TOKEN — not JWTs.
 */
function serviceTokenAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!CHAT_SERVICE_TOKEN || token !== CHAT_SERVICE_TOKEN) {
    return res.status(403).json({ error: 'Invalid service token' });
  }
  next();
}

/**
 * Generate HMAC for Synapse shared-secret registration.
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
 * Provision a Matrix account for an agent via Synapse admin API.
 */
async function provisionAgentMatrix(localpart, displayName) {
  if (!SYNAPSE_REGISTRATION_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SYNAPSE_REGISTRATION_SECRET not configured');
    }
    // Dev stub
    const matrixUserId = `@${localpart}:${SYNAPSE_SERVER_NAME}`;
    console.warn(`[agent-provision] Dev mode — stub Matrix account: ${matrixUserId}`);
    return {
      matrixUserId,
      accessToken: `dev_token_${uuidv4().slice(0, 16)}`,
      deviceId: `dev_device_${uuidv4().slice(0, 8)}`,
    };
  }

  // Step 1: Get nonce
  const nonceRes = await fetch(`${SYNAPSE_ADMIN_URL}/v1/register`, {
    method: 'GET',
    signal: AbortSignal.timeout(10000),
  });
  if (!nonceRes.ok) throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  const { nonce } = await nonceRes.json();

  // Step 2: Register with HMAC
  const password = crypto.randomBytes(32).toString('base64url');
  const mac = generateRegistrationMac(nonce, localpart, password, false);

  const regRes = await fetch(`${SYNAPSE_ADMIN_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce,
      username: localpart,
      displayname: displayName,
      password,
      mac,
      admin: false,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!regRes.ok) {
    const errBody = await regRes.json().catch(() => ({}));
    throw new Error(`Synapse registration failed: ${regRes.status} ${errBody.error || ''}`);
  }

  const result = await regRes.json();
  return {
    matrixUserId: result.user_id,
    accessToken: result.access_token,
    deviceId: result.device_id,
  };
}

/**
 * Set avatar for a Matrix user via Synapse admin API.
 */
async function setAgentAvatar(matrixUserId, accessToken) {
  // Default fly emoji avatar — set display name metadata
  try {
    const encoded = encodeURIComponent(matrixUserId);
    await fetch(`${SYNAPSE_URL}/_matrix/client/v3/profile/${encoded}/avatar_url`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ avatar_url: '' }), // Client will show default fly emoji
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[agent-provision] Failed to set avatar for ${matrixUserId}: ${err.message}`);
  }
}

/**
 * Create a DM room between agent and owner.
 */
async function createAgentDMRoom(agentMatrixId, agentAccessToken, ownerMatrixId, agentName) {
  const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';
  const roomName = `${agentName} & You`;

  let roomId = null;

  // Try Synapse admin API
  if (SYNAPSE_REGISTRATION_SECRET || CHAT_API_TOKEN) {
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
      if (res.ok) roomId = (await res.json()).room_id;
    } catch (err) {
      console.warn(`[agent-provision] Admin room creation failed: ${err.message}`);
    }
  }

  // Try Matrix client-server API
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
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) roomId = (await res.json()).room_id;
    } catch (err) {
      console.warn(`[agent-provision] Client room creation failed: ${err.message}`);
    }
  }

  // Dev stub
  if (!roomId) {
    if (process.env.NODE_ENV === 'production') {
      return { room_id: null, error: 'DM room creation unavailable' };
    }
    roomId = `!dev_agent_dm_${uuidv4().slice(0, 8)}:${SYNAPSE_SERVER_NAME}`;
    console.log(`[agent-provision] Dev mode — stub DM room: ${roomId}`);
  }

  // Send greeting
  if (agentAccessToken && !agentAccessToken.startsWith('dev_token_') && !roomId.startsWith('!dev_')) {
    try {
      await fetch(`${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${uuidv4()}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentAccessToken}`,
        },
        body: JSON.stringify({
          msgtype: 'm.text',
          body: `Hey! I'm ${agentName}, your Windy Fly agent. I just hatched! What would you like me to help with?`,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn(`[agent-provision] Failed to send greeting: ${err.message}`);
    }
  }

  return { room_id: roomId, error: null };
}

// ── POST /api/v1/onboarding/agent ──

router.post('/', agentLimiter, serviceTokenAuth, asyncHandler(async (req, res) => {
  const { passport_number, agent_name, owner_windy_identity_id } = req.body;

  if (!passport_number || typeof passport_number !== 'string' || passport_number.length > 255) {
    return res.status(400).json({ error: 'passport_number is required (string, max 255 chars)' });
  }

  if (!agent_name || typeof agent_name !== 'string' || agent_name.length > 100) {
    return res.status(400).json({ error: 'agent_name is required (string, max 100 chars)' });
  }

  if (!owner_windy_identity_id || typeof owner_windy_identity_id !== 'string') {
    return res.status(400).json({ error: 'owner_windy_identity_id is required' });
  }

  // Sanitize agent name
  const sanitizedName = agent_name.replace(/<[^>]*>/g, '').trim();

  // Matrix localpart: @agent_<passport>:chat.windyword.ai
  const localpart = `agent_${passport_number.replace(/[^a-z0-9_-]/gi, '').toLowerCase()}`;
  const expectedMatrixId = `@${localpart}:${SYNAPSE_SERVER_NAME}`;

  // Check if already provisioned
  const existing = onboardingDb.getOnboardingStateByPassport.get(passport_number);
  if (existing && existing.matrix_provisioned) {
    // Return existing credentials (look up DM room)
    const agentRoom = onboardingDb.getAgentRoom.get(existing.matrix_user_id, owner_windy_identity_id);
    return res.json({
      matrix_user_id: existing.matrix_user_id,
      access_token: null, // Can't return stored access token (not stored)
      dm_room_id: agentRoom ? agentRoom.room_id : null,
      already_provisioned: true,
    });
  }

  // 1. Provision Matrix account
  let matrixResult;
  try {
    matrixResult = await provisionAgentMatrix(localpart, `${sanitizedName} 🪰`);
  } catch (err) {
    console.error(`[agent-provision] Matrix provisioning failed for ${passport_number}: ${err.message}`);
    return res.status(502).json({ error: 'Matrix account provisioning failed', detail: err.message });
  }

  // 2. Set avatar
  await setAgentAvatar(matrixResult.matrixUserId, matrixResult.accessToken);

  // 3. Resolve owner Matrix ID — skip DM creation entirely if the owner
  // has no Chat profile yet. The owner's first /unified-login or
  // /identity/created webhook will flush the pending welcome via the
  // post-provision hook in provision.js. Previously we invited a guessed
  // owner Matrix ID that never existed, leaving an empty ghost room.
  const ownerProfile = onboardingDb.getProfileByWindyId.get(owner_windy_identity_id);
  let ownerMatrixId = null;
  if (ownerProfile) {
    const ownerState = onboardingDb.getOnboardingState.get(ownerProfile.chat_user_id);
    ownerMatrixId = ownerState?.matrix_user_id || `@${ownerProfile.chat_user_id}:${SYNAPSE_SERVER_NAME}`;
  }

  // 4. Create DM room only if owner already has a real Matrix account
  const now = new Date().toISOString();
  let dmResult = { room_id: null, error: null };
  if (ownerMatrixId) {
    dmResult = await createAgentDMRoom(matrixResult.matrixUserId, matrixResult.accessToken, ownerMatrixId, sanitizedName);
  }

  // 5. Store onboarding state
  onboardingDb.upsertOnboardingState.run({
    windy_user_id: localpart,
    verified: 1,
    profile_setup: 1,
    matrix_provisioned: 1,
    matrix_user_id: matrixResult.matrixUserId,
    provisioned_at: now,
    passport_id: passport_number,
  });

  // 6. Store agent room mapping
  if (dmResult.room_id) {
    onboardingDb.upsertAgentRoom.run({
      agent_user_id: matrixResult.matrixUserId,
      owner_user_id: owner_windy_identity_id,
      room_id: dmResult.room_id,
      agent_name: sanitizedName,
      created_at: now,
    });
  }

  // 7. Persist agent credentials so we can seed the welcome DM on owner
  //    first-login even if the owner wasn't provisioned yet. welcomed_at
  //    stays null until the post-provision hook fires — if we already
  //    created the room and sent a greeting here (owner existed), mark
  //    welcomed so the owner's next login doesn't double-seed.
  onboardingDb.upsertAgentCredentials.run({
    agent_matrix_id: matrixResult.matrixUserId,
    owner_windy_id: owner_windy_identity_id,
    passport_number,
    agent_name: sanitizedName,
    access_token: matrixResult.accessToken,
    hatched_at: now,
    welcomed_at: dmResult.room_id ? now : null,
    created_at: now,
  });

  console.log(`[agent-provision] Agent provisioned: ${sanitizedName} (${passport_number}) → ${matrixResult.matrixUserId}, DM: ${dmResult.room_id || 'deferred'}`);

  res.status(201).json({
    matrix_user_id: matrixResult.matrixUserId,
    access_token: matrixResult.accessToken,
    dm_room_id: dmResult.room_id,
    agent_name: sanitizedName,
    passport_number,
    welcome_pending: !dmResult.room_id,
  });
}));

module.exports = router;
