/**
 * windy.panel.v1 — read the owner's slider settings for an agent.
 *
 * The panel router in the onboarding service owns ALL writes; this module
 * is a pure consumer over the same read-only DB mount the roster already
 * uses for agent_credentials. One indexed SELECT per inbound message (the
 * runner already does a Matrix history fetch per message, so this is
 * nothing), which means a slider move applies to the very next reply — no
 * reconcile latency.
 *
 * Missing DB / missing table (deploy-order window) / missing row all
 * resolve to {} — i.e. every slider at its default and today's exact
 * midwife behavior. Settings can never take an agent down.
 */
'use strict';

const fs = require('fs');

const ONBOARDING_DB_PATH = process.env.ONBOARDING_DB_PATH
  || '/onboarding-data/onboarding.db';

let db = null;

function getSliders(agentMatrixId) {
  try {
    if (!db) {
      if (!fs.existsSync(ONBOARDING_DB_PATH)) return {};
      // Lazy require inside the fail-soft path: even a broken native
      // better-sqlite3 build degrades to default sliders, never a crash.
      const Database = require('better-sqlite3');
      db = new Database(ONBOARDING_DB_PATH, { readonly: true });
    }
    // Prepared per call: the agent_settings table may not exist until the
    // onboarding service creates it (first boot after this ships).
    const row = db
      .prepare('SELECT sliders_json FROM agent_settings WHERE agent_matrix_id = ?')
      .get(agentMatrixId);
    if (!row) return {};
    const parsed = JSON.parse(row.sliders_json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = { getSliders };
