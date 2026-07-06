/**
 * Windy Chat Hub — SQLite store.
 *
 * Two databases are touched:
 *   1. hub.db (OURS, read-write) — connected_platforms: which external
 *      networks each user has linked, keyed by their Matrix user id.
 *   2. onboarding.db (onboarding service's, READ-ONLY volume mount —
 *      same pattern as agent-roster) — used only to resolve
 *      windy_identity_id → matrix_user_id. Hub never writes it.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hub.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS connected_platforms (
  id TEXT PRIMARY KEY,
  matrix_user_id TEXT NOT NULL,
  windy_identity_id TEXT,
  platform TEXT NOT NULL,
  login_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'connecting',
  remote_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(matrix_user_id, platform, login_id)
);
CREATE INDEX IF NOT EXISTS idx_connected_platforms_user
  ON connected_platforms(matrix_user_id);
`);

const upsertConnection = db.prepare(`
  INSERT INTO connected_platforms
    (id, matrix_user_id, windy_identity_id, platform, login_id, state, remote_name, created_at, updated_at)
  VALUES
    (@id, @matrix_user_id, @windy_identity_id, @platform, @login_id, @state, @remote_name, @created_at, @updated_at)
  ON CONFLICT(matrix_user_id, platform, login_id) DO UPDATE SET
    state = excluded.state,
    remote_name = COALESCE(excluded.remote_name, connected_platforms.remote_name),
    updated_at = excluded.updated_at
`);

const listConnectionsForUser = db.prepare(
  'SELECT * FROM connected_platforms WHERE matrix_user_id = ? ORDER BY created_at'
);

const deleteConnection = db.prepare(
  'DELETE FROM connected_platforms WHERE matrix_user_id = ? AND platform = ? AND login_id = ?'
);

// ── onboarding.db (read-only) — identity → MXID resolution ──────────
// Opened lazily so tests / dev without the mount still boot.
let onboardingDb = null;
function getOnboardingDb() {
  if (onboardingDb) return onboardingDb;
  const p = process.env.ONBOARDING_DB_PATH || '/onboarding-data/onboarding.db';
  if (!fs.existsSync(p)) return null;
  onboardingDb = new Database(p, { readonly: true, fileMustExist: true });
  return onboardingDb;
}

/**
 * Resolve the caller's Matrix user id from their Windy JWT claims.
 * Order: onboarding_state (authoritative provision record) →
 * user_profiles (localpart) → null. SYNAPSE_SERVER_NAME builds the MXID
 * when only a localpart is known.
 */
function resolveMatrixUserId(claims) {
  const windyId = claims.windy_identity_id || claims.sub;
  if (!windyId) return null;
  const odb = getOnboardingDb();
  if (!odb) return null;
  try {
    const state = odb
      .prepare('SELECT matrix_user_id FROM onboarding_state WHERE windy_user_id = ?')
      .get(windyId);
    if (state && state.matrix_user_id) return state.matrix_user_id;
    const profile = odb
      .prepare('SELECT chat_user_id FROM user_profiles WHERE windy_identity_id = ?')
      .get(windyId);
    if (profile && profile.chat_user_id) {
      if (profile.chat_user_id.startsWith('@')) return profile.chat_user_id;
      const server = process.env.SYNAPSE_SERVER_NAME || 'chat.windychat.ai';
      return `@${profile.chat_user_id}:${server}`;
    }
  } catch (err) {
    console.error('[hub/db] onboarding lookup failed:', err.message);
  }
  return null;
}

module.exports = {
  db,
  upsertConnection,
  listConnectionsForUser,
  deleteConnection,
  resolveMatrixUserId,
};
