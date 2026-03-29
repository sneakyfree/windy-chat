/**
 * Windy Chat — Social Service Data Store
 * In-memory store with JSON file persistence (matches K2/K6/K8 pattern).
 * Will be replaced by PostgreSQL when shared DB migration lands.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadJSON(filename, fallback) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[social/store] Failed to persist ${filename}:`, err.message);
  }
}

// ── Posts ──
const postsMap = new Map();
const postsData = loadJSON('posts.json', []);
for (const p of postsData) postsMap.set(p.id, p);

// ── Follows: { userId: [followedId, ...] } ──
const followsMap = new Map();
const followsData = loadJSON('follows.json', {});
for (const [uid, list] of Object.entries(followsData)) followsMap.set(uid, new Set(list));

// ── Followers (reverse index): { userId: [followerIds...] } ──
const followersMap = new Map();
// Rebuild from follows
for (const [follower, followees] of followsMap.entries()) {
  for (const target of followees) {
    if (!followersMap.has(target)) followersMap.set(target, new Set());
    followersMap.get(target).add(follower);
  }
}

// ── Notifications ──
const notificationsMap = new Map();
const notificationsData = loadJSON('notifications.json', {});
for (const [uid, list] of Object.entries(notificationsData)) notificationsMap.set(uid, list);

// ── Reports ──
const reportsMap = new Map();
const reportsData = loadJSON('reports.json', []);
for (const r of reportsData) reportsMap.set(r.id, r);

// ── Eternitas verified accounts ──
const verifiedAccounts = new Set(loadJSON('verified.json', []));

// ── Likes: postId -> Set of userIds ──
const likesMap = new Map();
const likesData = loadJSON('likes.json', {});
for (const [postId, users] of Object.entries(likesData)) likesMap.set(postId, new Set(users));

// ── Persistence helpers ──

function persistPosts() {
  saveJSON('posts.json', [...postsMap.values()]);
}

function persistFollows() {
  const obj = {};
  for (const [uid, set] of followsMap.entries()) obj[uid] = [...set];
  saveJSON('follows.json', obj);
}

function persistNotifications() {
  const obj = {};
  for (const [uid, list] of notificationsMap.entries()) obj[uid] = list;
  saveJSON('notifications.json', obj);
}

function persistReports() {
  saveJSON('reports.json', [...reportsMap.values()]);
}

function persistVerified() {
  saveJSON('verified.json', [...verifiedAccounts]);
}

function persistLikes() {
  const obj = {};
  for (const [postId, set] of likesMap.entries()) obj[postId] = [...set];
  saveJSON('likes.json', obj);
}

module.exports = {
  postsMap,
  followsMap,
  followersMap,
  notificationsMap,
  reportsMap,
  verifiedAccounts,
  likesMap,
  persistPosts,
  persistFollows,
  persistNotifications,
  persistReports,
  persistVerified,
  persistLikes,
};
