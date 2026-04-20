/**
 * Windy Chat — Call History Service
 * K5: VoIP / WebRTC Call Metadata (DNA Strand K)
 *
 * Tracks VoIP call metadata. Matrix handles actual calls via Coturn;
 * this service stores call history for the UI.
 *
 * Port: 8108
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createCorsMiddleware } = require('../shared/cors');
const { createHealthHandler } = require('../shared/health');
const { asyncHandler } = require('../shared/async-handler');
const { createAuthMiddleware } = require('../shared/jwt-verify');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');
const { bodyErrorHandler } = require('../shared/body-errors');
const callDb = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 8108;

app.use(createCorsMiddleware());
app.use(express.json({ limit: '1mb' }));

initSentry(app, 'windy-chat-call-history');

const auth = createAuthMiddleware();

// ── Health ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-call-history',
  version: '1.0.0',
}));

// ── Log a completed call ──
app.post('/api/v1/calls/log', auth, asyncHandler(async (req, res) => {
  const { room_id, caller_id, callee_id, started_at, ended_at, duration_seconds, call_type, quality_score } = req.body;

  if (!room_id || typeof room_id !== 'string') {
    return res.status(400).json({ error: 'room_id is required' });
  }
  if (!caller_id || typeof caller_id !== 'string') {
    return res.status(400).json({ error: 'caller_id is required' });
  }
  if (!callee_id || typeof callee_id !== 'string') {
    return res.status(400).json({ error: 'callee_id is required' });
  }
  if (!started_at || typeof started_at !== 'string') {
    return res.status(400).json({ error: 'started_at is required (ISO8601)' });
  }
  if (!ended_at || typeof ended_at !== 'string') {
    return res.status(400).json({ error: 'ended_at is required (ISO8601)' });
  }
  if (typeof duration_seconds !== 'number' || duration_seconds < 0) {
    return res.status(400).json({ error: 'duration_seconds must be a non-negative number' });
  }
  if (!call_type || !['voice', 'video'].includes(call_type)) {
    return res.status(400).json({ error: 'call_type must be "voice" or "video"' });
  }
  if (quality_score !== undefined && quality_score !== null) {
    if (typeof quality_score !== 'number' || quality_score < 0 || quality_score > 5) {
      return res.status(400).json({ error: 'quality_score must be between 0 and 5' });
    }
  }

  const callId = uuidv4();
  callDb.insertCall.run({
    id: callId,
    room_id,
    caller_id,
    callee_id,
    caller_windy_identity_id: req.user.windy_identity_id || null,
    callee_windy_identity_id: null,
    started_at,
    ended_at,
    duration_seconds,
    call_type,
    quality_score: quality_score ?? null,
    created_at: new Date().toISOString(),
  });

  console.log(`[call-history] Logged ${call_type} call: ${caller_id} → ${callee_id} (${duration_seconds}s)`);

  res.status(201).json({
    id: callId,
    room_id,
    caller_id,
    callee_id,
    started_at,
    ended_at,
    duration_seconds,
    call_type,
    quality_score: quality_score ?? null,
  });
}));

// ── Get user's call history ──
app.get('/api/v1/calls/history', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const rows = callDb.getUserCalls.all(userId, userId, limit, offset);
  const total = callDb.getUserCallCount.get(userId, userId).cnt;

  const calls = rows.map(row => ({
    id: row.id,
    room_id: row.room_id,
    other_user_id: row.caller_id === userId ? row.callee_id : row.caller_id,
    direction: row.caller_id === userId ? 'outgoing' : 'incoming',
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds,
    call_type: row.call_type,
    quality_score: row.quality_score,
  }));

  res.json({
    calls,
    count: calls.length,
    total,
    limit,
    offset,
  });
}));

// ── Aggregate stats ──
app.get('/api/v1/calls/stats', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;

  const stats = callDb.getUserStats.get(userId, userId);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const callsToday = callDb.getUserCallsToday.get(userId, userId, todayStart.toISOString()).cnt;

  res.json({
    total_calls: stats.total_calls,
    total_minutes: Math.round(stats.total_seconds / 60 * 10) / 10,
    avg_duration: Math.round(stats.avg_duration),
    calls_today: callsToday,
  });
}));

// ── Synapse Application Service — auto-log VoIP calls ──
const callAppservice = require('./appservice/handler');
app.use('/_matrix/app/v1', callAppservice);

// ── 404 ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use(bodyErrorHandler());
app.use(sentryErrorHandler());
app.use((err, _req, res, _next) => {
  console.error('[call-history] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[call-history] listening on :${PORT}`);
  });
}

module.exports = { app };
