/**
 * Hatch-time passport verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /api/v1/onboarding/agent` accepted `passport_number` as an
 * arbitrary string and never asked Eternitas whether it was real. It
 * sanitized the string into a Matrix localpart and built a fully working
 * agent around it: Matrix account, access token, DM room, and a live
 * agent-roster listener with LLM replies. Anything holding
 * CHAT_SERVICE_TOKEN could conjure an agent out of a passport number that
 * had never been issued.
 *
 * That is not hypothetical. Measured on Kit 0 (2026-07-26):
 *
 *   2026-07-14  17 agents created in Windy Chat
 *   2026-07-14   0 bots registered in Eternitas that day
 *
 * All 17 carry passport numbers Eternitas has never heard of, and every
 * one still 404s. They were QA/load-test artifacts, but the door they came
 * through is the same door a real caller uses. The canonical hatch
 * (account-server `POST /api/v1/agent/hatch`) is correctly fail-closed on
 * Eternitas — this endpoint was the way around it.
 *
 * THE RULE
 *   Eternitas answers "no such passport"   → REFUSE. Definitive.
 *   Eternitas answers "revoked"            → REFUSE. Definitive.
 *   Eternitas does not answer at all       → ALLOW, loudly.
 *
 * The last line is deliberate and is the opposite of the peer gate in
 * agent-roster, so it's worth saying why they differ.
 *
 * The peer gate decides whether a stranger may speak to your agent. Being
 * unsure there costs a delayed conversation. Here, the caller has already
 * cleared the canonical hatch — account-server refuses to reach this
 * endpoint at all unless Eternitas just issued the passport seconds ago.
 * So an unreachable Eternitas at THIS point means a blip between two
 * services mid-ceremony, and refusing would strand a real person watching
 * a progress bar with an agent that half-exists. Being unsure here costs a
 * grandma her agent, on stage.
 *
 * It also gives an attacker nothing: whoever holds CHAT_SERVICE_TOKEN
 * cannot make Eternitas unreachable from inside the cluster. The soft path
 * is not a bypass, it's a tolerance for our own flakiness — and every use
 * of it is logged and emitted as telemetry so it can never be silent.
 *
 * `suspended` is allowed through. Suspension is a temporary standing
 * problem, not a statement that the identity is fake, and the trust gates
 * downstream already refuse to let a suspended agent DO anything. Blocking
 * provisioning would leave the owner with no chat handle to recover into.
 */
'use strict';

const { getTrustProfile } = require('../../shared/trust-client');

/** Operators can force strict mode (refuse on unreachable) per deployment. */
function strictMode() {
  return String(process.env.HATCH_PASSPORT_STRICT || '').toLowerCase() === 'true';
}

function enabled() {
  // Default ON. Set explicitly to 'false' only for an offline dev stack
  // with no Eternitas at all — never in prod.
  return String(process.env.HATCH_REQUIRE_PASSPORT || 'true').toLowerCase() !== 'false';
}

/**
 * @returns {Promise<{ok: boolean, reason: string, verified: boolean,
 *                     status?: number, profile?: object}>}
 *   ok       — may this hatch proceed?
 *   verified — did Eternitas positively confirm the passport? (false on
 *              the soft path, so callers can record provenance)
 */
async function verifyPassportIssued(passportNumber) {
  if (!enabled()) {
    return { ok: true, verified: false, reason: 'check_disabled' };
  }

  const profile = await getTrustProfile(passportNumber);

  // No answer — network, timeout, 5xx, 429, or a malformed prefix that
  // Eternitas 400s on. See the module header for why this is soft.
  if (!profile) {
    if (strictMode()) {
      return { ok: false, status: 503, verified: false, reason: 'eternitas_unreachable' };
    }
    return { ok: true, verified: false, reason: 'eternitas_unreachable' };
  }

  if (profile.status === 'not_found') {
    return { ok: false, status: 403, verified: false, reason: 'passport_not_issued' };
  }

  if (profile.status === 'revoked') {
    return { ok: false, status: 403, verified: true, reason: 'passport_revoked' };
  }

  return { ok: true, verified: true, reason: 'ok', profile };
}

module.exports = { verifyPassportIssued, enabled, strictMode };
