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
  saveHashtags, getPostsByTag, getTrending,
} = require('../lib/store');

const router = Router();
const auth = createAuthMiddleware();

// Service token auth for agent/bot endpoints (CHAT_SERVICE_TOKEN or CHAT_API_TOKEN)
const CHAT_SERVICE_TOKEN = process.env.CHAT_SERVICE_TOKEN || process.env.CHAT_API_TOKEN || '';

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

// ── Create Post ──
router.post('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { content, translated_versions, visibility, media_ids } = req.body;

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
router.get('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const following = followsMap.get(userId) || new Set();
  const cursor = req.query.cursor;

  // Include own posts + followed users' posts
  const feedUserIds = new Set([userId, ...following]);
  let posts = [...postsMap.values()]
    .filter(p => feedUserIds.has(p.userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
    };
    // Include original post data for reposts
    if (p.repostOf) {
      const original = postsMap.get(p.repostOf);
      if (original && canViewPost(original, userId)) {
        result.originalPost = {
          ...original,
          verified: verifiedAccounts.has(original.userId),
          likeCount: getLikeCount(original.id),
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
  const { content, visibility } = req.body;

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
  const { content } = req.body;

  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required and must be a non-empty string' });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: 'content exceeds max length of 2000' });
  }

  const profanityCheck = checkProfanity(content);
  if (profanityCheck.hasProfanity) {
    return res.status(422).json({
      error: 'Comment contains prohibited language',
      matched: profanityCheck.matched,
    });
  }

  const comment = {
    id: uuidv4(),
    postId,
    userId,
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

  res.status(201).json(comment);
}));

// ── Get Comments ──
router.get('/:postId/comments', asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const comments = getCommentsForPost(postId);
  res.json({ comments, count: comments.length });
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
