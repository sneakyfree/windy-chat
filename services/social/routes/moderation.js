/**
 * Windy Chat — Social Moderation Routes
 * K10: Post reporting and content flagging
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../shared/async-handler');
const { createAuthMiddleware } = require('../../shared/jwt-verify');
const {
  postsMap, reportsMap, persistReports,
  hasDuplicateReport,
} = require('../lib/store');

const router = Router();
const auth = createAuthMiddleware();

const VALID_REASONS = ['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other'];

// ── Report Post ──
router.post('/:postId/report', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const { reason, description } = req.body;

  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (!reason || !VALID_REASONS.includes(reason)) {
    return res.status(400).json({
      error: `reason is required and must be one of: ${VALID_REASONS.join(', ')}`,
    });
  }

  if (description && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }

  // Prevent duplicate reports from same user on same post
  if (hasDuplicateReport(postId, userId)) {
    return res.status(409).json({ error: 'You have already reported this post' });
  }

  const report = {
    id: uuidv4(),
    postId,
    postAuthorId: post.userId,
    reportedBy: userId,
    reason,
    description: description || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  reportsMap.set(report.id, report);
  persistReports();

  res.status(201).json({ reportId: report.id, status: 'pending' });
}));

module.exports = router;
