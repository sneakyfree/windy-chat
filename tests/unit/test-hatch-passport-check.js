/**
 * Hatch-time passport verification (2026-07-26).
 *
 * `POST /api/v1/onboarding/agent` used to accept any string as
 * `passport_number` and build a complete working agent around it. On
 * 2026-07-14 that produced 17 Windy Chat agents on Kit 0 on a day
 * Eternitas registered zero bots; all 17 still 404 against the trust API.
 *
 * These tests pin the rule and — just as importantly — the deliberate
 * asymmetry in it:
 *
 *   "no such passport"        → REFUSE (definitive)
 *   "revoked"                 → REFUSE (definitive)
 *   Eternitas didn't answer   → ALLOW, loudly (a blip mid-ceremony must
 *                               not strand a real person's hatch)
 *
 * Run: node --test tests/unit/test-hatch-passport-check.js
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const trustClient = require('../../services/shared/trust-client');

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const k of ['HATCH_REQUIRE_PASSPORT', 'HATCH_PASSPORT_STRICT', 'ETERNITAS_USE_MOCK', 'ETERNITAS_URL']) {
    delete process.env[k];
  }
  Object.assign(process.env, {
    HATCH_REQUIRE_PASSPORT: ORIGINAL_ENV.HATCH_REQUIRE_PASSPORT,
    HATCH_PASSPORT_STRICT: ORIGINAL_ENV.HATCH_PASSPORT_STRICT,
  });
  for (const k of ['HATCH_REQUIRE_PASSPORT', 'HATCH_PASSPORT_STRICT']) {
    if (process.env[k] === undefined || process.env[k] === 'undefined') delete process.env[k];
  }
}

// The module reads env at call time, so a plain require here is fine.
const { verifyPassportIssued, enabled, strictMode } = require('../../services/onboarding/lib/passport-check');

describe('hatch passport verification', () => {
  beforeEach(() => {
    resetEnv();
    trustClient._clearCacheForTest();
  });
  afterEach(() => {
    resetEnv();
    trustClient._clearCacheForTest();
  });

  // ── The hole that was open ───────────────────────────────────────────

  it('REFUSES a passport Eternitas has never issued — the July 14th case', async () => {
    // Seed the exact negative profile the trust client builds from a real
    // Eternitas 404 (trust-client.js: `status: 'not_found'`). Seeding the
    // cache rather than standing up a fake server keeps the assertion on
    // OUR rule, not on HTTP plumbing that trust-client already tests.
    trustClient._setCacheForTest('ET26-FAKE-0001', {
      passport_number: 'ET26-FAKE-0001', status: 'not_found', allowed_actions: [], denied_actions: [],
    });

    const r = await verifyPassportIssued('ET26-FAKE-0001');
    assert.equal(r.ok, false, 'a passport Eternitas never issued must not provision an agent');
    assert.equal(r.status, 403);
    assert.equal(r.reason, 'passport_not_issued');
    assert.equal(r.verified, false);
  });

  it('REFUSES a revoked passport', async () => {
    trustClient._setCacheForTest('ET26-GONE-0001', {
      passport_number: 'ET26-GONE-0001', status: 'revoked', band: 'critical', allowed_actions: [],
    });
    const r = await verifyPassportIssued('ET26-GONE-0001');
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.reason, 'passport_revoked');
  });

  it('ALLOWS a real, active passport', async () => {
    process.env.ETERNITAS_USE_MOCK = 'true';
    const r = await verifyPassportIssued('ET26-REAL-0001');
    assert.equal(r.ok, true);
    assert.equal(r.verified, true, 'a positive answer must be recorded as verified');
  });

  // ── The deliberate asymmetry ─────────────────────────────────────────

  it('ALLOWS when Eternitas does not answer — a blip must not strand a live hatch', async () => {
    // Unroutable port: connection refused inside the fetch timeout.
    process.env.ETERNITAS_URL = 'http://127.0.0.1:1';
    const r = await verifyPassportIssued('ET26-BLIP-0001');
    assert.equal(r.ok, true, 'the caller already cleared the canonical hatch; do not strand them');
    assert.equal(r.reason, 'eternitas_unreachable');
    assert.equal(r.verified, false, 'but it must NOT be recorded as verified');
  });

  it('the soft path is distinguishable from a real pass — verified is the flag that matters', async () => {
    process.env.ETERNITAS_USE_MOCK = 'true';
    const good = await verifyPassportIssued('ET26-REAL-0002');
    process.env.ETERNITAS_USE_MOCK = 'false';
    process.env.ETERNITAS_URL = 'http://127.0.0.1:1';
    const soft = await verifyPassportIssued('ET26-BLIP-0002');
    assert.equal(good.ok, soft.ok, 'both proceed…');
    assert.notEqual(good.verified, soft.verified, '…but only one is verified');
  });

  it('HATCH_PASSPORT_STRICT=true turns the soft path off for operators who want that', async () => {
    process.env.ETERNITAS_URL = 'http://127.0.0.1:1';
    process.env.HATCH_PASSPORT_STRICT = 'true';
    assert.equal(strictMode(), true);
    const r = await verifyPassportIssued('ET26-BLIP-0003');
    assert.equal(r.ok, false);
    assert.equal(r.status, 503, 'unreachable is a 503, not a 403 — it is our fault, not the caller\'s');
  });

  it('a suspended passport still provisions — suspension is standing, not forgery', async () => {
    trustClient._setCacheForTest('ET26-SUSP-0001', {
      passport_number: 'ET26-SUSP-0001', status: 'suspended', band: 'fair', allowed_actions: [],
    });
    const r = await verifyPassportIssued('ET26-SUSP-0001');
    assert.equal(r.ok, true, 'the owner must keep a chat handle to recover into');
    assert.equal(r.verified, true);
  });

  // ── The kill switch ──────────────────────────────────────────────────

  it('defaults to ON — the check must not be opt-in', async () => {
    assert.equal(enabled(), true, 'a security check nobody enables is not a security check');
  });

  it('HATCH_REQUIRE_PASSPORT=false disables it for a fully offline dev stack', async () => {
    process.env.HATCH_REQUIRE_PASSPORT = 'false';
    assert.equal(enabled(), false);
    const r = await verifyPassportIssued('literally-anything');
    assert.equal(r.ok, true);
    assert.equal(r.verified, false, 'disabled must never masquerade as verified');
    assert.equal(r.reason, 'check_disabled');
  });
});
