/**
 * Windy Chat — Social Follow Routes
 * K10: Follow/unfollow with notification queueing
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../shared/async-handler');
const { createAuthMiddleware } = require('../../shared/jwt-verify');
const {
  followsMap, followersMap, notificationsMap,
  persistFollows, persistNotifications,
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

  if (!followsMap.has(userId)) followsMap.set(userId, new Set());
  if (!followersMap.has(targetUserId)) followersMap.set(targetUserId, new Set());

  const alreadyFollowing = followsMap.get(userId).has(targetUserId);
  followsMap.get(userId).add(targetUserId);
  followersMap.get(targetUserId).add(userId);
  persistFollows();

  // Queue notification for new follows
  if (!alreadyFollowing) {
    if (!notificationsMap.has(targetUserId)) notificationsMap.set(targetUserId, []);
    notificationsMap.get(targetUserId).push({
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

  const userFollows = followsMap.get(userId);
  if (userFollows) userFollows.delete(targetUserId);

  const targetFollowers = followersMap.get(targetUserId);
  if (targetFollowers) targetFollowers.delete(userId);

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
