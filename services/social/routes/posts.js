/**
 * Windy Chat — Social Posts Routes
 * K10: Post CRUD, feed, likes, translation, Eternitas badge
 *      + Privacy controls, media, repost/share, hashtags/trending
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../shared/async-handler');
const { createAuthMiddleware } = require('../../shared/jwt-verify');
const { checkProfanity } = require('../lib/profanity');
const {
  postsMap, followsMap, followersMap, likesMap, verifiedAccounts,
  persistPosts, persistLikes, persistNotifications,
  addLike, removeLike, hasLike, getLikeCount, updatePostLikeCount,
  addNotification, searchPostContent, isFollowing,
  addComment, getCommentsForPost, getCommentCountForPost, getCommentById, deleteCommentById,
  addCommentLike, removeCommentLike, hasCommentLike, getCommentLikeCount, updateCommentLikeCount,
  saveHashtags, getPostsByTag, getTrending,
} = require('../lib/store');

const router = Router();
const auth = createAuthMiddleware();

// Service token auth for agent/bot endpoints (CHAT_SERVICE_TOKEN or CHAT_API_TOKEN)
const CHAT_SERVICE_TOKEN = process.env.CHAT_SERVICE_TOKEN || process.env.CHAT_API_TOKEN || '';

/**
 * Compute engagement score for algorithmic feed ranking.
 * Score = (likes * 3 + comments * 5 + reposts * 4) / (age_hours + 2)^1.5
 * Verified/agent posts get a small boost. Recent posts decay slower.
 */
function computeEngagementScore(post, nowMs) {
  const ageMs = nowMs - new Date(post.createdAt).getTime();
  const ageHours = Math.max(0.1, ageMs / (1000 * 60 * 60));
  const likes = getLikeCount(post.id);
  const comments = getCommentCountForPost(post.id);
  const isVerified = verifiedAccounts.has(post.userId);
  const rawScore = (likes * 3) + (comments * 5) + (post.repostOf ? 0 : 1);
  const verifiedBoost = isVerified ? 1.3 : 1.0;
  return (rawScore * verifiedBoost) / Math.pow(ageHours + 2, 1.5);
}

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

// Optional auth: sets req.user if token present, but does not reject
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  // Use the real auth middleware, but catch 401 and continue without user
  const realAuth = createAuthMiddleware();
  realAuth(req, res, (err) => {
    if (err) {
      req.user = null;
    }
    next();
  });
};

const MAX_POST_LENGTH = 5000;
const PAGE_SIZE = 20;
const VALID_VISIBILITIES = ['public', 'followers', 'private'];

// ── Visibility Helpers ──

/**
 * Check if a viewer can see a post based on visibility rules.
 * @param {Object} post - The post object
 * @param {string|null} viewerUserId - The viewer's user ID (null if unauthenticated)
 * @returns {boolean}
 */
function canViewPost(post, viewerUserId) {
  if (!post) return false;
  if (post.visibility === 'public') return true;
  if (!viewerUserId) return false;
  if (post.userId === viewerUserId) return true;
  if (post.visibility === 'followers') {
    return isFollowing(viewerUserId, post.userId) || isFollowing(post.userId, viewerUserId);
  }
  // 'private' — only the author
  return false;
}

/**
 * Filter a list of posts by visibility for a viewer.
 */
function filterByVisibility(posts, viewerUserId) {
  return posts.filter(p => canViewPost(p, viewerUserId));
}

// ── Trending Hashtags (must be before /:postId to avoid conflict) ──
router.get('/trending', asyncHandler(async (req, res) => {
  const trending = getTrending();
  res.json({
    hashtags: trending.map(h => ({ tag: h.tag, postCount: h.post_count })),
    count: trending.length,
  });
}));

// ── Posts by Hashtag (must be before /:postId) ──
router.get('/hashtag/:tag', asyncHandler(async (req, res) => {
  const { tag } = req.params;
  if (!tag || typeof tag !== 'string' || tag.length > 50) {
    return res.status(400).json({ error: 'tag is required and must be 50 characters or fewer' });
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit) || PAGE_SIZE, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  // Get viewer for visibility filtering
  const viewerUserId = req.user ? req.user.sub : null;
  const posts = getPostsByTag(tag, limit + 10, offset); // fetch extra to account for filtered-out posts
  const visible = filterByVisibility(posts, viewerUserId).slice(0, limit);

  const enriched = visible.map(p => ({
    ...p,
    verified: verifiedAccounts.has(p.userId),
    likeCount: getLikeCount(p.id),
  }));

  res.json({ tag: tag.toLowerCase(), posts: enriched, count: enriched.length });
}));

