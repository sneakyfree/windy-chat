/**
 * Windy Chat — Room Management Routes
 *
 * Endpoints:
 *   POST /api/v1/rooms/create-group — create a group chat room
 *   POST /api/v1/rooms/:roomId/invite — invite a user or agent to a room
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../shared/async-handler');
const onboardingDb = require('../lib/db');

const router = express.Router();

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_URL = process.env.SYNAPSE_ADMIN_URL || `${SYNAPSE_URL}/_synapse/admin`;
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windypro.com';
const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';

const roomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many room operations' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Resolve a windy_identity_id to a Matrix user ID.
 */
function resolveMatrixId(windyIdentityId) {
  const profile = onboardingDb.getProfileByWindyId.get(windyIdentityId);
  if (profile) {
    const state = onboardingDb.getOnboardingState.get(profile.chat_user_id);
    if (state?.matrix_user_id) return state.matrix_user_id;
    return `@${profile.chat_user_id}:${SYNAPSE_SERVER_NAME}`;
  }
  return `@windy_${windyIdentityId.slice(0, 12)}:${SYNAPSE_SERVER_NAME}`;
}

/**
 * Resolve a passport_number to an agent's Matrix user ID.
 */
function resolveAgentMatrixId(passportNumber) {
  const state = onboardingDb.getOnboardingStateByPassport.get(passportNumber);
  if (state?.matrix_user_id) return state.matrix_user_id;
  const localpart = `agent_${passportNumber.replace(/[^a-z0-9_-]/gi, '').toLowerCase()}`;
  return `@${localpart}:${SYNAPSE_SERVER_NAME}`;
}

// ── POST /api/v1/rooms/create-group ──

router.post('/create-group', roomLimiter, asyncHandler(async (req, res) => {
  const { name, members, is_public } = req.body;
  const creatorId = req.user.sub;
  const creatorWindyId = req.user.windy_identity_id;

  if (!name || typeof name !== 'string' || !name.trim() || name.length > 100) {
    return res.status(400).json({ error: 'name is required (string, max 100 chars)' });
  }

  if (!members || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'members is required (non-empty array of windy_identity_ids)' });
  }

  if (members.length > 50) {
    return res.status(400).json({ error: 'Max 50 members per group' });
  }

  // Resolve all member Matrix IDs
  const inviteIds = [];
  for (const member of members) {
    if (typeof member !== 'string') continue;
    // Check if it's a passport number (for agents)
    if (member.startsWith('ET') || member.includes('-')) {
      const agentState = onboardingDb.getOnboardingStateByPassport.get(member);
      if (agentState?.matrix_user_id) {
        inviteIds.push(agentState.matrix_user_id);
      } else {
        inviteIds.push(resolveAgentMatrixId(member));
      }
    } else {
      inviteIds.push(resolveMatrixId(member));
    }
  }

  // Resolve creator's Matrix ID
  const creatorMatrixId = creatorWindyId ? resolveMatrixId(creatorWindyId) : `@${creatorId}:${SYNAPSE_SERVER_NAME}`;

  // Create the room via Synapse
  let roomId = null;

  // Try 1: Synapse admin API
  if (CHAT_API_TOKEN) {
    try {
      const adminRes = await fetch(`${SYNAPSE_ADMIN_URL}/v1/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CHAT_API_TOKEN}`,
        },
        body: JSON.stringify({
          creator: creatorMatrixId,
          invite: inviteIds,
          is_direct: false,
          preset: is_public ? 'public_chat' : 'private_chat',
          name: name.trim(),
          initial_state: [{
            type: 'm.room.guest_access',
            state_key: '',
            content: { guest_access: 'forbidden' },
          }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (adminRes.ok) {
        const data = await adminRes.json();
        roomId = data.room_id;
      }
    } catch (err) {
      console.warn(`[rooms] Admin room creation failed: ${err.message}`);
    }
  }

  // Try 2: Dev stub
  if (!roomId) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(502).json({ error: 'Room creation unavailable — Synapse not reachable' });
    }
    roomId = `!group_${uuidv4().slice(0, 8)}:${SYNAPSE_SERVER_NAME}`;
    console.log(`[rooms] Dev mode — stub group room: ${roomId}`);
  }

  console.log(`[rooms] Group created: "${name.trim()}" (${roomId}) with ${inviteIds.length} members`);

  res.status(201).json({
    room_id: roomId,
    name: name.trim(),
    members: inviteIds,
    member_count: inviteIds.length + 1, // +1 for creator
    is_public: !!is_public,
  });
}));

// ── POST /api/v1/rooms/:roomId/invite ──

router.post('/:roomId/invite', roomLimiter, asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { passport_number, windy_identity_id } = req.body;

  if (!roomId || typeof roomId !== 'string') {
    return res.status(400).json({ error: 'roomId is required' });
  }

  if (!passport_number && !windy_identity_id) {
    return res.status(400).json({ error: 'Either passport_number (for agents) or windy_identity_id (for humans) is required' });
  }

  // Resolve the invitee's Matrix ID
  let inviteeMatrixId;
  let inviteeName;

  if (passport_number) {
    inviteeMatrixId = resolveAgentMatrixId(passport_number);
    const state = onboardingDb.getOnboardingStateByPassport.get(passport_number);
    inviteeName = state ? `agent (${passport_number})` : passport_number;
  } else {
    inviteeMatrixId = resolveMatrixId(windy_identity_id);
    const profile = onboardingDb.getProfileByWindyId.get(windy_identity_id);
    inviteeName = profile?.display_name || windy_identity_id;
  }

  // Send invite via Synapse
  let invited = false;

  if (CHAT_API_TOKEN) {
    try {
      const inviteRes = await fetch(`${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CHAT_API_TOKEN}`,
        },
        body: JSON.stringify({ user_id: inviteeMatrixId }),
        signal: AbortSignal.timeout(10000),
      });
      invited = inviteRes.ok;
    } catch (err) {
      console.warn(`[rooms] Invite failed: ${err.message}`);
    }
  }

  if (!invited && process.env.NODE_ENV !== 'production') {
    invited = true; // Dev stub
    console.log(`[rooms] Dev mode — stub invite: ${inviteeMatrixId} → ${roomId}`);
  }

  if (!invited) {
    return res.status(502).json({ error: 'Failed to send room invite' });
  }

  console.log(`[rooms] Invited ${inviteeName} (${inviteeMatrixId}) to ${roomId}`);

  res.json({
    invited: true,
    room_id: roomId,
    invitee_matrix_id: inviteeMatrixId,
    is_agent: !!passport_number,
  });
}));

module.exports = router;
