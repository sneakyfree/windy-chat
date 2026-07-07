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
const { snapshot: quotaSnapshot } = require('./lib/quota');

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

/**
 * Resolve the owner's full context for an agent: Matrix ID + display
 * name + mail address (if provisioned).
 *
 * Matrix ID + display name come from chat-onboarding's user_profiles
 * (this DB). Mail address comes from Pro account-server's
 * /api/v1/identity/ecosystem-status — we cache it in-memory per
 * windy_identity_id to avoid hammering Pro on every reconcile.
 */
function resolveOwnerMatrixId(db, ownerWindyId) {
  const row = db.prepare(
    'SELECT chat_user_id FROM user_profiles WHERE windy_identity_id = ?',
  ).get(ownerWindyId);
  if (!row || !row.chat_user_id) return null;
  const homeServer = (process.env.SYNAPSE_SERVER_NAME || 'chat.windychat.ai').trim();
  return `@${row.chat_user_id}:${homeServer}`;
}

function resolveOwnerDisplay(db, ownerWindyId) {
  const row = db.prepare(
    'SELECT display_name FROM user_profiles WHERE windy_identity_id = ?',
  ).get(ownerWindyId);
  return row?.display_name || null;
}

// Per-windy_identity_id cache for mail address.
//
// Resolution chain:
//   1. In-memory cache (5-min TTL) — hot path
//   2. Pro account-server POST /api/v1/identity/mail/address-by-windy-id
//      with X-Service-Token (CHAT_SERVICE_TOKEN) — authoritative
//   3. MAIL_ADDRESS_SEED env static fallback — for dev / before Pro
//      ships the endpoint
//
// Cache miss → async refresh; first call to resolveMailAddress for an
// unseen owner returns null but kicks off the lookup; next reconcile
// (30s later) sees the cached value and exposes the tool. This avoids
// blocking the reconcile loop on Pro round-trips.
const mailAddressCache = new Map(); // windyId → { addr, ts }
const MAIL_CACHE_MS = 5 * 60 * 1000;
const PRO_ACCOUNT_URL = (process.env.WINDY_ACCOUNT_SERVER_URL || 'https://account.windyword.ai').replace(/\/$/, '');
const CHAT_SERVICE_TOKEN = process.env.CHAT_SERVICE_TOKEN || '';

(function seedMailAddresses() {
  const raw = process.env.MAIL_ADDRESS_SEED || '';
  for (const pair of raw.split(',')) {
    const [windyId, addr] = pair.split('=').map(s => (s || '').trim());
    if (windyId && addr) mailAddressCache.set(windyId, { addr, ts: Date.now() });
  }
  if (mailAddressCache.size) {
    console.log(`[roster] seeded ${mailAddressCache.size} mail addresses from env`);
  }
})();

async function refreshMailAddressFromPro(ownerWindyId) {
  if (!CHAT_SERVICE_TOKEN || !ownerWindyId) return null;
  try {
    const res = await fetch(`${PRO_ACCOUNT_URL}/api/v1/identity/mail/address-by-windy-id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': CHAT_SERVICE_TOKEN,
      },
      body: JSON.stringify({ windy_identity_id: ownerWindyId }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) {
      // Cache the negative result briefly so we don't hammer Pro for
      // unprovisioned users every reconcile.
      mailAddressCache.set(ownerWindyId, { addr: null, ts: Date.now() });
      return null;
    }
    if (!res.ok) {
      console.warn(`[roster] Pro mail-lookup ${res.status} for ${ownerWindyId}`);
      return null;
    }
    const data = await res.json();
    if (data?.mail_address) {
      mailAddressCache.set(ownerWindyId, { addr: data.mail_address, ts: Date.now() });
      return data.mail_address;
    }
    return null;
  } catch (err) {
    console.warn(`[roster] Pro mail-lookup failed for ${ownerWindyId}: ${err.message}`);
    return null;
  }
}

function resolveMailAddress(ownerWindyId) {
  if (!ownerWindyId) return null;
  const cached = mailAddressCache.get(ownerWindyId);
  if (cached && Date.now() - cached.ts < MAIL_CACHE_MS) return cached.addr;
  // Stale or absent — kick off a background refresh, return whatever
  // we last knew (or null). The next reconcile will see the updated
  // value once the Pro call returns.
  refreshMailAddressFromPro(ownerWindyId).catch(() => {});
  return cached ? cached.addr : null;
}

// The agent's OWN mailbox, minted at hatch. Derived from the agent name with
// the SAME rule the hatch used (account-server routes/agent.ts step 5:
// `${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}@windymail.ai`), so it
// matches the real Stalwart mailbox. Used as the agent's send-from address
// when the operator has no windymail address of their own.
function deriveAgentMailAddress(agentName) {
  if (!agentName) return null;
  const localpart = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!localpart) return null;
  return `${localpart}@windymail.ai`;
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
  const ownerCtxByWindyId = new Map();
  try {
    agents = loadAgents(db);
    for (const a of agents) {
      if (ownerCtxByWindyId.has(a.owner_windy_id)) continue;
      ownerCtxByWindyId.set(a.owner_windy_id, {
        matrixId: resolveOwnerMatrixId(db, a.owner_windy_id),
        displayName: resolveOwnerDisplay(db, a.owner_windy_id),
        mailAddress: resolveMailAddress(a.owner_windy_id),
      });
    }
  } finally {
    db.close();
  }

  let added = 0;
  if (!agents) return;

  // Prune runners whose credentials row vanished (revocation cleanup
  // deletes it). Without this a revoked agent's runner 401-loops against
  // its deactivated Matrix account until the next service restart —
  // seen live twice on 2026-07-06/07.
  const liveIds = new Set(agents.map((a) => a.agent_matrix_id));
  for (const [matrixId, runner] of roster) {
    if (liveIds.has(matrixId)) continue;
    try { runner.stop(); } catch (_e) { /* best-effort */ }
    roster.delete(matrixId);
    console.log(`[roster] pruned runner for ${matrixId} (credentials gone), total=${roster.size}`);
  }

  for (const a of agents) {
    const ctx = ownerCtxByWindyId.get(a.owner_windy_id) || {};
    if (roster.has(a.agent_matrix_id)) {
      // Reconcile: refresh owner context (mail may have just been
      // seeded) and re-attempt back-invite.
      const existing = roster.get(a.agent_matrix_id);
      existing.updateOwnerContext({
        displayName: ctx.displayName,
        mailAddress: ctx.mailAddress,
      });
      if (ctx.matrixId) existing._backInviteOwner(ctx.matrixId).catch(() => {});
      continue;
    }
    const agentMailAddress = deriveAgentMailAddress(a.agent_name);
    const runner = new AgentRunner({
      matrixUserId: a.agent_matrix_id,
      accessToken: a.access_token,
      agentName: a.agent_name,
      ownerWindyId: a.owner_windy_id,
      homeserver: HOMESERVER,
      ownerContext: {
        displayName: ctx.displayName,
        mailAddress: ctx.mailAddress,
      },
      agentMailAddress,
    });
    runner.start();
    roster.set(a.agent_matrix_id, runner);
    added += 1;
    // Mail is [on] whenever the agent can send from SOME windymail address —
    // the operator's own, or (fallback) the agent's own mailbox.
    const mailOn = ctx.mailAddress || agentMailAddress;
    console.log(`[roster] started runner for ${a.agent_matrix_id} (${a.agent_name})${mailOn ? ' [mail:on]' : ''}`);
    if (ctx.matrixId) {
      runner._backInviteOwner(ctx.matrixId).catch(() => {});
    }
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
    quotas: quotaSnapshot(),
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
