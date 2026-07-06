/**
 * Windy Chat — Windy Admin telemetry emitter (ADR-WA-001)
 *
 * Fire-and-forget event envelopes to the ecosystem's central
 * observability ingest (admin.windyword.ai). Distinct from
 * analytics.js (local SQLite engagement metrics): this is the
 * cross-platform ledger the super-admin dashboard reads.
 *
 * Hard rules:
 *  - NEVER affects product traffic: 2s timeout, every error swallowed,
 *    inert unless WINDY_ADMIN_INGEST_URL + WINDY_ADMIN_INGEST_TOKEN are
 *    set in the service's env.
 *  - Privacy line (ADR-WA-001 §4): counts, costs, durations, models
 *    only — never message content. The ingest 422s content-like
 *    metadata keys; fix the caller, never the guard.
 *
 * Usage:
 *   const adminTelemetry = require('../shared/admin-telemetry');
 *   adminTelemetry.emit({
 *     service: 'agent-roster',
 *     event_type: 'llm.call',
 *     actor_type: 'agent',
 *     actor_id: 'ET26-XXXX-YYYY',
 *     model, provider, duration_ms,
 *     metadata: { tool_calls: 1 },
 *   });
 */
'use strict';

function isConfigured() {
  return !!(process.env.WINDY_ADMIN_INGEST_URL && process.env.WINDY_ADMIN_INGEST_TOKEN);
}

/**
 * Queue one envelope for delivery. Returns the in-flight promise for
 * tests; production callers ignore it (fire-and-forget).
 */
function emit(event) {
  if (!isConfigured()) return Promise.resolve(null);
  const envelope = {
    ts: new Date().toISOString(),
    platform: 'windy-chat',
    ...event,
  };
  const url = `${process.env.WINDY_ADMIN_INGEST_URL.replace(/\/$/, '')}/v1/events`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.WINDY_ADMIN_INGEST_TOKEN}`,
    },
    body: JSON.stringify({ events: [envelope] }),
    signal: AbortSignal.timeout(2000),
  }).then((res) => {
    if (res.status !== 202) {
      console.warn(`[admin-telemetry] ingest returned ${res.status}`);
    }
    return res.status;
  }).catch((err) => {
    console.warn(`[admin-telemetry] post failed: ${err.message}`);
    return null;
  });
}

module.exports = { emit, isConfigured };
