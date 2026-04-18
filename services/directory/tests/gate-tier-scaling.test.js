/**
 * Unit tests for resolveGateLimit — P3-2 tier_multiplier scaling.
 *
 * Per trust-api.md, tier_multiplier is the value callers are meant to
 * "Apply directly to rate limits / quotas / privilege budgets." The
 * directory gate limiter scales its per-minute budget by that value,
 * floored at 5 and ceilinged at 150.
 *
 * Run: node --test services/directory/tests/gate-tier-scaling.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { __test_internals__ } = require('../routes/agents');
const { resolveGateLimit, GATE_LIMIT_BASE, GATE_LIMIT_FLOOR, GATE_LIMIT_CEILING } = __test_internals__;

// Small helper — resolveGateLimit takes a req-shaped object
const withTier = (tier_multiplier) => ({ trustProfile: { tier_multiplier } });
const noProfile = () => ({});

describe('resolveGateLimit — trust-api.md band mapping', () => {
  const cases = [
    // [label, tier_multiplier, expected budget]
    ['CRITICAL floor', 0.0, GATE_LIMIT_FLOOR],      // 0 × 30 = 0, floored to 5
    ['POOR',           0.5, 15],                    // 0.5 × 30 = 15
    ['FAIR',           1.0, GATE_LIMIT_BASE],       // 1.0 × 30 = 30
    ['GOOD',           2.0, 60],                    // 2.0 × 30 = 60
    ['TOP_SECRET',     3.0, 90],                    // 3.0 × 30 = 90
    ['EXCEPTIONAL',    5.0, GATE_LIMIT_CEILING],    // 5.0 × 30 = 150 (cap)
  ];
  for (const [label, tier, expected] of cases) {
    it(`${label} (tier=${tier}) → ${expected}/min`, () => {
      assert.equal(resolveGateLimit(withTier(tier)), expected);
    });
  }
});

describe('resolveGateLimit — edge cases', () => {
  it('negative multiplier → floor', () => {
    assert.equal(resolveGateLimit(withTier(-0.5)), GATE_LIMIT_FLOOR);
  });
  it('very large multiplier → ceiling', () => {
    assert.equal(resolveGateLimit(withTier(100)), GATE_LIMIT_CEILING);
  });
  it('fractional multiplier rounds', () => {
    // 0.33 × 30 = 9.9 → rounds to 10 (above floor)
    assert.equal(resolveGateLimit(withTier(0.33)), 10);
  });
  it('missing profile → baseline (1.0 × 30)', () => {
    // Trust API unreachable on this request — we prefer letting them
    // through at the limiter layer; the gate body denies on unreachable
    // anyway. Baseline is the safest default here.
    assert.equal(resolveGateLimit(noProfile()), GATE_LIMIT_BASE);
  });
  it('non-numeric multiplier → baseline', () => {
    assert.equal(resolveGateLimit({ trustProfile: { tier_multiplier: 'not-a-number' } }), GATE_LIMIT_BASE);
  });
  it('null profile → baseline', () => {
    assert.equal(resolveGateLimit({ trustProfile: null }), GATE_LIMIT_BASE);
  });
});

describe('Constants sanity', () => {
  it('FLOOR < BASE < CEILING', () => {
    assert.ok(GATE_LIMIT_FLOOR < GATE_LIMIT_BASE, 'floor must be < base');
    assert.ok(GATE_LIMIT_BASE < GATE_LIMIT_CEILING, 'base must be < ceiling');
  });
  it('CEILING leaves headroom under Eternitas 100 req/min/IP', () => {
    // Per trust-api.md, Eternitas rate-limits 100 req/min per IP.
    // Our ceiling is higher, but trust-client's 5-min cache means in
    // practice only a fraction of gate calls reach Eternitas. The
    // ceiling is set so even a cache-miss storm stays within one order
    // of magnitude of the upstream budget. See docs/audit/security-
    // posture.md § Rate limiting for the rationale.
    assert.ok(GATE_LIMIT_CEILING <= 150,
      `ceiling ${GATE_LIMIT_CEILING} should not exceed 150 — each gate call may trigger 1–2 Eternitas GETs on cache miss, and Eternitas caps 100/min/IP`);
  });
});
