/**
 * Onboarding Service — SQLite persistence layer
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'onboarding.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS display_names (
  name_lower TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  languages TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_display_names_user_id ON display_names(user_id);

CREATE TABLE IF NOT EXISTS user_profiles (
  chat_user_id TEXT PRIMARY KEY,
  windy_identity_id TEXT,
  display_name TEXT NOT NULL,
  languages TEXT,
  primary_language TEXT NOT NULL DEFAULT 'en',
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  onboarding_complete INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_windy_identity_id ON user_profiles(windy_identity_id);

CREATE TABLE IF NOT EXISTS pairing_sessions (
  session_id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  private_key BLOB,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  linked_account TEXT
);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_status ON pairing_sessions(status);

CREATE TABLE IF NOT EXISTS onboarding_state (
  windy_user_id TEXT PRIMARY KEY,
  verified INTEGER DEFAULT 0,
  profile_setup INTEGER DEFAULT 0,
  matrix_provisioned INTEGER DEFAULT 0,
  matrix_user_id TEXT,
  provisioned_at TEXT,
  passport_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_onboarding_state_passport ON onboarding_state(passport_id);

CREATE TABLE IF NOT EXISTS agent_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_user_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  agent_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(agent_user_id, owner_user_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_rooms_agent ON agent_rooms(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_rooms_owner ON agent_rooms(owner_user_id);

CREATE TABLE IF NOT EXISTS agent_credentials (
  agent_matrix_id TEXT PRIMARY KEY,
  owner_windy_id TEXT NOT NULL,
  passport_number TEXT,
  agent_name TEXT,
  access_token TEXT,
  hatched_at TEXT NOT NULL,
  welcomed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_credentials_owner ON agent_credentials(owner_windy_id);
CREATE INDEX IF NOT EXISTS idx_agent_credentials_pending ON agent_credentials(owner_windy_id, welcomed_at);
`);

// Personal-profile fields added 2026-05-20 so users can edit their bio and
// (eventually) avatar from the Profile tab. `bio` is plain text, capped at
// 280 chars at the API layer.
try { db.exec("ALTER TABLE user_profiles ADD COLUMN bio TEXT"); } catch (_e) { /* exists */ }

// Display names
const getDisplayName = db.prepare('SELECT * FROM display_names WHERE name_lower = ?');
const upsertDisplayName = db.prepare(`
  INSERT OR REPLACE INTO display_names (name_lower, user_id, display_name, languages, avatar_url, created_at)
  VALUES (@name_lower, @user_id, @display_name, @languages, @avatar_url, @created_at)
`);

// User profiles
const getProfile = db.prepare('SELECT * FROM user_profiles WHERE chat_user_id = ?');
const getProfileByWindyId = db.prepare('SELECT * FROM user_profiles WHERE windy_identity_id = ?');
const upsertProfile = db.prepare(`
  INSERT OR REPLACE INTO user_profiles (chat_user_id, windy_identity_id, display_name, languages, primary_language, avatar_url, created_at, onboarding_complete)
  VALUES (@chat_user_id, @windy_identity_id, @display_name, @languages, @primary_language, @avatar_url, @created_at, @onboarding_complete)
`);

const updateProfileAvatar = db.prepare('UPDATE user_profiles SET avatar_url = ? WHERE chat_user_id = ?');

// Self-edit by windy_identity_id — used by PATCH /api/v1/chat/profile/me to
// let the authenticated user update their own display info. COALESCE keeps
// untouched fields intact so a partial PATCH never wipes existing values.
const updateProfileByWindyId = db.prepare(`
  UPDATE user_profiles
     SET display_name = COALESCE(@display_name, display_name),
         avatar_url   = COALESCE(@avatar_url, avatar_url),
         bio          = COALESCE(@bio, bio),
         languages    = COALESCE(@languages, languages),
         primary_language = COALESCE(@primary_language, primary_language)
   WHERE windy_identity_id = @windy_identity_id
`);
const deleteProfile = db.prepare('DELETE FROM user_profiles WHERE chat_user_id = ?');
const deleteDisplayNameByUserId = db.prepare('DELETE FROM display_names WHERE user_id = ?');
const deleteOnboardingState = db.prepare('DELETE FROM onboarding_state WHERE windy_user_id = ?');

// Pairing sessions
const getSession = db.prepare('SELECT * FROM pairing_sessions WHERE session_id = ?');
const upsertSession = db.prepare(`
  INSERT OR REPLACE INTO pairing_sessions (session_id, pubkey, private_key, created_at, expires_at, status, linked_account)
  VALUES (@session_id, @pubkey, @private_key, @created_at, @expires_at, @status, @linked_account)
`);
const deleteSession = db.prepare('DELETE FROM pairing_sessions WHERE session_id = ?');
const deleteExpiredSessions = db.prepare('DELETE FROM pairing_sessions WHERE status = ? AND expires_at < ?');

