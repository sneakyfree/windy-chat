# Coverage Gaps

Run during wave-7 audit.

## Headline finding

**Every jest test suite in the repo imports `services/shared/jwt-verify.js`,
which transitively requires `jwks-rsa` → `jose`. `jose` ships ESM-only and
jest's default CJS transformer chokes on the `export` keyword.**

Concrete impact (`npm test` per service):

| Service | jest collected | Passing | Notes |
|---|---|---|---|
| onboarding | 0 via api.test.js | 0 jest | node:test path (`npm test`) runs integration-pro.test.js → 18/22 pass, 4 stale-regex failures |
| directory | 0 | 0 | jest fails to import server — 100% of jest coverage is zero |
| push-gateway | 0 | 0 | same |
| backup | 0 | 0 | same |
| social | — | — | not exercised (no jest in package.json?) |
| media | — | — | same |
| call-history | — | — | same |
| translation | — | — | same |

**This means CI's green checkmark on `test-unit` is lying.** Most of the
service code has literally zero automated coverage landing in CI today.

The only tests that DO run (and pass):

- `services/onboarding/tests/webhooks.test.js` (node:test) — 20/20 pass
- `services/onboarding/tests/integration-pro.test.js` (node:test) — 18/22 pass (4 pre-existing stale `chat.windypro.com` regex failures)
- `services/directory/tests/trust-gates.test.js` (node:test) — 17/17 pass
- `services/push-gateway/tests/notify.test.js` (node:test) — 6/6 pass
- `tests/integration/test_trust_live.js` — 8/8 pass
- `tests/integration/test_trust_live_bands.js` — 16/16 pass (against live Eternitas seeds)

These five files are the ENTIRE effective test suite.

## Untested surface by coverage criticality

Criticality: anything touching auth, crypto, money, or identity.

### No coverage — P0

- `services/shared/jwt-verify.js` — RS256/HS256 fallback, alg=none handling,
  JWKS caching. Zero unit tests. Live-probe confirms alg=none is rejected,
  but the fallback path from RS256→HS256 when JWKS fetch fails is untested.
- `services/shared/cors.js` — origin allowlist + localhost bypass in
  non-production. Zero tests.
- `services/shared/trust-client.js` — 404/400/429 handling, redis
  fallback, cache TTL honoring, mock toggle. Only exercised indirectly via
  trust-gates tests.
- `services/onboarding/routes/agent-provision.js` — bot account
  provisioning with fake Matrix tokens (the DEV-STUB branch), passport
  verification, EPT minting. Zero unit tests.
- `services/onboarding/routes/verify.js` — Twilio/SendGrid OTP flow. Any
  logic bug here leaks OTPs or fails silently. Zero unit tests.
- `services/onboarding/routes/pair.js` — QR-code pairing key exchange
  (Ed25519 signatures, linked-device handshake). Untested.
- `services/media/routes/link-preview.js` — SSRF defense. Completely
  untested, and the feature is also SHADOWED (see GAP_ANALYSIS P0).
- `services/backup/server.js` — encrypted backup creation/restore, R2
  uploads. Zero tests.
- `services/social/routes/eternitas-webhook.js` — passport revoke
  handler, trust-cache invalidation. Zero tests.
- `deploy/synapse/windy_push_bus.py` — on_new_event subscriber, publishes
  to push bus. Zero tests (Python side).
- `deploy/synapse/windy_registration.py` — password-auth against
  account-server. Zero tests.

### Error paths — P1

- Oversized request body: hits Express json-parser unhandled error path,
  returns 500 instead of 413.
- Malformed JSON body: returns 500 instead of 400.
- Synapse admin API unreachable (every `/rooms/create-group`,
  `/agent-provision`, `/unified-login` that falls back to dev-stub): no
  test covers "Synapse admin returns 500" or "Synapse times out."
- Eternitas unreachable while trust-cache is empty: gate denies with
  `trust_api_unreachable`. Only asserted in stand-in test, not against
  real timeout behavior.
- Redis unreachable on boot: onboarding `otp` / `verified` sessions fall
  back to in-memory Map. Behavior under Redis outage is documented but
  not tested.

### Mock-heavy tests (integration-test candidates) — P2

- `services/onboarding/tests/webhooks.test.js` uses the dev-stub Synapse
  path (SYNAPSE_REGISTRATION_SECRET = ''). Real Synapse registration MAC
  generation is not exercised.
- `tests/integration/test_trust_live.js` uses a stand-in HTTP server
  emitting canned contract responses. Only the live-bands file talks to
  real Eternitas.
- All gate tests seed the trust-client cache via `_setCacheForTest` —
  the real live path from cache miss → Eternitas GET → profile cache
  isn't exercised except in the stand-in + live-bands suites.

## Coverage tooling status

No `jest --coverage` or `nyc` configured. `coverage/` directories don't
exist. There is no coverage metric reported by CI.

## Recommendation

1. **P0**: fix the jest/jose ESM issue (add `transformIgnorePatterns` to
   each service's jest config, or move jwt-verify to CJS-compatible
   imports). Without this, CI tells you nothing.
2. **P0**: add coverage tooling (`jest --coverage`) and fail CI at a
   realistic baseline (e.g. 60%) for auth + crypto + identity modules.
3. **P1**: add error-path tests for malformed body, oversized body,
   external-dep timeouts.
