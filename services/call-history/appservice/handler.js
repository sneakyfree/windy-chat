/**
 * Windy Chat — Call History Auto-Logging Appservice Handler
 *
 * Synapse Application Service that listens for m.call.* events
 * and automatically logs them to the call history service.
 * This removes the need for clients to manually submit call logs.
 *
 * Events captured:
 *   m.call.invite  — call initiated
 *   m.call.answer  — call answered
 *   m.call.hangup  — call ended
 *   m.call.reject  — call rejected
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const AS_TOKEN = process.env.CALL_HISTORY_AS_TOKEN || '';
const HS_TOKEN = process.env.CALL_HISTORY_HS_TOKEN || '';

// Track active calls: call_id → { room_id, caller, started_at, call_type }
const activeCalls = new Map();

/**
 * Verify homeserver token on appservice endpoints.
 */
function verifyHsToken(req, res, next) {
  const token = req.query.access_token || req.headers.authorization?.replace('Bearer ', '');
  if (!HS_TOKEN) return next(); // Dev mode — skip
  if (token !== HS_TOKEN) return res.status(403).json({ errcode: 'M_FORBIDDEN' });
  next();
}

/**
 * Process a Matrix event from Synapse.
 */
function processCallEvent(event) {
  const { type, sender, room_id, content } = event;
  const callId = content?.call_id;
  if (!callId) return;

  switch (type) {
    case 'm.call.invite': {
      // Call initiated
      activeCalls.set(callId, {
        room_id,
        caller: sender,
        started_at: new Date().toISOString(),
        call_type: content.offer?.sdp?.includes('m=video') ? 'video' : 'voice',
      });
      console.log(`[call-appservice] Call started: ${callId} (${sender} in ${room_id})`);
      break;
    }

    case 'm.call.answer': {
      // Call answered — update with callee
      const call = activeCalls.get(callId);
      if (call) {
        call.callee = sender;
        call.answered_at = new Date().toISOString();
      }
      break;
    }

    case 'm.call.hangup':
    case 'm.call.reject': {
      // Call ended — log to call history
      const call = activeCalls.get(callId);
      if (call) {
        const endedAt = new Date().toISOString();
        const startMs = new Date(call.started_at).getTime();
        const endMs = new Date(endedAt).getTime();
        const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));

        // Log to the call history database
        try {
          const callHistoryDb = require('../lib/db');
          callHistoryDb.insertCall.run({
            id: uuidv4(),
            room_id: call.room_id,
            caller_id: call.caller,
            caller_windy_identity_id: null,
            callee_id: call.callee || sender,
            callee_windy_identity_id: null,
            started_at: call.started_at,
            ended_at: endedAt,
            duration_seconds: durationSeconds,
            call_type: call.call_type,
            quality_score: null,
          });
          console.log(`[call-appservice] Call logged: ${callId} (${durationSeconds}s ${call.call_type})`);
        } catch (err) {
          console.error(`[call-appservice] Failed to log call ${callId}:`, err.message);
        }

        activeCalls.delete(callId);
      }
      break;
    }
  }
}

// ── PUT /_matrix/app/v1/transactions/:txnId — receive events from Synapse ──
router.put('/transactions/:txnId', verifyHsToken, (req, res) => {
  const events = req.body?.events || [];

  for (const event of events) {
    if (event.type?.startsWith('m.call.')) {
      processCallEvent(event);
    }
  }

  res.json({});
});

// ── GET /_matrix/app/v1/rooms/:roomAlias — room query (required, return 404) ──
router.get('/rooms/:roomAlias', verifyHsToken, (_req, res) => {
  res.status(404).json({});
});

// ── GET /_matrix/app/v1/users/:userId — user query (required, return 404) ──
router.get('/users/:userId', verifyHsToken, (_req, res) => {
  res.status(404).json({});
});

module.exports = router;
