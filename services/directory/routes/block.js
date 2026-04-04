/**
 * Windy Chat — Directory Block Routes
 * K3: Blocked users management
 *
 * Endpoints:
 *   POST   /api/v1/chat/directory/block   — block a user
 *   DELETE /api/v1/chat/directory/block   — unblock a user
 *   GET    /api/v1/chat/directory/blocked — list blocked users
 */

const express = require('express');
const { asyncHandler } = require('../../shared/async-handler');
const dirDb = require('../lib/db');

const router = express.Router();

// ── Block a user ──
router.post('/block', asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { targetUserId } = req.body;

  if (!targetUserId || typeof targetUserId !== 'string' || !targetUserId.trim()) {
    return res.status(400).json({ error: 'targetUserId is required and must be a non-empty string' });
  }

  if (targetUserId.length > 255) {
    return res.status(400).json({ error: 'targetUserId must be 255 characters or fewer' });
  }

  if (userId === targetUserId) {
    return res.status(400).json({ error: 'Cannot block yourself' });
  }

  dirDb.blockUser.run(userId, targetUserId, new Date().toISOString());

  res.json({ blocked: true, targetUserId });
}));

// ── Unblock a user ──
router.delete('/block', asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { targetUserId } = req.body;

  if (!targetUserId || typeof targetUserId !== 'string' || !targetUserId.trim()) {
    return res.status(400).json({ error: 'targetUserId is required and must be a non-empty string' });
  }

  dirDb.unblockUser.run(userId, targetUserId);

  res.json({ blocked: false, targetUserId });
}));

// ── List blocked users ──
router.get('/blocked', asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const rows = dirDb.getBlockedList.all(userId);

  const blockedUsers = rows.map(r => ({
    userId: r.blocked_id,
    blockedAt: r.created_at,
  }));

  res.json({ blockedUsers, count: blockedUsers.length });
}));

module.exports = router;
