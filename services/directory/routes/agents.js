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
const dirDb = require('../lib/db');

const router = express.Router();

const ETERNITAS_API_URL = process.env.ETERNITAS_API_URL || process.env.ETERNITAS_URL || 'https://api.eternitas.ai';

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

module.exports = router;
