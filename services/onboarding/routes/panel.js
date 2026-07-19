/**
 * windy.panel.v1 — the agent control-panel API (DASHBOARD_API_CONTRACT.md).
 *
 * ONE thin settings surface for the owner's Type-B cloud agent, mounted at
 * /api/v1/agent/panel. This service owns the writes (it already owns
 * onboarding.db + the owner↔agent mapping); agent-roster reads the
 * agent_settings table per inbound message through its existing read-only
 * handle. No proxy hop, no second personality engine — a lookup table the
 * midwife consults (keep-hands-dumb).
 *
 * Auth: account-server RS256 JWT (shared jwt-verify middleware, applied at
 * mount). Ownership: the agent is looked up BY the token's identity claim —
 * no agent id in the URL. Mobile's X-Windy-Identity-Id header is ignored;
 * the JWT is authoritative.
 *
 * Shapes are gateway-compatible on purpose (windy-agent /api/sliders et al),
 * with the gateway's known warts fixed cloud-side: unknown slider → 400
 * (not 500). Anything the cloud agent has no substrate for → 501
 * {error:"not_supported", capability} so capability-driven UIs render an
 * honest empty state instead of a broken panel.
 */
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const {
  DEFAULT_VALUE,
  SLIDER_INFO,
  SUPPORTED_SLIDERS,
  withDefaults,
  matchPreset,
} = require('../lib/panel-sliders');

const router = express.Router();

const AGENT_ROSTER_URL = (process.env.AGENT_ROSTER_URL || 'http://agent-roster:8106').replace(/\/$/, '');

const CAPABILITIES = ['sliders', 'personality.history', 'identity'];

// 60/min per identity (contract §2.2, hub-service pattern).
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.windy_identity_id || req.user?.sub || req.ip,
  message: { error: 'Too many requests, slow down' },
}));

// Ownership: resolve the caller's agent from the JWT claims. No agent row →
// 404 no_agent so surfaces show their hatch CTA.
router.use((req, res, next) => {
  const identityId = req.user?.windy_identity_id || req.user?.sub;
  if (!identityId || identityId === 'service') {
    return res.status(401).json({ error: 'Missing identity claim' });
  }
  const agent = db.getAgentByOwnerWindyId.get(identityId);
  if (!agent) {
    return res.status(404).json({ error: 'no_agent', hint: 'not_provisioned' });
  }
  req.agent = agent;
  next();
});

function readSliders(agentMatrixId) {
  const row = db.getAgentSettings.get(agentMatrixId);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.sliders_json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Liveness from agent-roster's /status (same docker network, 800ms budget).
 * On any failure → "unknown" — never invent liveness (honest-analytics).
 */
async function fetchAgentStatus(agentMatrixId) {
  try {
    const res = await fetch(`${AGENT_ROSTER_URL}/status`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return { status: 'unknown', last_event_at: null, replies_sent: 0 };
    const data = await res.json();
    const runner = (data.runners || []).find((r) => r.matrixUserId === agentMatrixId);
    if (!runner) return { status: 'sleeping', last_event_at: null, replies_sent: 0 };
    return {
      status: runner.running ? 'alive' : 'sleeping',
      last_event_at: runner.lastEventAt || null,
      replies_sent: runner.repliesSent || 0,
    };
  } catch {
    return { status: 'unknown', last_event_at: null, replies_sent: 0 };
  }
}

// ── GET /summary ──
router.get('/summary', async (req, res) => {
  const agent = req.agent;
  const stored = readSliders(agent.agent_matrix_id);
  const live = await fetchAgentStatus(agent.agent_matrix_id);
  res.json({
    contract: 'windy.panel.v1',
    kind: 'cloud',
    capabilities: CAPABILITIES,
    agent: {
      agent_matrix_id: agent.agent_matrix_id,
      agent_name: agent.agent_name,
      passport_number: agent.passport_number || null,
      hatched_at: agent.hatched_at,
      status: live.status,
      last_event_at: live.last_event_at,
      replies_sent: live.replies_sent,
    },
    personality: {
      sliders: withDefaults(stored),
      preset: matchPreset(stored),
    },
  });
});

// ── GET /sliders ──
router.get('/sliders', (req, res) => {
  res.json({ sliders: withDefaults(readSliders(req.agent.agent_matrix_id)) });
});

// ── GET /sliders/info ──
router.get('/sliders/info', (req, res) => {
  const values = withDefaults(readSliders(req.agent.agent_matrix_id));
  const sliders = {};
  for (const name of SUPPORTED_SLIDERS) {
    sliders[name] = {
      ...SLIDER_INFO[name],
      value: values[name],
      cost_per_point: 0,
    };
  }
  res.json({ sliders });
});

// ── PUT /sliders/:name ──
router.put('/sliders/:name', (req, res) => {
  const name = req.params.name;
  if (!SUPPORTED_SLIDERS.includes(name)) {
    return res.status(400).json({
      error: 'unknown_slider',
      hint: `Supported sliders: ${SUPPORTED_SLIDERS.join(', ')}`,
    });
  }
  const value = req.body?.value;
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    return res.status(400).json({ error: 'invalid_value', hint: 'value must be an integer 0-10' });
  }
  // updated_by is an optional client label ('owner' default; presets send
  // 'preset:<name>'). Constrained so junk can't land in the audit trail.
  let changedBy = 'owner';
  if (typeof req.body?.updated_by === 'string') {
    if (!/^(owner|preset:[a-z_]+)$/.test(req.body.updated_by)) {
      return res.status(400).json({ error: 'invalid_updated_by' });
    }
    changedBy = req.body.updated_by;
  }

  const agentId = req.agent.agent_matrix_id;
  const now = new Date().toISOString();
  const stored = readSliders(agentId);
  const oldValue = Number.isInteger(stored[name]) ? stored[name] : DEFAULT_VALUE;

  // Store only non-default values: value 5 removes the key, so a slider set
  // back to default restores today's exact midwife behavior.
  const next = { ...stored };
  if (value === DEFAULT_VALUE) delete next[name];
  else next[name] = value;

  const write = db.db.transaction(() => {
    db.upsertAgentSettings.run({
      agent_matrix_id: agentId,
      sliders_json: JSON.stringify(next),
      updated_at: now,
      updated_by: changedBy,
    });
    if (oldValue !== value) {
      db.insertAgentSettingsHistory.run({
        agent_matrix_id: agentId,
        key: name,
        old_value: String(oldValue),
        new_value: String(value),
        changed_by: changedBy,
        created_at: now,
      });
    }
  });
  write();
  res.json({ success: true });
});

// ── GET /personality/history ──
router.get('/personality/history', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const rows = db.getAgentSettingsHistory.all(req.agent.agent_matrix_id, limit);
  res.json({
    history: rows.map((r) => ({
      id: r.id,
      key: r.key,
      // Mirrored for gateway-UI compat (the local dashboard reads soul_id).
      soul_id: r.key,
      old_value: r.old_value,
      new_value: r.new_value,
      changed_by: r.changed_by,
      created_at: r.created_at,
    })),
  });
});

// ── Everything else from the gateway surface → honest 501 ──
// Capability-driven UIs render an empty state for anything not in
// /summary.capabilities; this is the backstop for direct calls.
router.use((req, res) => {
  const segs = req.path.split('/').filter(Boolean);
  const capability = segs[0] === 'personality' && segs[1]
    ? `personality.${segs[1]}`
    : (segs[0] || 'unknown');
  res.status(501).json({ error: 'not_supported', capability });
});

module.exports = router;
