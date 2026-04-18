/**
 * Windy Chat — Unified Eternitas Webhook Handler
 *
 * Receives passport lifecycle events from Eternitas and coordinates
 * cross-service responses: Matrix account suspension, social post
 * marking, and room removal.
 *
 * POST /api/v1/webhooks/eternitas
 */

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { asyncHandler } = require('../../shared/async-handler');
const { verifiedAccounts, persistVerified, flushEternitasVerifyCache } = require('../lib/store');

const router = express.Router();

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_URL = process.env.SYNAPSE_ADMIN_URL || `${SYNAPSE_URL}/_synapse/admin`;
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN || process.env.CHAT_API_TOKEN || '';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windyword.ai';

/**
 * Verify HMAC-SHA256 signature from Eternitas.
 *
 * Accepts both live Eternitas format (`sha256=<hex>` per
 * eternitas/docs/webhooks.md) and the legacy bare-hex format older
 * producers used. Case-insensitive on the prefix.
 */
function verifySignature(req) {
  const raw = req.headers['x-eternitas-signature'];
  const secret = process.env.ETERNITAS_WEBHOOK_SECRET;
  if (!secret || !raw) return false;

  let signature = String(raw).trim();
  const prefixMatch = signature.match(/^sha256=(.+)$/i);
  if (prefixMatch) signature = prefixMatch[1];

  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Call Synapse admin API. Returns { ok, status, body }.
 */
function synapseAdmin(method, path, body) {
  return new Promise((resolve) => {
    const url = new URL(path, SYNAPSE_ADMIN_URL.replace(/\/_synapse\/admin$/, ''));
    const fullPath = `/_synapse/admin${path}`;
    const httpModule = SYNAPSE_URL.startsWith('https') ? https : http;
    const opts = {
      method,
      hostname: url.hostname || new URL(SYNAPSE_URL).hostname,
      port: url.port || new URL(SYNAPSE_URL).port,
      path: fullPath,
      headers: {
        'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    };
    const req = httpModule.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (e) => { console.error(`[eternitas-webhook] Synapse admin error: ${e.message}`); resolve({ ok: false, status: 0, body: e.message }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Mark all posts by a user as having a suspended author.
 * Adds a _suspended flag to the post metadata.
 */
function markPostsSuspended(userId, suspended) {
  const store = require('../lib/store');
  const db = store.db;
  if (suspended) {
    db.prepare('UPDATE posts SET translated_versions = json_set(COALESCE(translated_versions, "{}"), "$._author_suspended", 1) WHERE user_id = ?').run(userId);
  } else {
    db.prepare('UPDATE posts SET translated_versions = json_remove(translated_versions, "$._author_suspended") WHERE user_id = ? AND translated_versions IS NOT NULL').run(userId);
  }
}

/**
 * Get all rooms a user is in via Synapse admin API.
 */
async function getUserRooms(matrixUserId) {
  const encoded = encodeURIComponent(matrixUserId);
  const result = await synapseAdmin('GET', `/v1/users/${encoded}/joined_rooms`);
  if (result.ok && result.body.joined_rooms) return result.body.joined_rooms;
  return [];
}

/**
 * Remove user from a room via Synapse admin API.
 */
async function removeFromRoom(roomId, matrixUserId) {
  const encoded = encodeURIComponent(roomId);
  return synapseAdmin('POST', `/v1/rooms/${encoded}/kick`, {
    user_id: matrixUserId,
    reason: 'Eternitas passport revoked/suspended',
  });
}

/**
 * Process passport revocation/suspension asynchronously.
 */
async function handleRevocationOrSuspension(event, passport, botName, operatorId, reason) {
  const botUserId = `bot_${passport}`;
  const matrixUserId = `@agent_${passport}:${SYNAPSE_SERVER_NAME}`;
  const actions = [];

  // 0. Flush the social service's own Eternitas-verify cache
  //    (1-hour TTL otherwise). Without this, a revoked bot stays
  //    "verified" in /api/v1/social/presence responses for up to an
  //    hour. P1-3 fix.
  const verifyCacheFlushed = flushEternitasVerifyCache(passport)
    || flushEternitasVerifyCache(botUserId);
  actions.push(verifyCacheFlushed ? 'verify_cache_flushed' : 'verify_cache_empty');

  // 1. Remove verified badge
  verifiedAccounts.delete(botUserId);
  persistVerified();
  actions.push('verified_badge_removed');

  // 2. Mark social posts as suspended author
  markPostsSuspended(botUserId, true);
  actions.push('posts_marked_suspended');

  // 3. Suspend/deactivate Matrix account
  if (SYNAPSE_ADMIN_TOKEN) {
    const encoded = encodeURIComponent(matrixUserId);
    if (event === 'passport.revoked') {
      const result = await synapseAdmin('POST', `/v1/deactivate/${encoded}`, { erase: false });
      actions.push(result.ok ? 'matrix_deactivated' : 'matrix_deactivate_failed');
    } else {
      // Suspended — lock account (reversible)
      const result = await synapseAdmin('PUT', `/v2/users/${encoded}`, { locked: true });
      actions.push(result.ok ? 'matrix_locked' : 'matrix_lock_failed');
    }

    // 4. Remove from all rooms
    const rooms = await getUserRooms(matrixUserId);
    let removedCount = 0;
    for (const roomId of rooms) {
      const r = await removeFromRoom(roomId, matrixUserId);
      if (r.ok) removedCount++;
    }
    if (rooms.length > 0) {
      actions.push(`removed_from_${removedCount}/${rooms.length}_rooms`);
    }
  } else if (process.env.NODE_ENV !== 'production') {
    console.log(`[eternitas-webhook] [STUB] Would ${event === 'passport.revoked' ? 'deactivate' : 'lock'} Matrix user ${matrixUserId}`);
    actions.push('matrix_stub_mode');
  }

  console.log(`[eternitas-webhook] ${event}: bot=${botName} passport=${passport} operator=${operatorId || 'unknown'} reason=${reason || 'none'} actions=[${actions.join(', ')}]`);
  return { actions, matrix_user_id: matrixUserId, bot_user_id: botUserId };
}

/**
 * Process passport reinstatement asynchronously.
 */
async function handleReinstatement(passport, botName, operatorId, reason) {
  const botUserId = `bot_${passport}`;
  const matrixUserId = `@agent_${passport}:${SYNAPSE_SERVER_NAME}`;
  const actions = [];

  // 0. Flush the verify cache so the next /presence lookup refetches
  //    instead of seeing the suspended-era cached "false".
  const verifyCacheFlushed = flushEternitasVerifyCache(passport)
    || flushEternitasVerifyCache(botUserId);
  actions.push(verifyCacheFlushed ? 'verify_cache_flushed' : 'verify_cache_empty');

  // 1. Restore verified badge
  verifiedAccounts.add(botUserId);
  persistVerified();
  actions.push('verified_badge_restored');

  // 2. Remove suspended flag from posts
  markPostsSuspended(botUserId, false);
  actions.push('posts_unsuspended');

  // 3. Unlock Matrix account
  if (SYNAPSE_ADMIN_TOKEN) {
    const encoded = encodeURIComponent(matrixUserId);
    const result = await synapseAdmin('PUT', `/v2/users/${encoded}`, { locked: false });
    actions.push(result.ok ? 'matrix_unlocked' : 'matrix_unlock_failed');
  } else if (process.env.NODE_ENV !== 'production') {
    console.log(`[eternitas-webhook] [STUB] Would unlock Matrix user ${matrixUserId}`);
    actions.push('matrix_stub_mode');
  }

  console.log(`[eternitas-webhook] passport.reinstated: bot=${botName} passport=${passport} operator=${operatorId || 'unknown'} reason=${reason || 'none'} actions=[${actions.join(', ')}]`);
  return { actions, matrix_user_id: matrixUserId, bot_user_id: botUserId };
}

// ── POST /api/v1/webhooks/eternitas ──

router.post('/', asyncHandler(async (req, res) => {
  const { event, passport, bot_name, operator_id, reason, timestamp } = req.body;

  // Validate required fields
  if (!event || !passport || !bot_name || !timestamp) {
    return res.status(400).json({ error: 'Missing required fields: event, passport, bot_name, timestamp' });
  }

  const validEvents = ['passport.revoked', 'passport.suspended', 'passport.reinstated'];
  if (!validEvents.includes(event)) {
    return res.status(400).json({ error: `Invalid event type. Must be one of: ${validEvents.join(', ')}` });
  }

  // Verify HMAC signature
  if (process.env.ETERNITAS_WEBHOOK_SECRET) {
    if (!verifySignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return res.status(500).json({ error: 'ETERNITAS_WEBHOOK_SECRET not configured' });
  } else {
    console.warn('[eternitas-webhook] ETERNITAS_WEBHOOK_SECRET not set — skipping signature verification (development mode)');
  }

  // Return 200 immediately, process async
  res.json({
    acknowledged: true,
    event,
    passport,
    timestamp,
  });

  // Process the event asynchronously (after response sent)
  setImmediate(async () => {
    try {
      if (event === 'passport.reinstated') {
        await handleReinstatement(passport, bot_name, operator_id, reason);
      } else {
        await handleRevocationOrSuspension(event, passport, bot_name, operator_id, reason);
      }
    } catch (err) {
      console.error(`[eternitas-webhook] Async processing error for ${event}/${passport}:`, err.message);
    }
  });
}));

module.exports = router;
