/**
 * windy-chat agent-roster service
 *
 * Reads agent_credentials from chat-onboarding's SQLite DB (shared volume
 * mount), spawns one AgentRunner per hatched agent, and exposes /health
 * + /status for observability.
 *
 * This is the FOUNDATION for the grandma promise: every hatched agent
 * gets a live Matrix listener that replies to messages in its DM room.
 * Without this, the agent's Matrix account is a dead mailbox even though
 * the chat web app's UI looks like ChatGPT.
 *
 * Reconciliation cadence: every 30s, re-read agent_credentials and
 *   - start runners for any new agents
 *   - leave existing runners alone
 * (We don't shut down runners on agent removal in v0 — owner can revoke
 * the passport which triggers Synapse-side deactivation that the runner
 * will see as 401 and naturally stop.)
 */

const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { AgentRunner } = require('./lib/agent-runner');

const PORT = parseInt(process.env.PORT || '8106', 10);
const ONBOARDING_DB_PATH = process.env.ONBOARDING_DB_PATH
  || '/onboarding-data/onboarding.db';
const HOMESERVER = process.env.SYNAPSE_HOMESERVER || 'http://synapse:8008';
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || '30000', 10);

const STARTED_AT = new Date().toISOString();

// The roster is a Map from agent_matrix_id → AgentRunner. Lookup is the
// dedup key when reconciling against the DB.
const roster = new Map();

function openDb() {
  if (!fs.existsSync(ONBOARDING_DB_PATH)) {
    throw new Error(`onboarding DB not found at ${ONBOARDING_DB_PATH}`);
  }
  // readonly so we can't accidentally write into onboarding's table from here
  return new Database(ONBOARDING_DB_PATH, { readonly: true });
}

function loadAgents(db) {
  return db.prepare(`
    SELECT agent_matrix_id, owner_windy_id, agent_name, access_token
      FROM agent_credentials
     WHERE access_token IS NOT NULL
       AND access_token != ''
  `).all();
}

function reconcile() {
  let db;
  try {
    db = openDb();
  } catch (err) {
    console.warn(`[roster] cannot open onboarding DB: ${err.message}`);
    return;
  }
  let agents;
  try {
    agents = loadAgents(db);
  } finally {
    db.close();
  }
  let added = 0;
  for (const a of agents) {
    if (roster.has(a.agent_matrix_id)) continue;
    const runner = new AgentRunner({
      matrixUserId: a.agent_matrix_id,
      accessToken: a.access_token,
      agentName: a.agent_name,
      ownerWindyId: a.owner_windy_id,
      homeserver: HOMESERVER,
    });
    runner.start();
    roster.set(a.agent_matrix_id, runner);
    added += 1;
    console.log(`[roster] started runner for ${a.agent_matrix_id} (${a.agent_name})`);
  }
  if (added > 0) {
    console.log(`[roster] reconcile: +${added}, total=${roster.size}`);
  }
}

// ── HTTP surface (health + status only) ──

const app = express();
app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({
    service: 'windy-chat-agent-roster',
    status: 'ok',
    started_at: STARTED_AT,
    roster_size: roster.size,
    homeserver: HOMESERVER,
  });
});

app.get('/version', (_req, res) => {
  res.json({
    service: 'windy-chat-agent-roster',
    version: '0.1.0',
    commit_sha: process.env.COMMIT_SHA || null,
    commit_sha_short: process.env.COMMIT_SHA ? process.env.COMMIT_SHA.slice(0, 7) : null,
    build_timestamp: process.env.BUILD_TIMESTAMP || null,
    started_at: STARTED_AT,
    environment: process.env.NODE_ENV || 'unknown',
  });
});

app.get('/status', (_req, res) => {
  const runners = [...roster.values()].map(r => r.status());
  res.json({
    started_at: STARTED_AT,
    roster_size: roster.size,
    homeserver: HOMESERVER,
    runners,
  });
});

app.listen(PORT, () => {
  console.log(`[roster] listening on :${PORT}`);
  console.log(`[roster] onboarding DB: ${ONBOARDING_DB_PATH}`);
  console.log(`[roster] homeserver: ${HOMESERVER}`);
  reconcile();
  setInterval(reconcile, RECONCILE_INTERVAL_MS);
});

// Graceful shutdown so docker stop doesn't kill mid-reply
const shutdown = (sig) => {
  console.log(`[roster] ${sig} received, stopping ${roster.size} runners…`);
  for (const r of roster.values()) r.stop();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
