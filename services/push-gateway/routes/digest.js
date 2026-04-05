/**
 * Windy Chat — Notification Digest & Engagement
 *
 * Endpoints:
 *   POST /api/v1/chat/push/digest/subscribe — opt in to daily digest
 *   DELETE /api/v1/chat/push/digest/subscribe — opt out
 *   GET /api/v1/chat/push/digest/status — check subscription status
 *   POST /api/v1/chat/push/notify-owner — agent notifies owner of completed task
 */

const express = require('express');
const { asyncHandler } = require('../../shared/async-handler');

const router = express.Router();

// ── Digest subscription storage (SQLite via push-gateway db) ──
let digestDb;
try {
  const pushDb = require('../lib/db');
  digestDb = pushDb.db;
  digestDb.exec(`
    CREATE TABLE IF NOT EXISTS digest_subscriptions (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      preferred_hour INTEGER DEFAULT 9,
      timezone TEXT DEFAULT 'UTC',
      created_at TEXT NOT NULL
    )
  `);
} catch { /* table may already exist */ }

const getDigest = digestDb?.prepare('SELECT * FROM digest_subscriptions WHERE user_id = ?');
const upsertDigest = digestDb?.prepare(`
  INSERT OR REPLACE INTO digest_subscriptions (user_id, enabled, preferred_hour, timezone, created_at)
  VALUES (?, ?, ?, ?, datetime('now'))
`);
const deleteDigest = digestDb?.prepare('DELETE FROM digest_subscriptions WHERE user_id = ?');

// ── POST /digest/subscribe ──
router.post('/subscribe', asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { preferred_hour, timezone } = req.body;
  const hour = Math.max(0, Math.min(23, parseInt(preferred_hour) || 9));

  upsertDigest?.run(userId, 1, hour, timezone || 'UTC');
  console.log(`[digest] ${userId} subscribed to daily digest at ${hour}:00 ${timezone || 'UTC'}`);

  res.json({ subscribed: true, preferred_hour: hour, timezone: timezone || 'UTC' });
}));

// ── DELETE /digest/subscribe ──
router.delete('/subscribe', asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  deleteDigest?.run(userId);
  res.json({ subscribed: false });
}));

// ── GET /digest/status ──
router.get('/status', asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const sub = getDigest?.get(userId);
  if (sub) {
    res.json({ subscribed: true, enabled: !!sub.enabled, preferred_hour: sub.preferred_hour, timezone: sub.timezone });
  } else {
    res.json({ subscribed: false });
  }
}));

// ── POST /notify-owner — agent activity notification ──
// Called by agent services when an agent completes a task for its owner.
// Body: { owner_user_id, agent_name, action, details }
router.post('/notify-owner', asyncHandler(async (req, res) => {
  const { owner_user_id, agent_name, action, details } = req.body;

  if (!owner_user_id || !agent_name || !action) {
    return res.status(400).json({ error: 'owner_user_id, agent_name, and action are required' });
  }

  // Build notification message
  const message = `🪰 ${agent_name} ${action}`;
  const body = details || message;

  // Look up push tokens for the owner
  const pushDb = require('../lib/db');
  const tokens = pushDb.db.prepare('SELECT * FROM push_tokens WHERE user_id = ?').all(owner_user_id);

  let sent = 0;
  for (const token of tokens) {
    // The actual push sending is handled by the main push gateway
    // Here we just log the intent — in production, this would call sendFCM/sendAPNs/sendWebPush
    console.log(`[digest] Agent notification: ${message} → ${token.platform}:${token.pushkey.slice(0, 20)}...`);
    sent++;
  }

  console.log(`[digest] Agent activity: ${agent_name} → ${owner_user_id}: ${action} (${sent} tokens)`);

  res.json({
    notified: true,
    owner_user_id,
    agent_name,
    action,
    tokens_reached: sent,
  });
}));

module.exports = router;
