# Bucket C — Review Requests

**14 PRs. Do NOT self-merge.** Each touches auth / webhooks / rate limits /
identity / trust cache / Matrix account provisioning. Every entry below
names the specific thing a reviewer needs to look at and the smoke test
to run post-merge.

All PRs were branched from `wave-7-gap-analysis` (now squashed into
main at `d08b6d3`). Each will need a rebase (`git merge origin/main -X
ours` works; see the Wave-7 batch runbook comments in
`docs/MERGE_TRIAGE.md`). After rebase, verify `services/shared/trust-client.js`
still exports `getTrustClientMetrics` (P3-1's content), the `{ app }`
destructure in `services/onboarding/tests/api.test.js` is intact, and
there are no duplicate `callerPassport`/`isHumanCaller` decls in
`services/directory/routes/agents.js` — those three were casualties of
Bucket B's rebase and had to be restored manually on main. If the
rebase re-clobbers them, restore before merging.

Smoke for every Bucket C merge: `/tmp/full-integration.sh`
(smoke + jest per service + trust_live_bands). Current baseline on
main: **117/117 tests passing**.

---

## #2 — `fix(media): unshadow /api/v1/media/link-preview (P0-1)`

**Risk**: unlocking a route that has been 404-ing. SSRF defenses inside
the unlocked router have documented bypass vectors (DNS rebinding,
IPv6-mapped IPv4, integer-encoded IPs, cloud metadata hostnames).

**What needs eyes**: **MUST MERGE TOGETHER WITH #15.** Landing #2 alone
turns on SSRF in prod. Reviewer should squash or co-merge the two.

**Smoke post-merge**: `curl .../api/v1/media/link-preview?url=http://127.0.0.1/`
must return 400. Same for `http://169.254.169.254/` (AWS metadata).
`#15`'s unit tests (`services/media/tests/ssrf.test.js`) cover the
IPv6-mapped and integer-encoded cases.

---

## #3 — `fix(webhooks): accept sha256= prefix in social + provision HMAC verifiers (P0-4)`

**Risk**: changes HMAC verification. A subtle off-by-one in the
prefix-strip regex could break real Eternitas webhook delivery.

**What needs eyes**: review the regex `/^sha256=(.+)$/i` and the
normalization path in `services/social/routes/eternitas-webhook.js`.
Confirm both the bare-hex and prefixed forms still timing-safe-compare
correctly.

**Smoke post-merge**: fire an Eternitas webhook with both formats and
confirm 200. `services/onboarding/tests/webhooks.test.js` has the 5
assertions (bare / sha256= / SHA256= / md5= / bad hex).

---

## #4 — `fix(webhooks): flush trust cache on passport revoke (P0-3)`

**Risk**: adds `invalidateTrustCache()` to social's passport.revoked
handler. If the import path changes or the cache-flush function
throws, revoked bots stay authorized in the directory gates for up to
5 min.

**What needs eyes**: confirm `services/social/routes/eternitas-webhook.js`
imports `invalidateTrustCache` from `../../shared/trust-client`.
Confirm both `handleRevocationOrSuspension` AND `handleReinstatement`
call it.

**Smoke post-merge**: provision a bot, seed its trust profile in the
cache, fire `passport.revoked` webhook, verify the directory
`/gate/broadcast` call now denies with `passport_not_active`.

---

## #5 — `fix(directory): gate /agents/register + re-verify against Trust API (P0-2)` — **TOP-3 MUST-MERGE**

**Risk**: changes the auth surface of a service-to-service endpoint.
Breaking this breaks agent registration for every service that calls
it (onboarding's agent-provision, windy-pro's account-server).

**What needs eyes**: verify every caller of `/agents/register` sends
`Authorization: Bearer <CHAT_SERVICE_TOKEN>` — specifically
`services/onboarding/routes/agent-provision.js` around the
cross-service publishing path. If any caller was sending a user JWT,
it will start getting 403.

**Smoke post-merge**: register an agent with the service token
(should 201), register with a random user JWT (should 403), register
an unknown passport (should 404 from the Trust API re-verify),
register a revoked passport (should 403).

---

## #7 — `fix(directory): strip Eternitas profile from gate denial responses (P1-5)`

**Risk**: changes response shape on 403. Any caller that inspected the
`profile` field in denial responses will see it missing.

**What needs eyes**: grep downstream consumers (Mail, Fly, Clone,
Code) for `body.profile` or `body.integrity_score` on gate responses.
If any read those, they must fall back to fetching the profile
directly from Eternitas.

**Smoke post-merge**: trust-gates test suite (17/17) already asserts
only on named fields; confirm it still passes. No live consumer
check required in this repo.

---

## #9 — `fix(webhooks): fail-closed when HMAC secret is unset (P1-8)`

**Risk**: any deployment currently running without
`ETERNITAS_WEBHOOK_SECRET` or `WINDY_IDENTITY_WEBHOOK_SECRET` set in
env will start returning 503 on every webhook call. Previously it
fail-opened in dev and fail-closed only in production.

**What needs eyes**: confirm the dev `.env` and CI env both set these
secrets explicitly. Check `.env.example` (already covered by PR #10)
and `.github/workflows/ci.yml` env block.

**Smoke post-merge**: fire a webhook without any signature header
against all three handlers (social, onboarding/webhooks, provision).
All three should 401 — not 200, not 503 (503 means secret isn't set).

---

## #11 — `fix(social): flush eternitas-verify cache on passport revoke/reinstate (P1-3)`

**Risk**: adds a new export path across `services/social/lib/store.js`
and `services/social/routes/eternitas-webhook.js`. Moves
`eternitasVerifyCache` from a local Map to a shared module export.

**What needs eyes**: confirm no other file in `services/social/` was
still accessing the old local `eternitasCache` identifier. Grep:
`grep -rn "eternitasCache" services/social/`.

**Smoke post-merge**: hit `/api/v1/social/presence/bot_ET26-TEST-EXCP`
(auth'd per P2-5), revoke that bot via webhook, call presence again,
confirm the `verified` flag flipped.

---

## #12 — `fix(directory): per-passport rate limit on trust gates (P1-6)`

**Risk**: a new rate limiter in the gate authorization path. A bug in
the key-generator or the `skip` predicate could either (a) deny
legitimate human callers (wrong skip logic) or (b) let bots
exfiltrate the Eternitas budget (wrong key grouping).

**What needs eyes**: review the `keyGenerator` and `skip` functions.
Confirm `skip: (req) => !(req.user?.passport_id || req.user?.eternitas_passport)`
correctly identifies humans (no passport claim) AND confirm
`keyGenerator` produces distinct buckets per passport.

**Smoke post-merge**: burst 35 gate calls from one passport, confirm
30×200 + 5×429. Switch to a different passport, confirm fresh bucket
(30 more passes).

---

## #13 — `fix(onboarding): unify Matrix localpart generation across entry paths (P1-2)`

**Risk**: changes the Matrix handle for brand-new users from
`@windy_grant` to `@grant.whitmer`. Existing users are unaffected
(lookup-by-windy-identity-id runs first). But any downstream system
that depends on the `windy_` prefix will break for new users only.

**What needs eyes**: grep the Windy ecosystem repos (`windy-mail`,
`windy-clone`, `windy-agent`) for `windy_` prefix assumptions in chat
handle parsing. Also check `windy-pro`'s account-server which is the
caller of `/unified-login`.

**Smoke post-merge**: provision a new user with display_name "Alice
Anderson" via `/unified-login`, confirm `matrix_user_id` is
`@alice.anderson:chat.windychat.ai` (not `@windy_alice_anderson`).
Then fire `identity/created` for a different new user, confirm same
pattern.

---

## #14 — `fix(onboarding): serialize concurrent /unified-login per identity (P1-1)` — **TOP-3 MUST-MERGE**

**Risk**: introduces in-process locking on a hot path. A deadlock or
stuck lock holds up all logins for that identity. Single-process only
— multi-task deployments need Redis-backed locking.

**What needs eyes**: review `services/shared/keyed-lock.js`. Confirm
the tail-Promise chain releases correctly on both success and error
paths. Confirm the lock key is `unified-login:${windyIdentityId}` so
identities don't cross-lock.

**Smoke post-merge**: 20-parallel curl burst to `/unified-login` for
the same new identity, count unique `access_token` values in
responses. Expect 1, not 20.

---

## #15 — `fix(media): SSRF-harden link-preview resolver (P1-7)`

**Risk**: security-critical SSRF defense. Must land WITH #2 (they
gate each other). `dns.lookup` behavior, IPv4/IPv6 address
normalization, and the custom `http.Agent.lookup` are all tricky.

**What needs eyes**: review `isPrivateIP` against the
`services/media/tests/ssrf.test.js` fixture set (41/41 passing).
Confirm `pinnedAgent` passes the pre-validated IP to the HTTP client,
not the hostname (otherwise DNS rebinding re-enters).

**Smoke post-merge**: attempt fetches of `http://localhost/`,
`http://169.254.169.254/`, `http://metadata.google.internal/`,
`http://[::ffff:127.0.0.1]/`, `http://2130706433/`, `http://0x7f000001/`,
and `http://<attacker-dns-rebind>.ngrok.io/`. All should return 400
`SSRF_DENIED`.

---

## #20 — `fix(social): require auth on /social/presence (P2-5)`

**Risk**: breaks any unauthenticated caller. If the web frontend has
an anonymous presence-probe widget, it will stop rendering.

**What needs eyes**: grep `web/` for `/api/v1/social/presence` calls.
Confirm every caller passes an Authorization header.

**Smoke post-merge**: curl `/presence/bot_anything` with no auth —
expect 401. With a valid user JWT — expect 200 with the presence
object.

---

## #21 — `fix(onboarding): retire legacy /eternitas/webhook (P2-1)`

**Risk**: returns 410 on the legacy path. If Eternitas is still
configured against this URL (rather than the canonical
`/api/v1/webhooks/eternitas` per `.env.example`), revocations will
silently stop working — but observed via Eternitas's
webhook_deliveries ledger as 410 failures, so not truly silent.

**What needs eyes**: confirm Eternitas's platform registration points
at `https://chat.windychat.ai/api/v1/webhooks/eternitas` (social's
handler), NOT the legacy onboarding path. This is a production-
config check, not a code review.

**Smoke post-merge**: curl the retired path with a dummy webhook body
— expect 410 with `code: ENDPOINT_RETIRED`. Curl the canonical path
with a valid signed payload — expect 200.

---

## #23 — `feat(directory): scale gate rate limit by tier_multiplier (P3-2)`

**Risk**: depends on #12 (per-passport gate rate limit) landing
first. Extends the limiter to scale by `tier_multiplier`. Bug in the
scaling math = wrong rate budget for some bands.

**What needs eyes**: review `resolveGateLimit` in
`services/directory/routes/agents.js`. Confirm the floor/ceiling
(5/150) are intentional and matches `trust-api.md`. Note the
`attachTrustProfile` middleware pre-fetches the profile before the
limiter can read it.

**Smoke post-merge**: burst 160 calls from an EXCEPTIONAL passport,
confirm ~150 × 200 + ~10 × 429 (subject to directory's global 60/min
per-IP limiter also cutting in). Burst 25 from a POOR passport,
confirm exactly 15 × 200 + 10 × 429.

---

## Recommended merge order inside Bucket C

1. **#3** (P0-4 sha256 prefix) — enables Eternitas's real webhooks to land
2. **#4** + **#11** (trust cache flushes on revoke) — both enable "revocation actually propagates"
3. **#5** (P0-2 agent injection) — closes the directory-forgery hole
4. **#9** (P1-8 fail-closed HMAC) — hardens all three webhook paths
5. **#14** (P1-1 unified-login concurrency) — critical for launch-day burst traffic
6. **#13** (P1-2 unified localpart) — breaking change for new-user handles, schedule deliberately
7. **#12** (P1-6 gate rate limit) → then **#23** (P3-2 tier scaling, depends on #12)
8. **#7** (P1-5 info leak strip) — response shape change
9. **#20** (P2-5 presence auth) — breaks anonymous presence probes
10. **#2** + **#15 PAIRED** (SSRF unshadow + harden) — never one without the other
11. **#21** (P2-1 retire legacy webhook) — last, after confirming Eternitas config

Target state after all 14 merge: **131 tests passing** (117 baseline + 14 new from P1-5/P1-6/P1-7/P3-2 regression suites).