// ── Display-name snapshot helpers ──
//
// Posts denormalize the author's display_name + chat_user_id at write time
// so the feed can render a human-readable identity without a per-post
// cross-service lookup. Inspired by Twitter/X's denormalization: post
// identity is immutable, snapshot is the price of fast reads.
//
// `chat_user_id` is the Matrix localpart (e.g. `grantwhitmer3`) — used as
// the @handle. Display name is the user's full name (e.g. "Grant Whitmer").
//
// Source of truth: chat-onboarding's user_profiles. We trust the caller
// (the user's authenticated JWT bearer) to pass them in the post body
// rather than do a service-to-service lookup on every write — the JWT
// already binds the userId, and display_name is presentation-only (UI
// trust, not security).
function sanitizeDisplayField(value, maxLen) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

// ── Create Post ──
router.post('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { content, translated_versions, visibility, media_ids, displayName, chatUserId } = req.body;

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required and must be a non-empty string' });
  }
  if (content.length > MAX_POST_LENGTH) {
    return res.status(400).json({ error: `content exceeds max length of ${MAX_POST_LENGTH}` });
  }

  // Validate visibility
  const postVisibility = visibility || 'public';
  if (!VALID_VISIBILITIES.includes(postVisibility)) {
    return res.status(400).json({ error: `visibility must be one of: ${VALID_VISIBILITIES.join(', ')}` });
  }

  // Validate media_ids
  if (media_ids !== undefined) {
    if (!Array.isArray(media_ids)) {
      return res.status(400).json({ error: 'media_ids must be an array' });
    }
    if (media_ids.length > 4) {
      return res.status(400).json({ error: 'media_ids cannot contain more than 4 items' });
    }
    for (const mid of media_ids) {
      if (typeof mid !== 'string' || mid.length > 255 || !mid.trim()) {
        return res.status(400).json({ error: 'Each media_id must be a non-empty string of 255 characters or fewer' });
      }
    }
  }

  // Profanity filter
  const profanityCheck = checkProfanity(content);
  if (profanityCheck.hasProfanity) {
    return res.status(422).json({
      error: 'Post contains prohibited language',
      matched: profanityCheck.matched,
    });
  }

  // Validate translated_versions if provided
  if (translated_versions !== undefined) {
    if (typeof translated_versions !== 'object' || Array.isArray(translated_versions) || translated_versions === null) {
      return res.status(400).json({ error: 'translated_versions must be a JSON object mapping language codes to strings' });
    }
    for (const [lang, text] of Object.entries(translated_versions)) {
      if (typeof lang !== 'string' || typeof text !== 'string') {
        return res.status(400).json({ error: 'translated_versions values must be strings' });
      }
      const tvCheck = checkProfanity(text);
      if (tvCheck.hasProfanity) {
        return res.status(422).json({
          error: `Translated version (${lang}) contains prohibited language`,
          matched: tvCheck.matched,
        });
      }
    }
  }

  const now = new Date().toISOString();
  const post = {
    id: uuidv4(),
    userId,
    windyIdentityId: req.user.windy_identity_id || null,
    // Author display snapshot — trusted from the authenticated client.
    // See sanitizeDisplayField comment above for the trust model.
    displayName: sanitizeDisplayField(displayName, 100),
    chatUserId: sanitizeDisplayField(chatUserId, 64),
    content: content.trim(),
    translated_versions: translated_versions || null,
    createdAt: now,
    updatedAt: now,
    likeCount: 0,
    visibility: postVisibility,
    mediaIds: media_ids || null,
    repostOf: null,
    verified: verifiedAccounts.has(userId),
  };

  postsMap.set(post.id, post);
  persistPosts();

  // Extract and save hashtags
  saveHashtags(post.id, post.content, now);

  res.status(201).json(post);
}));

// ── Search Posts ──
router.get('/search', asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || typeof q !== 'string' || !q.trim()) {
    return res.status(400).json({ error: 'q query parameter is required' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const viewerUserId = req.user ? req.user.sub : null;
  const posts = searchPostContent(q.trim(), limit + 20);
  const visible = filterByVisibility(posts, viewerUserId).slice(0, limit);
  const enriched = visible.map(p => ({
    ...p,
    verified: verifiedAccounts.has(p.userId),
    likeCount: getLikeCount(p.id),
  }));
  res.json({ posts: enriched, count: enriched.length, query: q.trim() });
}));

