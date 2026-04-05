/**
 * Windy Chat — Shared Analytics Module
 *
 * Tracks usage events to a SQLite database for engagement metrics.
 *
 * Usage:
 *   const { trackEvent, getAnalytics } = require('../shared/analytics');
 *   trackEvent('message_sent', userId, { room_type: 'dm', is_agent: true });
 */

const path = require('path');
const fs = require('fs');

// Lazy-load: analytics is optional — if better-sqlite3 isn't available, events are no-ops
let db = null;
try {
  const Database = require('better-sqlite3');
  const DATA_DIR = path.join(__dirname, '..', 'shared', 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'analytics.db'));
  db.pragma('journal_mode = WAL');
} catch {
  // better-sqlite3 not available in this context — analytics disabled
}

if (db) db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  user_id TEXT,
  properties TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
`);

const insertEvent = db?.prepare(`
  INSERT INTO events (event, user_id, properties, created_at)
  VALUES (?, ?, ?, ?)
`);

/**
 * Track an analytics event.
 * @param {string} event — event name (e.g., 'message_sent', 'agent_conversation_started')
 * @param {string|null} userId — user who triggered the event
 * @param {object} properties — additional event properties
 */
function trackEvent(event, userId, properties = {}) {
  if (!insertEvent) return;
  try {
    insertEvent.run(event, userId || null, JSON.stringify(properties), new Date().toISOString());
  } catch (err) {
    console.warn('[analytics] Failed to track event:', err.message);
  }
}

// ── Analytics Queries ──

const dauQuery = db?.prepare(`
  SELECT COUNT(DISTINCT user_id) as count
  FROM events WHERE created_at >= datetime('now', '-1 day') AND user_id IS NOT NULL
`);

const wauQuery = db?.prepare(`
  SELECT COUNT(DISTINCT user_id) as count
  FROM events WHERE created_at >= datetime('now', '-7 days') AND user_id IS NOT NULL
`);

const mauQuery = db?.prepare(`
  SELECT COUNT(DISTINCT user_id) as count
  FROM events WHERE created_at >= datetime('now', '-30 days') AND user_id IS NOT NULL
`);

const messagesPerDayQuery = db?.prepare(`
  SELECT
    date(created_at) as day,
    COUNT(*) as total,
    SUM(CASE WHEN json_extract(properties, '$.is_agent') = 1 THEN 1 ELSE 0 END) as agent_messages,
    SUM(CASE WHEN json_extract(properties, '$.is_agent') != 1 OR json_extract(properties, '$.is_agent') IS NULL THEN 1 ELSE 0 END) as human_messages
  FROM events
  WHERE event = 'message_sent' AND created_at >= datetime('now', '-30 days')
  GROUP BY date(created_at)
  ORDER BY day DESC
  LIMIT 30
`);

const topAgentsQuery = db?.prepare(`
  SELECT
    json_extract(properties, '$.agent_id') as agent_id,
    COUNT(*) as message_count
  FROM events
  WHERE event = 'message_sent'
    AND json_extract(properties, '$.is_agent') = 1
    AND created_at >= datetime('now', '-30 days')
  GROUP BY agent_id
  ORDER BY message_count DESC
  LIMIT 10
`);

const socialEngagementQuery = db?.prepare(`
  SELECT
    date(created_at) as day,
    SUM(CASE WHEN event = 'social_post_created' THEN 1 ELSE 0 END) as posts,
    SUM(CASE WHEN event = 'social_post_liked' THEN 1 ELSE 0 END) as likes,
    SUM(CASE WHEN event = 'user_followed' THEN 1 ELSE 0 END) as follows
  FROM events
  WHERE event IN ('social_post_created', 'social_post_liked', 'user_followed')
    AND created_at >= datetime('now', '-30 days')
  GROUP BY date(created_at)
  ORDER BY day DESC
  LIMIT 30
`);

const eventCountsQuery = db?.prepare(`
  SELECT event, COUNT(*) as count
  FROM events
  WHERE created_at >= datetime('now', '-30 days')
  GROUP BY event
  ORDER BY count DESC
`);

/**
 * Get analytics summary for the admin dashboard.
 */
function getAnalytics() {
  if (!db) return { error: 'Analytics not available', users: { dau: 0, wau: 0, mau: 0 }, messages_per_day: [], top_agents: [], social_engagement: [], event_counts: [] };
  return {
    users: {
      dau: dauQuery?.get()?.count || 0,
      wau: wauQuery?.get()?.count || 0,
      mau: mauQuery?.get()?.count || 0,
    },
    messages_per_day: messagesPerDayQuery?.all() || [],
    top_agents: topAgentsQuery?.all() || [],
    social_engagement: socialEngagementQuery?.all() || [],
    event_counts: eventCountsQuery?.all() || [],
  };
}

module.exports = { trackEvent, getAnalytics, db };
