/**
 * Windy Chat — Social Follow Routes
 * K10: Follow/unfollow with notification queueing
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../shared/async-handler');
const { createAuthMiddleware } = require('../../shared/jwt-verify');
const {
  followsMap, followersMap,
  persistFollows, persistNotifications,
  addFollow, removeFollow, isFollowing,
  addNotification,
} = require('../lib/store');

const router = Router();
const auth = createAuthMiddleware();

// ── Follow User ──
router.post('/:targetUserId', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { targetUserId } = req.params;

  if (userId === targetUserId) {
    return res.status(400).json({ error: 'Cannot follow yourself' });
  }

  const alreadyFollowing = isFollowing(userId, targetUserId);
  addFollow(userId, targetUserId);
  persistFollows();

  // Queue notification for new follows
  if (!alreadyFollowing) {
    addNotification(targetUserId, {
      id: uuidv4(),
      type: 'follow',
      fromUserId: userId,
      read: false,
      createdAt: new Date().toISOString(),
    });
    persistNotifications();
  }

  res.json({ following: true });
}));

// ── Unfollow User ──
router.delete('/:targetUserId', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { targetUserId } = req.params;

  removeFollow(userId, targetUserId);
  persistFollows();

  res.json({ following: false });
}));

// ── List Following ──
router.get('/following/:userId', asyncHandler(async (req, res) => {
  const following = followsMap.get(req.params.userId);
  const list = following ? [...following] : [];
  res.json({ userId: req.params.userId, following: list, count: list.length });
}));

// ── List Followers ──
router.get('/followers/:userId', asyncHandler(async (req, res) => {
  const followers = followersMap.get(req.params.userId);
  const list = followers ? [...followers] : [];
  res.json({ userId: req.params.userId, followers: list, count: list.length });
}));

module.exports = router;
