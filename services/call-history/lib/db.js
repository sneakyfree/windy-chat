/**
 * Call History Service — SQLite persistence layer
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'call-history.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS call_log (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  callee_id TEXT NOT NULL,
  caller_windy_identity_id TEXT,
  callee_windy_identity_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  call_type TEXT NOT NULL CHECK(call_type IN ('voice', 'video')),
  quality_score REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_log_caller ON call_log(caller_id);
CREATE INDEX IF NOT EXISTS idx_call_log_callee ON call_log(callee_id);
CREATE INDEX IF NOT EXISTS idx_call_log_started ON call_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_log_room ON call_log(room_id);
CREATE INDEX IF NOT EXISTS idx_call_log_caller_windy ON call_log(caller_windy_identity_id);
CREATE INDEX IF NOT EXISTS idx_call_log_callee_windy ON call_log(callee_windy_identity_id);
`);

const insertCall = db.prepare(`
  INSERT INTO call_log (id, room_id, caller_id, callee_id, caller_windy_identity_id, callee_windy_identity_id, started_at, ended_at, duration_seconds, call_type, quality_score, created_at)
  VALUES (@id, @room_id, @caller_id, @callee_id, @caller_windy_identity_id, @callee_windy_identity_id, @started_at, @ended_at, @duration_seconds, @call_type, @quality_score, @created_at)
`);

const getCall = db.prepare('SELECT * FROM call_log WHERE id = ?');

const getUserCalls = db.prepare(`
  SELECT * FROM call_log
  WHERE caller_id = ? OR callee_id = ?
  ORDER BY started_at DESC
  LIMIT ? OFFSET ?
`);

const getUserCallCount = db.prepare(`
  SELECT COUNT(*) as cnt FROM call_log
  WHERE caller_id = ? OR callee_id = ?
`);

const getUserStats = db.prepare(`
  SELECT
    COUNT(*) as total_calls,
    COALESCE(SUM(duration_seconds), 0) as total_seconds,
    COALESCE(AVG(duration_seconds), 0) as avg_duration
  FROM call_log
  WHERE caller_id = ? OR callee_id = ?
`);

const getUserCallsToday = db.prepare(`
  SELECT COUNT(*) as cnt FROM call_log
  WHERE (caller_id = ? OR callee_id = ?)
    AND started_at >= ?
`);

module.exports = {
  db,
  insertCall,
  getCall,
  getUserCalls,
  getUserCallCount,
  getUserStats,
  getUserCallsToday,
};
