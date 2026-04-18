# Bucket D — Grant Decisions

Zero open tickets at the Wave-7 batch-merge boundary. Every PR in the
queue either:

- has clear technical merit that doesn't require a product call
  (Bucket A, B, C — all 23 PRs), or
- needs a cross-repo migration rather than a decision about this repo
  (P3-3, which has no PR; see below)

---

## No decisions pending

Bucket D would hold entries like "should `tier_multiplier` apply to
rate limits or to storage quotas?" — a real fork where the code
could go two equally-reasonable ways. I answered the only two
latent ones myself during Wave 7:

- **P3-2** (`tier_multiplier` usage) — answered by framing it as an
  extension of P1-6's gate rate limit (the layer where the Trust API
  spec most directly maps it). Shipped as PR #23, already in Bucket C.
- **P3-3** (retire HS256 fallback in `jwt-verify.js`) — not answered.
  No PR shipped because the answer requires a coordinated migration,
  not a one-line change. See the "deferred" section below.

---

## Deferred (not blocking Wave 7)

### P3-3 — retire HS256 JWT fallback

**Not in Bucket D because there's no decision to make about whether.**
The question is *when* and *how*, and both answers depend on work
outside this repo.

**Why not a simple code change**: every test in the repo mints HS256
tokens via a `makeToken` helper keyed off `WINDY_JWT_SECRET`.
Removing the HS256 path breaks:

- `services/onboarding/tests/api.test.js`
- `services/directory/tests/api.test.js` + `trust-gates.test.js`
- `services/push-gateway/tests/api.test.js` + `notify.test.js`
- `services/backup/tests/api.test.js`
- `tests/integration/test_trust_live.js` + `test_trust_live_bands.js`
- `services/onboarding/tests/webhooks.test.js` +
  `integration-pro.test.js`

Only `test_jwks_contract.js` currently mints RS256 tokens via a local
mock JWKS server. Porting every service's test helper to do the same
is the bulk of the work — not the one-line deletion in `jwt-verify.js`.

**What Grant would need to say to unblock** (if you want to move it
forward): "spend a sprint migrating the test harnesses; we'll accept
CI red for the duration of the rollout." Without that, P3-3 stays
deferred and the operational mitigation is:

1. Treat `WINDY_JWT_SECRET` as if it were an RS256 private key — rotate
   on any suspected leak, scope to single-service envs if possible,
   never commit.
2. Prefer RS256 via JWKS wherever the account-server supports it; the
   HS256 path remains as a fallback for when JWKS is unreachable.
3. Add a deployment-time env flag
   `DISABLE_HS256_FALLBACK=true` once the test migration lands, so prod
   can harden ahead of the full retirement.

No PR opened for any of the above during Wave 7. Grant's call whether
to start the migration sprint now or after v1 ships.