// ── Get Single Post ──
router.get('/:postId', optionalAuth, asyncHandler(async (req, res) => {
  const post = postsMap.get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const viewerUserId = req.user ? req.user.sub : null;
  if (!canViewPost(post, viewerUserId)) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const result = {
    ...post,
    verified: verifiedAccounts.has(post.userId),
    likeCount: getLikeCount(post.id),
  };

  // Include original post data for reposts
  if (post.repostOf) {
    const original = postsMap.get(post.repostOf);
    if (original && canViewPost(original, viewerUserId)) {
      result.originalPost = {
        ...original,
        verified: verifiedAccounts.has(original.userId),
        likeCount: getLikeCount(original.id),
      };
    }
  }

  res.json(result);
}));

// ── Get User's Posts ──
router.get('/user/:userId', optionalAuth, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const cursor = req.query.cursor;
  const viewerUserId = req.user ? req.user.sub : null;

  let posts = [...postsMap.values()]
    .filter(p => p.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Apply visibility filtering
  posts = filterByVisibility(posts, viewerUserId);

  if (cursor) {
    const idx = posts.findIndex(p => p.id === cursor);
    if (idx >= 0) posts = posts.slice(idx + 1);
  }

  const page = posts.slice(0, PAGE_SIZE);
  const enriched = page.map(p => ({
    ...p,
    verified: verifiedAccounts.has(p.userId),
    likeCount: getLikeCount(p.id),
  }));

  res.json({
    posts: enriched,
    count: enriched.length,
    cursor: enriched.length === PAGE_SIZE ? enriched[enriched.length - 1].id : null,
  });
}));

// ── Feed (posts from followed users) ──
// ?sort=ranked for algorithmic feed, default is chronological
router.get('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const following = followsMap.get(userId) || new Set();
  const cursor = req.query.cursor;
  const sortMode = req.query.sort || 'chronological';

  // Include own posts + followed users' posts
  const feedUserIds = new Set([userId, ...following]);
  let posts = [...postsMap.values()]
    .filter(p => feedUserIds.has(p.userId));

  if (sortMode === 'ranked') {
    // Algorithmic ranking: engagement score + recency decay
    const now = Date.now();
    posts.sort((a, b) => {
      const scoreA = computeEngagementScore(a, now);
      const scoreB = computeEngagementScore(b, now);
      return scoreB - scoreA;
    });
  } else {
    posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Apply visibility filtering (user always sees own posts; followers posts if following)
  posts = filterByVisibility(posts, userId);

  if (cursor) {
    const idx = posts.findIndex(p => p.id === cursor);
    if (idx >= 0) posts = posts.slice(idx + 1);
  }

  const page = posts.slice(0, PAGE_SIZE);
  const enriched = page.map(p => {
    const result = {
      ...p,
      verified: verifiedAccounts.has(p.userId),
      likeCount: getLikeCount(p.id),
      // liked-by-me lets the client render the heart in its "filled" state
      // and bind the click to unlike (DELETE) instead of double-incrementing.
      liked: hasLike(userId, p.id),
      commentCount: getCommentCountForPost(p.id),
    };
    // Include original post data for reposts
    if (p.repostOf) {
      const original = postsMap.get(p.repostOf);
      if (original && canViewPost(original, userId)) {
        result.originalPost = {
          ...original,
          verified: verifiedAccounts.has(original.userId),
          likeCount: getLikeCount(original.id),
          liked: hasLike(userId, original.id),
          commentCount: getCommentCountForPost(original.id),
        };
      }
    }
    return result;
  });

  res.json({
    posts: enriched,
    count: enriched.length,
    cursor: enriched.length === PAGE_SIZE ? enriched[enriched.length - 1].id : null,
  });
}));

