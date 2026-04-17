/**
 * Windy Chat — Agent Discovery Routes
 * K3: Bot Directory — Eternitas-verified agent listing
 *
 * Endpoints:
 *   GET /api/v1/chat/directory/agents — list all discoverable agents
 */

const express = require('express');
const http = require('http');
const https = require('https');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../shared/async-handler');
const { getTrustProfile, clearanceMeets, isActive } = require('../../shared/trust-client');
const dirDb = require('../lib/db');

const router = express.Router();

const ETERNITAS_API_URL = process.env.ETERNITAS_API_URL || process.env.ETERNITAS_URL || 'https://api.eternitas.ai';

// ── Caller classification ──
//
// Humans authenticate with a Windy Pro JWT — no `passport_id` / `eternitas_passport`
// claim. Bots authenticate with an Eternitas JWT (EPT) where that claim is
// present. Humans bypass every trust gate; bots are gated on the claims in
// their Eternitas trust profile.
function callerPassport(req) {
  return req.user?.passport_id || req.user?.eternitas_passport || null;
}
function isHumanCaller(req) {
  return !callerPassport(req);
}

const agentListLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Schema: agent_directory table ──
dirDb.db.exec(`
CREATE TABLE IF NOT EXISTS agent_directory (
  passport_number TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'assistant',
  trust_score INTEGER,
  clearance_level TEXT,
  operator_name TEXT,
  avatar_url TEXT,
  discoverable INTEGER DEFAULT 1,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_directory_category ON agent_directory(category);
CREATE INDEX IF NOT EXISTS idx_agent_directory_trust ON agent_directory(trust_score);
CREATE INDEX IF NOT EXISTS idx_agent_directory_discoverable ON agent_directory(discoverable);
`);

const listAgents = dirDb.db.prepare(`
  SELECT * FROM agent_directory
  WHERE discoverable = 1
  AND (@category IS NULL OR category = @category)
  AND (@min_trust IS NULL OR trust_score >= @min_trust)
  AND (@search IS NULL OR agent_name LIKE @search)
  ORDER BY trust_score DESC
  LIMIT @limit OFFSET @offset
`);

const countAgents = dirDb.db.prepare(`
  SELECT COUNT(*) as cnt FROM agent_directory
  WHERE discoverable = 1
  AND (@category IS NULL OR category = @category)
  AND (@min_trust IS NULL OR trust_score >= @min_trust)
  AND (@search IS NULL OR agent_name LIKE @search)
`);

const upsertAgent = dirDb.db.prepare(`
  INSERT OR REPLACE INTO agent_directory
    (passport_number, agent_name, description, category, trust_score, clearance_level, operator_name, avatar_url, discoverable, registered_at, updated_at)
  VALUES (@passport_number, @agent_name, @description, @category, @trust_score, @clearance_level, @operator_name, @avatar_url, @discoverable, @registered_at, @updated_at)
`);

const getAgent = dirDb.db.prepare('SELECT * FROM agent_directory WHERE passport_number = ?');

// ── GET /api/v1/chat/directory/agents — list discoverable agents ──

router.get('/agents', agentListLimiter, asyncHandler(async (req, res) => {
  const {
    q: search,
    category,
    min_trust,
    limit: limitStr,
    offset: offsetStr,
  } = req.query;

  const limit = Math.min(Math.max(parseInt(limitStr) || 20, 1), 100);
  const offset = Math.max(parseInt(offsetStr) || 0, 0);
  const minTrust = min_trust ? parseInt(min_trust) : null;

  const params = {
    category: category || null,
    min_trust: minTrust,
    search: search ? `%${search}%` : null,
    limit,
    offset,
  };

  const agents = listAgents.all(params);
  const total = countAgents.get(params).cnt;

  res.json({
    agents: agents.map(a => ({
      passport_number: a.passport_number,
      agent_name: a.agent_name,
      description: a.description,
      category: a.category,
      trust_score: a.trust_score,
      clearance_level: a.clearance_level,
      operator_name: a.operator_name,
      avatar_url: a.avatar_url,
      registered_at: a.registered_at,
    })),
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  });
}));

// ── GET /api/v1/chat/directory/agents/:passportNumber — get single agent ──

router.get('/agents/:passportNumber', asyncHandler(async (req, res) => {
  const agent = getAgent.get(req.params.passportNumber);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  res.json({
    passport_number: agent.passport_number,
    agent_name: agent.agent_name,
    description: agent.description,
    category: agent.category,
    trust_score: agent.trust_score,
    clearance_level: agent.clearance_level,
    operator_name: agent.operator_name,
    avatar_url: agent.avatar_url,
    registered_at: agent.registered_at,
  });
}));

// ── POST /api/v1/chat/directory/agents/register — register/update agent in directory (service-to-service) ──

router.post('/agents/register', asyncHandler(async (req, res) => {
  const { passport_number, agent_name, description, category, trust_score, clearance_level, operator_name, avatar_url } = req.body;

  if (!passport_number || typeof passport_number !== 'string') {
    return res.status(400).json({ error: 'passport_number is required' });
  }
  if (!agent_name || typeof agent_name !== 'string') {
    return res.status(400).json({ error: 'agent_name is required' });
  }

  const now = new Date().toISOString();
  const existing = getAgent.get(passport_number);

  upsertAgent.run({
    passport_number,
    agent_name: agent_name.replace(/<[^>]*>/g, '').trim(),
    description: (description || '').slice(0, 500),
    category: category || 'assistant',
    trust_score: typeof trust_score === 'number' ? Math.max(0, Math.min(1000, trust_score)) : null,
    clearance_level: clearance_level || null,
    operator_name: operator_name || null,
    avatar_url: avatar_url || null,
    discoverable: 1,
    registered_at: existing?.registered_at || now,
    updated_at: now,
  });

  console.log(`[agents] Registered: ${agent_name} (${passport_number}) trust=${trust_score || 'n/a'}`);

  res.status(existing ? 200 : 201).json({ registered: true, passport_number });
}));

