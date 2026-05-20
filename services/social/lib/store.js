/**
 * Windy Chat — Social Service Data Store
 * SQLite-backed store using better-sqlite3.
 * Proxy objects mimic the old Map/Set interface for backward compatibility.
 */

const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// In test runs the social app gets imported by multiple test files,
// sometimes in separate Node processes (`node --test tests/a.js tests/b.js`).
// A single shared social.db WAL file then hits SQLITE_BUSY under load.
// Isolating per-process under a PID-scoped tempdir keeps tests independent
// without touching production behavior — outside tests the shared
// services/social/data path is still used.
const DATA_DIR = process.env.NODE_ENV === 'test'
  ? fs.mkdtempSync(path.join(os.tmpdir(), `windy-social-${process.pid}-`))
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'social.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  windy_identity_id TEXT,
  content TEXT NOT NULL,
  translated_versions TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  like_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_windy_identity_id ON posts(windy_identity_id);
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followed_id TEXT NOT NULL,
  PRIMARY KEY (follower_id, followed_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);

CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  post_id TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  post_author_id TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_post_id ON reports(post_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_by ON reports(reported_by);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

CREATE TABLE IF NOT EXISTS verified_accounts (
  user_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(id, content, content='posts', content_rowid='rowid');
`);

// ── Migrations (ALTER TABLE) ───────────────────────────────────────────────

// Feature 2: Privacy Controls — add visibility column
try {
  db.exec("ALTER TABLE posts ADD COLUMN visibility TEXT DEFAULT 'public'");
} catch (_e) { /* column already exists */ }

// Feature 3: Media in Posts — add media_ids column
try {
  db.exec("ALTER TABLE posts ADD COLUMN media_ids TEXT");
} catch (_e) { /* column already exists */ }

// Feature 5: Repost/Share — add repost_of column
try {
  db.exec("ALTER TABLE posts ADD COLUMN repost_of TEXT");
} catch (_e) { /* column already exists */ }

// PR #69 follow-up: author display snapshot columns. Stored at post-create
// time so the feed can render "Grant Whitmer @grantwhitmer3" without
// joining against an external profile service for every page load.
try {
  db.exec("ALTER TABLE posts ADD COLUMN display_name TEXT");
} catch (_e) { /* column already exists */ }
try {
  db.exec("ALTER TABLE posts ADD COLUMN chat_user_id TEXT");
} catch (_e) { /* column already exists */ }

// Feature 6: Hashtags + Trending
db.exec(`
CREATE TABLE IF NOT EXISTS hashtags (
  tag TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tag, post_id)
);
CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags(tag);
CREATE INDEX IF NOT EXISTS idx_hashtags_created_at ON hashtags(created_at);
`);

// ── FTS Triggers ────────────────────────────────────────────────────────────

// Rebuild FTS index from current posts (safe to run multiple times)
try {
  db.exec(`INSERT INTO posts_fts(posts_fts) VALUES('rebuild')`);
} catch { /* FTS rebuild may fail if table is already synced, that's fine */ }

// Keep FTS in sync with posts table via triggers
db.exec(`
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(id, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, id, content) VALUES('delete', old.rowid, old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, id, content) VALUES('delete', old.rowid, old.id, old.content);
  INSERT INTO posts_fts(id, content) VALUES (new.id, new.content);
END;
`);

// ── Prepared Statements ─────────────────────────────────────────────────────

// Posts
const getPost = db.prepare('SELECT * FROM posts WHERE id = ?');
const getAllPosts = db.prepare('SELECT * FROM posts');
const upsertPost = db.prepare(`
  INSERT INTO posts (id, user_id, windy_identity_id, display_name, chat_user_id, content, translated_versions, created_at, updated_at, like_count, visibility, media_ids, repost_of)
  VALUES (@id, @user_id, @windy_identity_id, @display_name, @chat_user_id, @content, @translated_versions, @created_at, @updated_at, @like_count, @visibility, @media_ids, @repost_of)
  ON CONFLICT(id) DO UPDATE SET
    content = @content,
    translated_versions = @translated_versions,
    updated_at = @updated_at,
    like_count = @like_count,
    visibility = @visibility,
    media_ids = @media_ids,
    repost_of = @repost_of,
    display_name = COALESCE(@display_name, posts.display_name),
    chat_user_id = COALESCE(@chat_user_id, posts.chat_user_id)
`);
const deletePostStmt = db.prepare('DELETE FROM posts WHERE id = ?');

// Follows
const getFollowing = db.prepare('SELECT followed_id FROM follows WHERE follower_id = ?');
const getFollowers = db.prepare('SELECT follower_id FROM follows WHERE followed_id = ?');
const insertFollow = db.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)');
const deleteFollow = db.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?');
const isFollowingStmt = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?');
const deleteAllFollowsFor = db.prepare('DELETE FROM follows WHERE follower_id = ?');

// Likes
const getLikes = db.prepare('SELECT user_id FROM likes WHERE post_id = ?');
const insertLike = db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)');
const deleteLike = db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?');
const hasLikeStmt = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?');
const getLikeCountStmt = db.prepare('SELECT COUNT(*) as cnt FROM likes WHERE post_id = ?');
const deleteAllLikesForPost = db.prepare('DELETE FROM likes WHERE post_id = ?');

// Notifications
const getNotifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC');
const insertNotification = db.prepare(`
  INSERT INTO notifications (id, user_id, type, from_user_id, post_id, read, created_at)
  VALUES (@id, @user_id, @type, @from_user_id, @post_id, @read, @created_at)
`);
const markNotificationRead = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?');
const deleteAllNotificationsFor = db.prepare('DELETE FROM notifications WHERE user_id = ?');

// Reports
const getReport = db.prepare('SELECT * FROM reports WHERE id = ?');
const getAllReports = db.prepare('SELECT * FROM reports');
const upsertReport = db.prepare(`
  INSERT INTO reports (id, post_id, post_author_id, reported_by, reason, description, status, created_at)
  VALUES (@id, @post_id, @post_author_id, @reported_by, @reason, @description, @status, @created_at)
  ON CONFLICT(id) DO UPDATE SET
    status = @status,
    description = @description
`);
const checkDuplicateReport = db.prepare('SELECT 1 FROM reports WHERE post_id = ? AND reported_by = ?');

// Search (FTS5)
const searchPosts = db.prepare(`
  SELECT p.* FROM posts p
  JOIN posts_fts fts ON p.id = fts.id
  WHERE posts_fts MATCH ?
  ORDER BY p.created_at DESC
  LIMIT ?
`);

// Fallback search (LIKE) for simple queries
const searchPostsLike = db.prepare(`
  SELECT * FROM posts WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?
`);

// Comments
const getCommentsByPost = db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC');
const insertComment = db.prepare(`
  INSERT INTO comments (id, post_id, user_id, content, created_at)
  VALUES (@id, @post_id, @user_id, @content, @created_at)
`);
const getComment = db.prepare('SELECT * FROM comments WHERE id = ?');
const deleteComment = db.prepare('DELETE FROM comments WHERE id = ?');
const getCommentCount = db.prepare('SELECT COUNT(*) as cnt FROM comments WHERE post_id = ?');

// Verified
const getVerified = db.prepare('SELECT 1 FROM verified_accounts WHERE user_id = ?');
const addVerifiedStmt = db.prepare('INSERT OR IGNORE INTO verified_accounts (user_id) VALUES (?)');
const deleteVerifiedStmt = db.prepare('DELETE FROM verified_accounts WHERE user_id = ?');

// ── JSON Migration ──────────────────────────────────────────────────────────

function loadJSON(filename, fallback) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function migrateFromJSON() {
  const postCount = db.prepare('SELECT COUNT(*) as cnt FROM posts').get().cnt;
  if (postCount > 0) return; // already have data, skip migration

  const migrateAll = db.transaction(() => {
    // Posts
    const postsData = loadJSON('posts.json', []);
    for (const p of postsData) {
      upsertPost.run({
        id: p.id,
        user_id: p.userId,
        windy_identity_id: p.windyIdentityId || null,
        display_name: p.displayName || null,
        chat_user_id: p.chatUserId || null,
        content: p.content,
        translated_versions: p.translated_versions ? JSON.stringify(p.translated_versions) : null,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
        like_count: p.likeCount || 0,
        visibility: p.visibility || 'public',
        media_ids: p.mediaIds ? JSON.stringify(p.mediaIds) : null,
        repost_of: p.repostOf || null,
      });
    }

    // Follows
    const followsData = loadJSON('follows.json', {});
    for (const [uid, list] of Object.entries(followsData)) {
      for (const followedId of list) {
        insertFollow.run(uid, followedId);
      }
    }

    // Likes
    const likesData = loadJSON('likes.json', {});
    for (const [postId, users] of Object.entries(likesData)) {
      for (const userId of users) {
        insertLike.run(userId, postId);
      }
    }

    // Notifications
    const notificationsData = loadJSON('notifications.json', {});
    for (const [uid, list] of Object.entries(notificationsData)) {
      for (const n of list) {
        insertNotification.run({
          id: n.id,
          user_id: uid,
          type: n.type,
          from_user_id: n.fromUserId,
          post_id: n.postId || null,
          read: n.read ? 1 : 0,
          created_at: n.createdAt,
        });
      }
    }

    // Reports
    const reportsData = loadJSON('reports.json', []);
    for (const r of reportsData) {
      upsertReport.run({
        id: r.id,
        post_id: r.postId,
        post_author_id: r.postAuthorId,
        reported_by: r.reportedBy,
        reason: r.reason,
        description: r.description || null,
        status: r.status || 'pending',
        created_at: r.createdAt,
      });
    }

    // Verified accounts
    const verifiedData = loadJSON('verified.json', []);
    for (const userId of verifiedData) {
      addVerifiedStmt.run(userId);
    }
  });

  migrateAll();
}

migrateFromJSON();

// ── Row → Object Helpers ────────────────────────────────────────────────────

function rowToPost(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    windyIdentityId: row.windy_identity_id || null,
    displayName: row.display_name || null,
    chatUserId: row.chat_user_id || null,
    content: row.content,
    translated_versions: row.translated_versions ? JSON.parse(row.translated_versions) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    likeCount: row.like_count,
    visibility: row.visibility || 'public',
    mediaIds: row.media_ids ? JSON.parse(row.media_ids) : null,
    repostOf: row.repost_of || null,
  };
}

function rowToNotification(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    fromUserId: row.from_user_id,
    postId: row.post_id || undefined,
    read: !!row.read,
    createdAt: row.created_at,
  };
}

function rowToReport(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    postId: row.post_id,
    postAuthorId: row.post_author_id,
    reportedBy: row.reported_by,
    reason: row.reason,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ── Proxy Objects (Map/Set interface) ───────────────────────────────────────

const postsMap = {
  get(id) {
    return rowToPost(getPost.get(id));
  },
  set(id, post) {
    upsertPost.run({
      id,
      user_id: post.userId,
      windy_identity_id: post.windyIdentityId || null,
      display_name: post.displayName || null,
      chat_user_id: post.chatUserId || null,
      content: post.content,
      translated_versions: post.translated_versions ? JSON.stringify(post.translated_versions) : null,
      created_at: post.createdAt,
      updated_at: post.updatedAt,
      like_count: post.likeCount || 0,
      visibility: post.visibility || 'public',
      media_ids: post.mediaIds ? JSON.stringify(post.mediaIds) : null,
      repost_of: post.repostOf || null,
    });
  },
  has(id) {
    return !!getPost.get(id);
  },
  values() {
    return getAllPosts.all().map(rowToPost);
  },
  delete(id) {
    deletePostStmt.run(id);
  },
};

const followsMap = {
  get(userId) {
    const rows = getFollowing.all(userId);
    return rows.length > 0 ? new Set(rows.map(r => r.followed_id)) : undefined;
  },
  has(userId) {
    return getFollowing.all(userId).length > 0;
  },
  set(userId, followedSet) {
    // Bulk replace: remove all existing follows for this user, then insert new ones
    const replaceFollows = db.transaction(() => {
      deleteAllFollowsFor.run(userId);
      for (const followedId of followedSet) {
        insertFollow.run(userId, followedId);
      }
    });
    replaceFollows();
  },
};

const followersMap = {
  get(userId) {
    const rows = getFollowers.all(userId);
    return rows.length > 0 ? new Set(rows.map(r => r.follower_id)) : undefined;
  },
  has(userId) {
    return getFollowers.all(userId).length > 0;
  },
  set(_userId, _followerSet) {
    // No-op: followers are derived from the follows table
  },
};

const likesMap = {
  get(postId) {
    const rows = getLikes.all(postId);
    return rows.length > 0 ? new Set(rows.map(r => r.user_id)) : undefined;
  },
  has(postId) {
    return getLikes.all(postId).length > 0;
  },
  set(postId, userSet) {
    // Bulk replace
    const replaceLikes = db.transaction(() => {
      deleteAllLikesForPost.run(postId);
      for (const userId of userSet) {
        insertLike.run(userId, postId);
      }
    });
    replaceLikes();
  },
};

const notificationsMap = {
  get(userId) {
    const rows = getNotifications.all(userId);
    return rows.length > 0 ? rows.map(rowToNotification) : undefined;
  },
  has(userId) {
    return getNotifications.all(userId).length > 0;
  },
  set(userId, notifications) {
    // Bulk replace
    const replaceNotifications = db.transaction(() => {
      deleteAllNotificationsFor.run(userId);
      for (const n of notifications) {
        insertNotification.run({
          id: n.id,
          user_id: userId,
          type: n.type,
          from_user_id: n.fromUserId,
          post_id: n.postId || null,
          read: n.read ? 1 : 0,
          created_at: n.createdAt,
        });
      }
    });
    replaceNotifications();
  },
};

const reportsMap = {
  get(id) {
    return rowToReport(getReport.get(id));
  },
  set(id, report) {
    upsertReport.run({
      id,
      post_id: report.postId,
      post_author_id: report.postAuthorId,
      reported_by: report.reportedBy,
      reason: report.reason,
      description: report.description || null,
      status: report.status || 'pending',
      created_at: report.createdAt,
    });
  },
  has(id) {
    return !!getReport.get(id);
  },
  values() {
    return getAllReports.all().map(rowToReport);
  },
};

const verifiedAccounts = {
  has(userId) {
    return !!getVerified.get(userId);
  },
  add(userId) {
    addVerifiedStmt.run(userId);
  },
  delete(userId) {
    deleteVerifiedStmt.run(userId);
  },
};

// ── Mutation Functions (for operations that can't use proxy Sets) ───────────

function addLike(userId, postId) {
  insertLike.run(userId, postId);
}

function removeLike(userId, postId) {
  deleteLike.run(userId, postId);
}

function hasLike(userId, postId) {
  return !!hasLikeStmt.get(userId, postId);
}

function getLikeCount(postId) {
  return getLikeCountStmt.get(postId).cnt;
}

function addFollow(followerId, followedId) {
  insertFollow.run(followerId, followedId);
}

function removeFollow(followerId, followedId) {
  deleteFollow.run(followerId, followedId);
}

function isFollowing(followerId, followedId) {
  return !!isFollowingStmt.get(followerId, followedId);
}

function addNotification(userId, notification) {
  insertNotification.run({
    id: notification.id,
    user_id: userId,
    type: notification.type,
    from_user_id: notification.fromUserId,
    post_id: notification.postId || null,
    read: notification.read ? 1 : 0,
    created_at: notification.createdAt,
  });
}

function markNotificationsRead(userId, notificationIds) {
  const markMany = db.transaction(() => {
    let marked = 0;
    for (const id of notificationIds) {
      const info = markNotificationRead.run(id, userId);
      marked += info.changes;
    }
    return marked;
  });
  return markMany();
}

function hasDuplicateReport(postId, userId) {
  return !!checkDuplicateReport.get(postId, userId);
}

function searchPostContent(query, limit = 20) {
  try {
    // Try FTS5 first
    const rows = searchPosts.all(query, limit);
    return rows.map(rowToPost);
  } catch {
    // Fallback to LIKE
    const rows = searchPostsLike.all(`%${query}%`, limit);
    return rows.map(rowToPost);
  }
}

function rowToComment(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    content: row.content,
    createdAt: row.created_at,
  };
}

function addComment(comment) {
  insertComment.run({
    id: comment.id,
    post_id: comment.postId,
    user_id: comment.userId,
    content: comment.content,
    created_at: comment.createdAt,
  });
}

function getCommentsForPost(postId) {
  return getCommentsByPost.all(postId).map(rowToComment);
}

function getCommentCountForPost(postId) {
  return getCommentCount.get(postId).cnt;
}

function deleteCommentById(commentId) {
  return deleteComment.run(commentId);
}

function getCommentById(commentId) {
  return rowToComment(getComment.get(commentId));
}

function updatePostLikeCount(postId) {
  const count = getLikeCount(postId);
  db.prepare('UPDATE posts SET like_count = ? WHERE id = ?').run(count, postId);
  return count;
}

// ── Hashtag Functions ───────────────────────────────────────────────────────

const insertHashtag = db.prepare('INSERT OR IGNORE INTO hashtags (tag, post_id, created_at) VALUES (?, ?, ?)');
const deleteHashtagsForPost = db.prepare('DELETE FROM hashtags WHERE post_id = ?');
const getPostsByHashtag = db.prepare(`
  SELECT p.* FROM posts p
  JOIN hashtags h ON p.id = h.post_id
  WHERE h.tag = ?
  ORDER BY p.created_at DESC
  LIMIT ? OFFSET ?
`);
const getTrendingHashtags = db.prepare(`
  SELECT tag, COUNT(*) as post_count
  FROM hashtags
  WHERE created_at >= ?
  GROUP BY tag
  ORDER BY post_count DESC
  LIMIT 10
`);

/**
 * Extract hashtags from content.
 * Matches #word patterns (alphanumeric + underscore, 1-50 chars).
 */
function extractHashtags(content) {
  if (!content || typeof content !== 'string') return [];
  const matches = content.match(/#([a-zA-Z0-9_]{1,50})/g);
  if (!matches) return [];
  // Lowercase and deduplicate
  const tags = [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
  return tags;
}

/**
 * Save hashtags for a post (call after post creation).
 */
function saveHashtags(postId, content, createdAt) {
  const tags = extractHashtags(content);
  for (const tag of tags) {
    insertHashtag.run(tag, postId, createdAt);
  }
  return tags;
}

/**
 * Get posts by hashtag (paginated).
 */
function getPostsByTag(tag, limit = 20, offset = 0) {
  return getPostsByHashtag.all(tag.toLowerCase(), limit, offset).map(rowToPost);
}

/**
 * Get trending hashtags (last 7 days).
 */
function getTrending() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return getTrendingHashtags.all(sevenDaysAgo);
}

// ── Persist Functions (no-ops — SQLite auto-persists) ───────────────────────

function persistPosts() {}
function persistFollows() {}
function persistNotifications() {}
function persistReports() {}
function persistVerified() {}
function persistLikes() {}

// ── Eternitas verify cache ────────────────────────────────────────────
// Shared between server.js (reader via verifyWithEternitas) and
// routes/eternitas-webhook.js (invalidator on revoke/suspend/reinstate).
// Per P1-3, this cache MUST be flushed when a passport's status changes;
// the 1-hour TTL is just a backstop for the common case.
const eternitasVerifyCache = new Map(); // passportId → { valid, timestamp }
function flushEternitasVerifyCache(passportId) {
  return eternitasVerifyCache.delete(passportId);
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  db,
  postsMap,
  followsMap,
  followersMap,
  notificationsMap,
  reportsMap,
  verifiedAccounts,
  eternitasVerifyCache,
  flushEternitasVerifyCache,
  likesMap,
  persistPosts,
  persistFollows,
  persistNotifications,
  persistReports,
  persistVerified,
  persistLikes,
  // Mutation functions
  addLike,
  removeLike,
  hasLike,
  getLikeCount,
  addFollow,
  removeFollow,
  isFollowing,
  addNotification,
  markNotificationsRead,
  hasDuplicateReport,
  updatePostLikeCount,
  // Search
  searchPostContent,
  // Comments
  addComment,
  getCommentsForPost,
  getCommentCountForPost,
  deleteCommentById,
  getCommentById,
  // Hashtags
  extractHashtags,
  saveHashtags,
  getPostsByTag,
  getTrending,
};