// ── Repost/Share ──
router.post('/:postId/repost', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const { content, visibility, displayName, chatUserId } = req.body;

  const originalPost = postsMap.get(postId);
  if (!originalPost) return res.status(404).json({ error: 'Post not found' });

  // Check visibility of original post
  if (!canViewPost(originalPost, userId)) {
    return res.status(404).json({ error: 'Post not found' });
  }

  // Validate optional content (quote text)
  if (content !== undefined && content !== null && content !== '') {
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (content.length > MAX_POST_LENGTH) {
      return res.status(400).json({ error: `content exceeds max length of ${MAX_POST_LENGTH}` });
    }
    const profanityCheck = checkProfanity(content);
    if (profanityCheck.hasProfanity) {
      return res.status(422).json({
        error: 'Repost content contains prohibited language',
        matched: profanityCheck.matched,
      });
    }
  }

  // Validate visibility
  const repostVisibility = visibility || 'public';
  if (!VALID_VISIBILITIES.includes(repostVisibility)) {
    return res.status(400).json({ error: `visibility must be one of: ${VALID_VISIBILITIES.join(', ')}` });
  }

  const now = new Date().toISOString();
  const repost = {
    id: uuidv4(),
    userId,
    windyIdentityId: req.user.windy_identity_id || null,
    displayName: sanitizeDisplayField(displayName, 100),
    chatUserId: sanitizeDisplayField(chatUserId, 64),
    content: (content && content.trim()) || '',
    translated_versions: null,
    createdAt: now,
    updatedAt: now,
    likeCount: 0,
    visibility: repostVisibility,
    mediaIds: null,
    repostOf: postId,
    verified: verifiedAccounts.has(userId),
  };

  postsMap.set(repost.id, repost);
  persistPosts();

  // Save hashtags from quote text
  if (repost.content) {
    saveHashtags(repost.id, repost.content, now);
  }

  // Notify original post author (if not self-repost)
  if (originalPost.userId !== userId) {
    addNotification(originalPost.userId, {
      id: uuidv4(),
      type: 'repost',
      fromUserId: userId,
      postId: originalPost.id,
      read: false,
      createdAt: now,
    });
    persistNotifications();
  }

  // Include original post data in response
  const result = {
    ...repost,
    originalPost: {
      ...originalPost,
      verified: verifiedAccounts.has(originalPost.userId),
      likeCount: getLikeCount(originalPost.id),
    },
  };

  res.status(201).json(result);
}));

// ── Like Post ──
router.post('/:postId/like', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const alreadyLiked = hasLike(userId, postId);
  addLike(userId, postId);
  const likeCount = updatePostLikeCount(postId);
  persistLikes();
  persistPosts();

  // Queue notification if this is a new like and not self-like
  if (!alreadyLiked && post.userId !== userId) {
    addNotification(post.userId, {
      id: uuidv4(),
      type: 'like',
      fromUserId: userId,
      postId,
      read: false,
      createdAt: new Date().toISOString(),
    });
    persistNotifications();
  }

  res.json({ liked: true, likeCount });
}));

// ── Unlike Post ──
router.delete('/:postId/like', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  removeLike(userId, postId);
  const likeCount = updatePostLikeCount(postId);
  persistLikes();
  persistPosts();

  res.json({ liked: false, likeCount });
}));

// ── Create Comment ──
router.post('/:postId/comments', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const { content, displayName, chatUserId, parentCommentId } = req.body;

  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required and must be a non-empty string' });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: 'content exceeds max length of 2000' });
  }

  // Threading: validate parent_comment_id is a real comment on THIS post
  let parentId = null;
  if (parentCommentId) {
    if (typeof parentCommentId !== 'string' || parentCommentId.length > 64) {
      return res.status(400).json({ error: 'parentCommentId must be a string id' });
    }
    const parent = getCommentById(parentCommentId);
    if (!parent || parent.postId !== postId) {
      return res.status(400).json({ error: 'parent comment not found on this post' });
    }
    parentId = parentCommentId;
  }

  const profanityCheck = checkProfanity(content);
  if (profanityCheck.hasProfanity) {
    return res.status(422).json({
      error: 'Comment contains prohibited language',
      matched: profanityCheck.matched,
    });
  }

  const sanitizeDisplayField = (v, len) => {
    if (v == null || typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t.slice(0, len) : null;
  };

  const comment = {
    id: uuidv4(),
    postId,
    userId,
    windyIdentityId: req.user.windy_identity_id || null,
    displayName: sanitizeDisplayField(displayName, 100),
    chatUserId: sanitizeDisplayField(chatUserId, 64),
    parentCommentId: parentId,
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };

  addComment(comment);

  // Notify post author (if not self-comment)
  if (post.userId !== userId) {
    addNotification(post.userId, {
      id: uuidv4(),
      type: 'comment',
      fromUserId: userId,
      postId,
      read: false,
      createdAt: new Date().toISOString(),
    });
    persistNotifications();
  }
  // Notify the parent commenter if this is a reply to someone else
  if (parentId) {
    const parent = getCommentById(parentId);
    if (parent && parent.userId !== userId) {
      addNotification(parent.userId, {
        id: uuidv4(),
        type: 'comment_reply',
        fromUserId: userId,
        postId,
        read: false,
        createdAt: new Date().toISOString(),
      });
      persistNotifications();
    }
  }

  // Enrich response with the same shape GET /comments returns
  res.status(201).json({
    ...comment,
    likeCount: 0,
    liked: false,
  });
}));