// ── Trust Gates (Wave 3, updated for Eternitas live contract in Wave 4) ──
//
// Service-to-service authorization for agent actions. Callers (e.g. Fly,
// the social service, the chat client on behalf of a bot) POST here BEFORE
// performing the action; a 200 with `{allowed: true}` means the gate
// cleared, anything else means deny.
//
// Contract: /Users/thewindstorm/eternitas/docs/trust-api.md
//
// Enforcement rules:
//   1. bot→bot DM        : sender AND recipient must have 'dm_bots' in allowed_actions
//   2. bot→public feed   : sender must have 'broadcast' in allowed_actions
//   3. bot→disconnected human mention : sender clearance_level ≥ 'top_secret'
//      (Eternitas also exposes 'mention_strangers' as a discrete action —
//       either signal denying is sufficient)
//
// Humans (Pro JWT without a passport claim) always bypass — the gates exist
// only to restrict what *bots* can do. All gates additionally require
// status='active' and band !== 'critical' (isActive helper).

async function requireAllowedAction(passport, action) {
  const profile = await getTrustProfile(passport);
  if (!profile) {
    return { ok: false, reason: 'trust_api_unreachable' };
  }
  if (profile.status === 'not_found') {
    return { ok: false, reason: 'passport_not_found', profile };
  }
  if (!isActive(profile)) {
    return {
      ok: false,
      reason: 'passport_not_active',
      status: profile.status,
      band: profile.band,
      profile,
    };
  }
  if (!profile.allowed_actions.includes(action)) {
    return { ok: false, reason: 'missing_allowed_action', required: action, profile };
  }
  return { ok: true, profile };
}

// POST /api/v1/chat/directory/agents/gate/dm
// Body: { recipient_passport: string }
// Sender passport is taken from the caller's JWT claims.
router.post('/agents/gate/dm', asyncHandler(async (req, res) => {
  if (isHumanCaller(req)) {
    return res.json({ allowed: true, caller: 'human', gate: 'dm' });
  }
  const sender = callerPassport(req);
  const { recipient_passport } = req.body || {};
  if (!recipient_passport || typeof recipient_passport !== 'string') {
    return res.status(400).json({ error: 'recipient_passport is required' });
  }

  const s = await requireAllowedAction(sender, 'dm_bots');
  if (!s.ok) {
    return res.status(403).json({
      allowed: false, gate: 'dm', side: 'sender', sender, ...s,
    });
  }
  const r = await requireAllowedAction(recipient_passport, 'dm_bots');
  if (!r.ok) {
    return res.status(403).json({
      allowed: false, gate: 'dm', side: 'recipient', recipient: recipient_passport, ...r,
    });
  }
  return res.json({ allowed: true, gate: 'dm', sender, recipient: recipient_passport });
}));

// POST /api/v1/chat/directory/agents/gate/broadcast
router.post('/agents/gate/broadcast', asyncHandler(async (req, res) => {
  if (isHumanCaller(req)) {
    return res.json({ allowed: true, caller: 'human', gate: 'broadcast' });
  }
  const sender = callerPassport(req);
  const s = await requireAllowedAction(sender, 'broadcast');
  if (!s.ok) {
    return res.status(403).json({ allowed: false, gate: 'broadcast', sender, ...s });
  }
  return res.json({ allowed: true, gate: 'broadcast', sender });
}));

// POST /api/v1/chat/directory/agents/gate/mention
// Body: { target_matrix_id?: string, is_connected: boolean }
// Gate only fires when the bot is mentioning a human it's NOT connected to.
router.post('/agents/gate/mention', asyncHandler(async (req, res) => {
  if (isHumanCaller(req)) {
    return res.json({ allowed: true, caller: 'human', gate: 'mention' });
  }
  const sender = callerPassport(req);
  const { is_connected, target_matrix_id } = req.body || {};

  // Only the *disconnected* case is gated — connected mentions are free
  if (is_connected === true) {
    return res.json({ allowed: true, gate: 'mention', reason: 'already_connected', sender, target_matrix_id: target_matrix_id || null });
  }
  if (typeof is_connected !== 'boolean') {
    return res.status(400).json({ error: 'is_connected (boolean) is required' });
  }

  const profile = await getTrustProfile(sender);
  if (!profile) {
    return res.status(403).json({ allowed: false, gate: 'mention', reason: 'trust_api_unreachable', sender });
  }
  if (!isActive(profile)) {
    return res.status(403).json({
      allowed: false, gate: 'mention', reason: 'passport_not_active',
      status: profile.status, band: profile.band, sender,
    });
  }
  if (!clearanceMeets(profile.clearance_level, 'top_secret')) {
    return res.status(403).json({
      allowed: false, gate: 'mention', reason: 'insufficient_clearance',
      required: 'top_secret', actual: profile.clearance_level, sender,
    });
  }
  return res.json({ allowed: true, gate: 'mention', sender, clearance_level: profile.clearance_level });
}));

module.exports = router;
