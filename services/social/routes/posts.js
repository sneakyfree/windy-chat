/**
 * Windy Chat — Social Posts Routes
 * K10: Post CRUD, feed, likes, translation, Eternitas badge
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { asyncHandler } = require('../../shared/async-handler');
const { createAuthMiddleware } = require('../../shared/jwt-verify');
const { checkProfanity } = require('../lib/profanity');
const {
  postsMap, followsMap, likesMap, verifiedAccounts,
  notificationsMap,
  persistPosts, persistLikes, persistNotifications,
} = require('../lib/store');

const router = Router();
const auth = createAuthMiddleware();

const MAX_POST_LENGTH = 5000;
const PAGE_SIZE = 20;

// ── Create Post ──
router.post('/', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { content, translated_versions } = req.body;

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

  const post = {
    id: uuidv4(),
    userId,
    content: content.trim(),
    translated_versions: translated_versions || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    likeCount: 0,
    verified: verifiedAccounts.has(userId),
  };

  postsMap.set(post.id, post);
  persistPosts();

  res.status(201).json(post);
}));

// ── Get Single Post ──
router.get('/:postId', asyncHandler(async (req, res) => {
  const post = postsMap.get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  res.json({
    ...post,
    verified: verifiedAccounts.has(post.userId),
    likeCount: likesMap.has(post.id) ? likesMap.get(post.id).size : 0,
  });
}));

// ── Get User's Posts ──
router.get('/user/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const cursor = req.query.cursor;
  let posts = [...postsMap.values()]
    .filter(p => p.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (cursor) {
    const idx = posts.findIndex(p => p.id === cursor);
    if (idx >= 0) posts = posts.slice(idx + 1);
  }

  const page = posts.slice(0, PAGE_SIZE);
  const enriched = page.map(p => ({
    ...p,
    verified: verifiedAccounts.has(p.userId),
    likeCount: likesMap.has(p.id) ? likesMap.get(p.id).size : 0,
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

  if (cursor) {
    const idx = posts.findIndex(p => p.id === cursor);
    if (idx >= 0) posts = posts.slice(idx + 1);
  }

  const page = posts.slice(0, PAGE_SIZE);
  const enriched = page.map(p => ({
    ...p,
    verified: verifiedAccounts.has(p.userId),
    likeCount: likesMap.has(p.id) ? likesMap.get(p.id).size : 0,
  }));

  res.json({
    posts: enriched,
    count: enriched.length,
    cursor: enriched.length === PAGE_SIZE ? enriched[enriched.length - 1].id : null,
  });
}));

// ── Like Post ──
router.post('/:postId/like', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (!likesMap.has(postId)) likesMap.set(postId, new Set());
  const likes = likesMap.get(postId);
  const alreadyLiked = likes.has(userId);
  likes.add(userId);
  post.likeCount = likes.size;
  persistLikes();
  persistPosts();

  // Queue notification if this is a new like and not self-like
  if (!alreadyLiked && post.userId !== userId) {
    if (!notificationsMap.has(post.userId)) notificationsMap.set(post.userId, []);
    notificationsMap.get(post.userId).push({
      id: uuidv4(),
      type: 'like',
      fromUserId: userId,
      postId,
      read: false,
      createdAt: new Date().toISOString(),
    });
    persistNotifications();
  }

  res.json({ liked: true, likeCount: likes.size });
}));

// ── Unlike Post ──
router.delete('/:postId/like', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { postId } = req.params;
  const post = postsMap.get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const likes = likesMap.get(postId);
  if (likes) {
    likes.delete(userId);
    post.likeCount = likes.size;
    persistLikes();
    persistPosts();
  }

  res.json({ liked: false, likeCount: likes ? likes.size : 0 });
}));

module.exports = router;