// ── Get Comments ──
router.get('/:postId/comments', optionalAuth, asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const viewerUserId = req.user ? req.user.sub : null;
  const comments = getCommentsForPost(postId).map(c => ({
    ...c,
    likeCount: getCommentLikeCount(c.id),
    liked: viewerUserId ? hasCommentLike(viewerUserId, c.id) : false,
  }));
  res.json({ comments, count: comments.length });
}));

// ── Like Comment ──
router.post('/:postId/comments/:commentId/like', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId, commentId } = req.params;
  const comment = getCommentById(commentId);
  if (!comment || comment.postId !== postId) {
    return res.status(404).json({ error: 'Comment not found' });
  }
  const alreadyLiked = hasCommentLike(userId, commentId);
  addCommentLike(userId, commentId);
  const likeCount = updateCommentLikeCount(commentId);

  // Notify the commenter (idempotent: only on the first like)
  if (!alreadyLiked && comment.userId !== userId) {
    addNotification(comment.userId, {
      id: uuidv4(),
      type: 'comment_like',
      fromUserId: userId,
      postId,
      read: false,
      createdAt: new Date().toISOString(),
    });
    persistNotifications();
  }

  res.json({ liked: true, likeCount });
}));

// ── Unlike Comment ──
router.delete('/:postId/comments/:commentId/like', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId, commentId } = req.params;
  const comment = getCommentById(commentId);
  if (!comment || comment.postId !== postId) {
    return res.status(404).json({ error: 'Comment not found' });
  }
  removeCommentLike(userId, commentId);
  const likeCount = updateCommentLikeCount(commentId);
  res.json({ liked: false, likeCount });
}));

// ── Agent Auto-Post (service-to-service) ──
router.post('/agent', serviceTokenAuth, asyncHandler(async (req, res) => {
  const { agent_user_id, content, passport_number } = req.body;

  if (!agent_user_id || typeof agent_user_id !== 'string') {
    return res.status(400).json({ error: 'agent_user_id is required' });
  }
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required and must be a non-empty string' });
  }
  if (content.length > MAX_POST_LENGTH) {
    return res.status(400).json({ error: `content exceeds max length of ${MAX_POST_LENGTH}` });
  }

  // Profanity filter
  const profanityCheck = checkProfanity(content);
  if (profanityCheck.hasProfanity) {
    return res.status(422).json({
      error: 'Post contains prohibited language',
      matched: profanityCheck.matched,
    });
  }

  // Auto-set verified badge if passport is registered
  if (passport_number && typeof passport_number === 'string') {
    verifiedAccounts.add(agent_user_id);
  }

  const now = new Date().toISOString();
  const post = {
    id: uuidv4(),
    userId: agent_user_id,
    windyIdentityId: null,
    content: content.trim(),
    translated_versions: null,
    createdAt: now,
    updatedAt: now,
    likeCount: 0,
    visibility: 'public',
    mediaIds: null,
    repostOf: null,
    verified: verifiedAccounts.has(agent_user_id),
  };

  postsMap.set(post.id, post);
  persistPosts();

  // Extract and save hashtags
  saveHashtags(post.id, post.content, now);

  console.log(`[social] Agent post: ${agent_user_id} posted ${post.id}`);

  res.status(201).json(post);
}));

// ── Delete Post ──
router.delete('/:postId', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (post.userId !== userId) {
    return res.status(403).json({ error: 'You can only delete your own posts' });
  }

  postsMap.delete(postId);
  persistPosts();
  persistLikes();

  res.json({ deleted: true, postId });
}));

module.exports = router;