// Onboarding state — migrate passport_id column for existing DBs
try {
  db.exec('ALTER TABLE onboarding_state ADD COLUMN passport_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_state_passport ON onboarding_state(passport_id)');
} catch { /* column already exists */ }

const getOnboardingState = db.prepare('SELECT * FROM onboarding_state WHERE windy_user_id = ?');
const getOnboardingStateByPassport = db.prepare('SELECT * FROM onboarding_state WHERE passport_id = ?');
const upsertOnboardingState = db.prepare(`
  INSERT OR REPLACE INTO onboarding_state (windy_user_id, verified, profile_setup, matrix_provisioned, matrix_user_id, provisioned_at, passport_id)
  VALUES (@windy_user_id, @verified, @profile_setup, @matrix_provisioned, @matrix_user_id, @provisioned_at, @passport_id)
`);

// JSON migration for profiles
function migrateFromJson() {
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM display_names').get().cnt;
  if (cnt > 0) return;

  const jsonFile = path.join(DATA_DIR, 'profiles.json');
  if (!fs.existsSync(jsonFile)) return;

  try {
    const raw = fs.readFileSync(jsonFile, 'utf-8');
    const data = JSON.parse(raw);

    const migrate = db.transaction(() => {
      if (data.displayNames) {
        for (const [key, val] of Object.entries(data.displayNames)) {
          upsertDisplayName.run({
            name_lower: key,
            user_id: val.userId,
            display_name: val.displayName,
            languages: JSON.stringify(val.languages || ['en']),
            avatar_url: val.avatarUrl || null,
            created_at: val.createdAt || new Date().toISOString(),
          });
        }
      }
      if (data.profiles) {
        for (const [key, val] of Object.entries(data.profiles)) {
          upsertProfile.run({
            chat_user_id: key,
            display_name: val.displayName,
            languages: JSON.stringify(val.languages || ['en']),
            primary_language: val.primaryLanguage || 'en',
            avatar_url: val.avatarUrl || null,
            created_at: val.createdAt || new Date().toISOString(),
            onboarding_complete: val.onboardingComplete ? 1 : 0,
          });
        }
      }
    });
    migrate();
    console.log('[Profile] Migrated data from profiles.json to SQLite');
  } catch (err) {
    console.error('[Profile] JSON migration failed:', err.message);
  }
}

migrateFromJson();

// Agent rooms
const getAgentRoom = db.prepare('SELECT * FROM agent_rooms WHERE agent_user_id = ? AND owner_user_id = ?');
// One-soul handoff: the agent-session route only knows the agent id.
const getAgentRoomByAgent = db.prepare(
  'SELECT * FROM agent_rooms WHERE agent_user_id = ? ORDER BY created_at DESC LIMIT 1'
);
const upsertAgentRoom = db.prepare(`
  INSERT OR REPLACE INTO agent_rooms (agent_user_id, owner_user_id, room_id, agent_name, created_at)
  VALUES (@agent_user_id, @owner_user_id, @room_id, @agent_name, @created_at)
`);
const getAgentRoomsByOwner = db.prepare('SELECT * FROM agent_rooms WHERE owner_user_id = ?');
const deleteAgentRoomsByAgent = db.prepare('DELETE FROM agent_rooms WHERE agent_user_id = ?');

// Agent credentials — persisted so we can impersonate an agent to seed a
// welcome DM when the owner first logs in (the agent may have hatched
// before the owner's Chat account existed).
const upsertAgentCredentials = db.prepare(`
  INSERT OR REPLACE INTO agent_credentials (
    agent_matrix_id, owner_windy_id, passport_number, agent_name,
    access_token, hatched_at, welcomed_at, created_at
  )
  VALUES (
    @agent_matrix_id, @owner_windy_id, @passport_number, @agent_name,
    @access_token, @hatched_at, @welcomed_at, @created_at
  )
`);
const getPendingAgentsForOwner = db.prepare(`
  SELECT * FROM agent_credentials
  WHERE owner_windy_id = ? AND welcomed_at IS NULL
  ORDER BY hatched_at ASC
`);
const markAgentWelcomed = db.prepare(
  'UPDATE agent_credentials SET welcomed_at = ? WHERE agent_matrix_id = ?'
);

module.exports = {
  db,
  getDisplayName,
  upsertDisplayName,
  getProfile,
  getProfileByWindyId,
  upsertProfile,
  updateProfileAvatar,
  updateProfileByWindyId,
  deleteProfile,
  deleteDisplayNameByUserId,
  deleteOnboardingState,
  getSession,
  upsertSession,
  deleteSession,
  deleteExpiredSessions,
  getOnboardingState,
  getOnboardingStateByPassport,
  upsertOnboardingState,
  getAgentRoom,
  getAgentRoomByAgent,
  upsertAgentRoom,
  getAgentRoomsByOwner,
  deleteAgentRoomsByAgent,
  upsertAgentCredentials,
  getPendingAgentsForOwner,
  markAgentWelcomed,
};
