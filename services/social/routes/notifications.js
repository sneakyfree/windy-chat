/**
 * Windy Chat — Social Notification Routes
 * K10: Notification retrieval and read-marking
 */

const { Router } = require('express');
const { asyncHandler } = require('../../shared/async-handler');
const { createAuthMiddleware } = require('../../shared/jwt-verify');
const { notificationsMap, persistNotifications } = require('../lib/store');

const router = Router();
const auth = createAuthMiddleware();

const PAGE_SIZE = 50;

// ── Get Notifications ──
router.get('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const unreadOnly = req.query.unread === 'true';

  let notifications = notificationsMap.get(userId) || [];

  if (unreadOnly) {
    notifications = notifications.filter(n => !n.read);
  }

  // Most recent first
  notifications = [...notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const page = notifications.slice(0, PAGE_SIZE);
  const unreadCount = (notificationsMap.get(userId) || []).filter(n => !n.read).length;

  res.json({ notifications: page, count: page.length, unreadCount });
}));

// ── Mark Notifications as Read ──
router.post('/read', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { notificationIds } = req.body;

  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return res.status(400).json({ error: 'notificationIds must be a non-empty array' });
  }

  const userNotifications = notificationsMap.get(userId);
  if (!userNotifications) return res.json({ markedRead: 0 });

  const idsSet = new Set(notificationIds);
  let markedRead = 0;
  for (const n of userNotifications) {
    if (idsSet.has(n.id) && !n.read) {
      n.read = true;
      markedRead++;
    }
  }

  persistNotifications();
  res.json({ markedRead });
}));

module.exports = router;
