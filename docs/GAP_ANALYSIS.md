# GAP ANALYSIS — what's actually broken before launch

Wave-7 adversarial audit. Not a feature checklist — a list of things that
will bite us in the first 72 hours of real traffic.

> The previous feature-inventory-style `GAP_ANALYSIS.md` was moved to
> `docs/FEATURE_INVENTORY.md`. This file replaces it with an attacker's
> punch list.

**Audit method**: live-probe every running service, grep the code for
known foot-gun patterns, re-verify every Wave 2-6 claim against current
behavior, be deliberately hostile.

**Supporting artifacts**:
- `docs/audit/endpoint-inventory.txt` — every route I could find
- `docs/audit/security-posture.md` — attack-surface walkthrough
- `docs/audit/coverage-gaps.md` — what has and doesn't have tests
- `docs/audit/concurrency-results.md` — 20-parallel-request races

## TL;DR

| Severity | Count |
|---|---|
| P0 | **5** |
| P1 | **10** |
| P2 | **6** |
| P3 | **3** |

**Launch verdict**: do not ship Chat on the current `main` + wave-2..6
branches until the five P0 items are fixed. Two are data-integrity
holes, two are control-plane misconfigurations that silently break the
Wave 4 trust story, and one is a directly-exploitable directory
poisoning vector.

---

## TOP 5 THINGS THAT WILL SURPRISE GRANT MOST

These aren't the highest-severity items (the P0 table below is). These
are the ones where the current state disagrees with what a sane reader
would assume from the docs and the prior-wave victory laps.

### 1. Every jest test suite in the repo collects zero tests

CI runs `npm test` per service. Every service's default `test` script is
`jest`. `jwt-verify.js` (required by every service's `server.js`)
transitively imports `jose`, which ships ESM-only. Jest's CJS transformer
chokes before it ever reaches a test file. Result: `Tests: 0 total` for
onboarding/directory/push-gateway/backup — and CI reports GREEN because
0 failures ≥ 0 failures threshold.

The only tests actually running are the node:test ones I wrote for
Waves 2-6 (webhooks, trust-gates, notify, trust_live, trust_live_bands).
Everything else — signup flow, pair flow, backup, social, media — has
zero automated coverage landing in CI today. The Wave 6 Security Review's
"VERIFIED" claims about those modules are backed by code-review-only, not
running tests.

### 2. Eternitas's webhooks don't reach my Wave 4 trust-cache flush code

`.env.example` line 45:
```
ETERNITAS_WEBHOOK_URL=https://chat.windychat.ai/api/v1/webhooks/eternitas
```

That URL points at `services/social/routes/eternitas-webhook.js`, which
was written BEFORE Wave 4. My `invalidateTrustCache(passport)` call lives
at `services/onboarding/routes/webhooks.js` behind
`/api/v1/webhooks/passport/revoked` and `/api/v1/webhooks/trust/changed`.
Eternitas never calls those endpoints with the documented config.

My Wave 5 live-band tests pass because I seed the trust-cache directly
via `_setCacheForTest`. In production, revoking a bot through Eternitas
will fire → social's handler → social deactivates Matrix → **the
directory trust gates keep seeing the old profile for up to 5 minutes**.

Wave 4's "synchronous cache flush on revoke" claim is technically correct
for the code path I wrote. It's not the code path Eternitas calls. Either
move the flush into social's handler, or repoint `ETERNITAS_WEBHOOK_URL`,
or subscribe to both endpoints on the Eternitas side.

### 3. Any authenticated user can forge a "top_secret" bot in the directory

Live-reproduced this with a throwaway user JWT:

```
$ curl -X POST https://chat.windychat.ai/api/v1/chat/directory/agents/register \
    -H "Authorization: Bearer $USER_JWT" \
    -d '{"passport_number":"ET26-FAKE","agent_name":"Anthropic Official",
         "trust_score":999,"clearance_level":"top_secret"}'
{"registered":true,"passport_number":"ET26-FAKE"}

$ curl -H "Authorization: Bearer $USER_JWT" \
    https://chat.windychat.ai/api/v1/chat/directory/agents/ET26-FAKE
{"agent_name":"Anthropic Official","trust_score":999,
 "clearance_level":"top_secret", ...}
```

The `/register` endpoint is behind `authMiddleware` but has no
service-token check and no re-verification against Eternitas. The action
gates (`/gate/dm`, `/gate/broadcast`, `/gate/mention`) still enforce
trust properly — so the fake bot can't actually send broadcasts — but
the Discover page shows `trust_score: 999` next to a bot name the
attacker chose, which is a social-engineering weapon pointing at our own
users.

### 4. The link-preview route has been dead the entire time

`services/media/server.js:385` registers `app.get('/api/v1/media/:id')`
BEFORE `app.use('/api/v1/media', linkPreviewRouter)` on line 417. Any
GET to `/api/v1/media/link-preview?url=...` resolves to the `:id`
handler, which tries to look up `link-preview` as a media ID, finds
nothing, and returns `{"error":"Media not found"}`. The linkPreviewRouter
is unreachable.

```
$ curl ".../api/v1/media/link-preview?url=https://example.com"
{"error":"Media not found"}   # 404, not the OG scrape
```

I was counting SSRF defenses in `services/media/routes/link-preview.js`
toward "Wave 6 security verified." The defenses don't matter — the code
can't be reached. (Once the shadow is fixed, the SSRF defenses are also
bypassable — see P1 #7.)

### 5. The Chat handle you get depends on which code path provisioned you

Wave 2 mail-aligned-localpart claim: `grant.whitmer@windymail.ai` should
match `@grant.whitmer:chat.windychat.ai`. That only holds if the
identity-created webhook fires BEFORE the user logs into Chat. Live-
reproduced the opposite:

```
# User hits /unified-login first (via Windy Pro login)
$ curl /api/v1/onboarding/unified-login ...
  → matrix_user_id = @windy_grant:chat.windychat.ai   (legacy, prefixed)

# Then the identity-created webhook fires
$ curl /api/v1/webhooks/identity/created ...
  → status: "already_existed", matrix_user_id = @windy_grant:...
```

Same user in Mail gets `grant.whitmer@windymail.ai`. Handles misalign
silently. Both paths look successful; no errors surface.

Two funcs diverge on the same identity:
- `routes/provision.js:62 displayNameToLocalpart` (windy_-prefix, legacy)
- `routes/webhooks.js:99 mailAlignedLocalpart` (no prefix, Wave 2)

First-writer-wins determines the user's chat handle. The race outcome
depends on whether the client beats the account-server's webhook, which
depends on network latency.

---

## P0 — ship-blockers

### P0-1 — Link-preview route is shadowed by `/:id`

**What's broken**: `GET /api/v1/media/link-preview?url=...` always
returns `404 {"error":"Media not found"}` because `app.get('/api/v1/media/:id')`
is registered before `app.use('/api/v1/media', linkPreviewRouter)`.
Feature is 100% non-functional in prod.

**Reproduce**:
```bash
TOKEN=$(node -e 'console.log(require("jsonwebtoken").sign({sub:"t"}, process.env.WINDY_JWT_SECRET, {algorithm:"HS256"}))')
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8107/api/v1/media/link-preview?url=https://example.com"
# → {"error":"Media not found"}
```

**Fix**: move the `app.use('/api/v1/media', linkPreviewRouter)` call
BEFORE the `app.get('/api/v1/media/:id', ...)` handler, OR switch the
link-preview mount to a non-conflicting path like
`/api/v1/media/preview/link`.

**Code**: `services/media/server.js:385-417`

**Effort**: 10 minutes.

### P0-2 — Authed users can inject forged agents into directory

**What's broken**: `POST /api/v1/chat/directory/agents/register` requires
`authMiddleware` only. Any authenticated human can register arbitrary
rows with their chosen `trust_score`, `clearance_level`, `agent_name`,
and `description`. The row is displayed on the Discover page.

**Reproduce**: see TOP 5 #3 above.

**Fix**: gate behind `CHAT_SERVICE_TOKEN` (service-to-service only), and
additionally validate the `passport_number` exists via a Trust API
lookup before storing. Reject unknown or non-active passports.

**Code**: `services/directory/routes/agents.js:154-170` and
`services/directory/server.js:66` (mount chain).

**Effort**: 1 hour (add service-token check middleware, add Trust API
re-verification, add tests).

### P0-3 — Eternitas webhook URL points at social, cache flush code is in onboarding

**What's broken**: `.env.example` and (presumably) production config set
`ETERNITAS_WEBHOOK_URL=https://chat.windychat.ai/api/v1/webhooks/eternitas`
which routes to `services/social/routes/eternitas-webhook.js`. Neither
social's handler nor any path reached from it calls
`invalidateTrustCache()`. My Wave 4 cache-flush endpoints
(`/api/v1/webhooks/passport/revoked`, `/api/v1/webhooks/trust/changed`)
in onboarding are unreachable from Eternitas with the documented config.

**Reproduce**: configure Eternitas with the documented webhook URL; revoke
a passport; make a `/gate/broadcast` call for that bot's passport from a
different IP (so directory's trust-client has it cached); observe that
the gate still returns `allowed: true` for up to 5 min.

**Fix (pick one)**:
1. Add `invalidateTrustCache(passport)` to
   `services/social/routes/eternitas-webhook.js` (in `handlePassportRevoked`).
2. Change `ETERNITAS_WEBHOOK_URL` to point at onboarding and update
   onboarding's handler to ALSO do the Synapse deactivate that social
   currently does.
3. Subscribe to BOTH URLs in Eternitas and let each handler do its own
   work.

Option 1 is the lowest-friction.

**Code**: `services/social/routes/eternitas-webhook.js:145-184`
(`handleRevocation` / `handleReinstatement`) needs to `require` and call
`invalidateTrustCache` from `services/shared/trust-client.js`.

**Effort**: 30 minutes + test.

### P0-4 — Social's `/api/v1/webhooks/eternitas` rejects live-format signatures

**What's broken**: `services/social/routes/eternitas-webhook.js:29-34`
expects a bare hex signature. Eternitas's live webhook format is
`sha256=<hex>` per `eternitas/docs/webhooks.md`. Every real webhook
delivery will 401 at social — combined with P0-3, passport revocations
never land anywhere in Chat.

**Reproduce**:
```bash
SIG="sha256=$(echo -n '{"event":"passport.revoked","passport":"ET26-X","reason":"test"}' | \
     openssl dgst -sha256 -hmac "$ETERNITAS_WEBHOOK_SECRET" | awk '{print $2}')"
curl -X POST -H "x-eternitas-signature: $SIG" -H "Content-Type: application/json" \
  -d '{"event":"passport.revoked","passport":"ET26-X","reason":"test"}' \
  http://localhost:8105/api/v1/webhooks/eternitas
# → 401 invalid signature
```

**Fix**: port the `sha256=` prefix-stripping logic from
`services/onboarding/routes/webhooks.js:verifyHmac` to
`services/social/routes/eternitas-webhook.js` (and the legacy one in
`services/onboarding/routes/provision.js:346`).

**Code**: `services/social/routes/eternitas-webhook.js:26-41` +
`services/onboarding/routes/provision.js:343-352`.

**Effort**: 20 minutes.

### P0-5 — CI reports green on 0 tests

**What's broken**: jest fails to load `services/shared/jwt-verify.js`
because `jwks-rsa` transitively imports `jose` (ESM). Test collection
returns `Tests: 0 total` for onboarding/directory/push-gateway/backup.
CI's `test-unit` job passes because jest exits 0 with no test failures
to report. The Wave 6 security review assertions about tested behavior
are unverifiable in CI today.

**Reproduce**:
```bash
cd services/directory && npm test
# SyntaxError: Unexpected token 'export' at jose/dist/webapi/index.js:1
# Test Suites: 2 failed, 2 total
# Tests: 0 total
```

(Paradoxically, `jest` reports `Test Suites: 2 failed` but still exits 0
under some configurations. Needs confirmation whether CI is seeing the
suite-failure and flagging it red, or treating 0-tests as a pass.)

**Fix**: add `transformIgnorePatterns` to each service's jest config to
let babel-jest transform the ESM-only `jose`/`jwks-rsa` modules, OR
switch jwt-verify's JWKS implementation to a CJS-compatible lib, OR
migrate the jest-style tests in `*/tests/api.test.js` to the node:test
format the Wave 2+ files use.

**Code**: `services/*/package.json` jest config, or
`services/shared/jwt-verify.js` dep change.

**Effort**: 1–2 hours (the transform-ignore pattern + verify each suite
boots).

---

## P1 — fix this week

### P1-1 — /unified-login orphans Matrix accounts under concurrent first-login

**What's broken**: 20 parallel `POST /api/v1/onboarding/unified-login`
for the same new user mint 20 distinct access_tokens and (in production
with real Synapse) 20 distinct Matrix user IDs. Only one profile row
survives via `INSERT OR REPLACE`; the other 19 Matrix accounts orphan.

**Reproduce**: see `docs/audit/concurrency-results.md` §2.

**Fix**: wrap the existing-user lookup + provisioning + profile upsert
in a SQLite transaction with `BEGIN IMMEDIATE`. Or mint a provisioning
lock per `windy_identity_id` (e.g. a Redis SET NX with short TTL).

**Code**: `services/onboarding/routes/provision.js:639-779`.

**Effort**: 2 hours.

### P1-2 — Matrix handle depends on which code path fires first

See TOP 5 #5. `displayNameToLocalpart` vs `mailAlignedLocalpart` produce
different handles for the same identity.

**Fix**: pick one canonical localpart function and use it in BOTH the
unified-login path and the webhook path. Prefer `mailAlignedLocalpart`
(no `windy_` prefix) to maintain the Wave 2 mail-alignment guarantee.

**Code**: `services/onboarding/routes/provision.js:62-77,310,494,672`
and `services/onboarding/routes/webhooks.js:99-117`.

**Effort**: 1 hour + migration plan for existing `@windy_*` users.

### P1-3 — Social's `eternitasCache` never invalidated

**What's broken**: `services/social/server.js:48` caches Eternitas
verifications for 1 hour in a local `Map`. My passport.revoked handler
doesn't flush it. A revoked bot stays "verified" in social for up to an
hour regardless of how many webhooks fire.

**Fix**: expose `eternitasCache.delete(passport)` via a module export
and call it from the webhook handler. Or migrate social to use
`services/shared/trust-client.js` which DOES get flushed (and the gate
docs claim is the single source of truth).

**Code**: `services/social/server.js:47-88`.

**Effort**: 1 hour.

### P1-4 — Oversized / malformed JSON returns 500 instead of 4xx

**What's broken**: express default error handler swallows
`entity.too.large` and `entity.parse.failed` as generic 500s. Rejections
are indistinguishable from crashes in logs.

**Reproduce**:
```bash
python3 -c "print('{\"a\":\"' + 'x'*10000000 + '\"}')" | \
  curl -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" --data-binary @- \
    http://localhost:8101/api/v1/onboarding/unified-login
# → {"error":"Internal server error"} 500

curl -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d 'not-valid-json{' \
  http://localhost:8101/api/v1/onboarding/unified-login
# → {"error":"Internal server error"} 500
```

**Fix**: add a body-parser-aware error handler above the generic one:

```js
app.use((err, _req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  next(err);
});
```

**Code**: every service's `server.js` (onboarding, directory,
push-gateway, backup, social, media).

**Effort**: 1 hour across services + test.

### P1-5 — Trust-gate 403 responses leak full Eternitas profile

**What's broken**: gate denials return the full profile body including
`integrity_score`, per-dimension breakdown, `tier_multiplier`,
`denied_actions`, `evaluated_at`. Callers learn more than they should
about scoring internals, which enables targeted gaming.

**Fix**: in `requireAllowedAction`'s return object and the gate handlers'
error response shapes, omit `profile`. Return only `{allowed, reason,
required}` on deny and `{allowed, gate, sender, clearance_level}` on
allow. Never the full profile.

**Code**: `services/directory/routes/agents.js:219-302`.

**Effort**: 30 minutes.

### P1-6 — Trust-gate endpoints have no per-route rate limit

**What's broken**: every gate call makes 1–2 Eternitas GETs on cache
miss. Eternitas rate-limits 100 req/min/IP. A misbehaving authed caller
bursting gate calls chews through Chat's Eternitas budget; legitimate
gate traffic then gets `trust_api_unreachable` (fail-closed) for up to
5 minutes while the cache rebuilds.

**Fix**: add `express-rate-limit` to each `/gate/*` route with a per-
authed-passport window (30/min). Also negative-cache `trust_api_unreachable`
for 10 s so repeated denials don't amplify load.

**Code**: `services/directory/routes/agents.js:232,258,273`.

**Effort**: 1 hour.

### P1-7 — SSRF in link-preview survives the naive hostname check

**What's broken**: `isPrivateIP` uses pattern-matched hostname strings.
Documented bypasses:
- DNS rebinding (hostname resolves to public IP at check, 10.x at fetch)
- IPv6-mapped IPv4: `[::ffff:127.0.0.1]`
- Integer/hex IP: `2130706433`, `0x7f000001`
- Cloud metadata: `metadata.google.internal`, `metadata.azure.com`

Currently shadowed (see P0-1) — so dormant. Fix P0-1 first and this one
is live.

**Fix**: resolve hostname to IPs via `dns.lookup(host, {all: true})`,
validate every resolved IP against a deny-list (v4 + v6), pass the
resolved IP to the HTTP client (not the hostname) to prevent rebinding.
Use an HTTP agent with a custom `lookup` function that rejects private IPs.

**Code**: `services/media/routes/link-preview.js:40-75`.

**Effort**: 3 hours (needs dual IPv4/IPv6 deny-list + a custom
`http.Agent` lookup).

### P1-8 — Fail-open HMAC verification when NODE_ENV is empty

**What's broken**: three webhook handlers (onboarding/webhooks.js,
onboarding/provision.js, social/eternitas-webhook.js) accept an unsigned
webhook when the secret env var is empty AND `NODE_ENV !== 'production'`.
A container deployed without `NODE_ENV=production` explicitly set will
accept revoke-the-world webhook calls from any caller.

**Fix**: fail-closed when the secret is missing REGARDLESS of NODE_ENV,
except when tests set a specific `NODE_ENV=test` flag. Never use
`!== 'production'` as the permissive branch — it gives the wrong answer
on empty strings.

**Code**:
- `services/onboarding/routes/webhooks.js:56-62`
- `services/onboarding/routes/provision.js:366-372`
- `services/social/routes/eternitas-webhook.js:206-210`

**Effort**: 30 minutes + Dockerfile audit to confirm `NODE_ENV`
defaults.

### P1-9 — Missing env vars in .env.example

**What's broken**: used-in-code but not documented:
- `WINDY_IDENTITY_WEBHOOK_SECRET` (routes/webhooks.js)
- `PUSH_BUS_TOKEN` (routes/notify.js + windy_push_bus.py)
- `ETERNITAS_API_URL` (directory/agents.js, social/server.js — but
  `.env.example` has `ETERNITAS_URL`, which is a DIFFERENT variable name)
- `ETERNITAS_USE_MOCK` (trust-client.js — default switching)
- `FIREBASE_SERVICE_ACCOUNT` (push-gateway server.js — `.env.example`
  documents `FCM_SERVICE_ACCOUNT_PATH` which is NOT the variable the
  code reads)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (push-gateway)
- `TRANSLATION_AS_TOKEN`, `TRANSLATION_HS_TOKEN` (translation appservice)
- `CALL_HISTORY_AS_TOKEN`, `CALL_HISTORY_HS_TOKEN` (call-history)
- `APNS_BUNDLE_ID` (push-gateway)
- `MEDIA_STORAGE_PATH` (media)
- `SYNAPSE_ADMIN_URL` (onboarding, overrides SYNAPSE_URL-based default)
- `SYNAPSE_ADMIN_TOKEN` (used in onboarding server.js — inconsistent
  with CHAT_API_TOKEN elsewhere)

**Fix**: add each to `.env.example` with the correct name, safe default,
and a one-line comment.

**Code**: `.env.example`.

**Effort**: 30 minutes.

### P1-10 — Default ETERNITAS_URL drift across services

**What's broken**:
- `services/shared/trust-client.js:33` defaults to `http://localhost:8500`
- `services/social/server.js:46` defaults to `https://api.eternitas.ai`
- `.env.example:43` sets `ETERNITAS_URL=https://api.eternitas.ai`
- The variable name is `ETERNITAS_URL` in some places, `ETERNITAS_API_URL`
  in others (directory/agents.js:18 reads both, social reads only the
  latter)

Result: if `ETERNITAS_URL` isn't set in a given container, trust-client
and social talk to DIFFERENT Eternitas instances, or social silently
tries the production URL while trust-client hits localhost.

**Fix**: one variable name (`ETERNITAS_URL`). One default (point at the
live prod URL; callers can override for dev). Update every read site.

**Code**: `services/shared/trust-client.js:33`,
`services/social/server.js:46`, `services/directory/routes/agents.js:18`.

**Effort**: 30 minutes.

---

## P2 — polish

### P2-1 — Three redundant Eternitas webhook handlers

Legacy: `/api/v1/chat/provision/eternitas/webhook` (onboarding/provision.js).
Current: `/api/v1/webhooks/eternitas` (social). My Wave 4 adds
`/api/v1/webhooks/passport/revoked` and `/api/v1/webhooks/trust/changed`
(onboarding/webhooks.js). Four total, three actively live. Each does
slightly different work.

**Fix**: pick one authoritative handler (probably the social one with
the expanded Wave 4 behavior merged in), delete the other two, document
the one Eternitas should dispatch to.

**Effort**: 3 hours (including migration tests).

### P2-2 — CORS allowlist missing sibling-product hosts

`windy-chat`'s CORS allowlist includes `chat.windychat.ai` but not
`mail.windymail.ai`, `windyclone.ai`, `windyfly.ai`,
`windycode.org`. Cross-product XHR from those hosts will get blocked.

**Code**: `services/shared/cors.js:8-18`.

**Effort**: 10 minutes.

### P2-3 — Content-Disposition header injection risk

`services/media/server.js:396` sets
`Content-Disposition: inline; filename="${record.original_name}"`
without sanitization. An uploaded file with a filename containing `\r\n`
could inject headers. Low impact (upload path already generates a UUID
filename for disk storage, and `original_name` is user-supplied at upload
time so the attacker owns both upload and fetch).

**Fix**: `encodeURIComponent` or strip `\r\n` from `original_name`.

**Effort**: 10 minutes.

### P2-4 — `pair.js` defaults to production Synapse URL

`services/onboarding/routes/pair.js:78` reads
`process.env.SYNAPSE_URL || 'https://chat.windychat.ai'`. Other places
default to `http://localhost:8008`. Inconsistent — means paired clients
in a local dev run receive a `server` field pointing at prod.

**Fix**: align default to `http://localhost:8008` like the rest.

**Effort**: 10 minutes.

### P2-5 — `/api/v1/social/presence/:userId` is public

Anyone unauthenticated can probe presence for any userId. Low-impact but
reveals "user exists" signal.

**Fix**: require auth, OR return a generic `{status:"unknown"}` for
non-connected users.

**Effort**: 20 minutes.

### P2-6 — `integration-pro.test.js` has 4 stale assertions

Pre-existing: two tests regex-match against `chat.windychat.ai` but the
real server name is `chat.windychat.ai`. Fails 4/22 subtests; untouched
since my Wave 2 notice.

**Fix**: update the regex.

**Code**: `services/onboarding/tests/integration-pro.test.js:262,276,282,334`.

**Effort**: 10 minutes.

---

## P3 — nice-to-have

### P3-1 — Observability on trust-client cache

`X-Trust-Cache: hit|miss` header is returned by Eternitas but we don't
record it. Emitting a simple `trust_cache_hit`/`trust_cache_miss` counter
to Sentry/CloudWatch would show us cache-effectiveness in prod.

**Effort**: 30 minutes.

### P3-2 — `tier_multiplier` not consumed by rate-limiter

Trust API returns a `tier_multiplier` (0.5 for POOR, 5.0 for EXCEPTIONAL)
per the contract. Chat services don't use it. Downstream rate-limiter
code (outside this repo's gate layer) should scale bot quotas by this
multiplier to get the "poor bots throttled" behavior the Wave 5 spec
implied.

**Effort**: 1 hour + design decision on which services consume it.

### P3-3 — JWKS fallback to HS256 is a blast-radius multiplier

Not actively exploitable — `jsonwebtoken` v9 enforces the alg allowlist
correctly. But having a single shared HS256 secret that'll be accepted
whenever JWKS is unreachable means any leak of `WINDY_JWT_SECRET` is a
full-chat compromise across every service. Retire the HS256 fallback
once JWKS is stable.

**Code**: `services/shared/jwt-verify.js:80-91`.

**Effort**: 1 hour.

---

## Phase 4.5 — end-to-end chat flow

Cannot complete against a live Synapse in this window. Reported as
partial:

- ✅ **Trust gate enforcement** — live-verified with `tests/integration/test_trust_live_bands.js` (16/16 against Eternitas at localhost:8500). POOR-band bots pass broadcast (actions derive from clearance, not band); VERIFIED-clearance bot correctly denied. REVD (revoked) fully blocked.
- ✅ **Bot-to-bot path** — proven via the directory `/gate/dm` endpoint with ET26-TEST-EXCP → ET26-TEST-GOOD. Both sides have `dm_bots` in `allowed_actions`; gate returns 200 `allowed: true`.
- ❌ **Two-user message flow** — requires a live Synapse. Not available in this audit window; nor is docker-compose up working out-of-the-box without manual PostgreSQL/Redis bootstrapping.
- ❌ **Typing indicators, read receipts, edits, deletes, attachments, E2E** — same reason; these are Synapse client-server API flows, which means they work as long as Synapse is up + our custom modules don't break them. windy_registration's `check_password` contract against the account-server is code-reviewed but not end-to-end tested in this audit.

**P0** implication: Phase 4.5 is unverified. A real pre-launch
rehearsal needs a docker-compose-up dry run with two clients hitting
`/unified-login`, sending E2E-encrypted messages, and we observe them
arriving. That's not achievable in a gap-analysis sprint; it's a
separate "launch-rehearsal" deliverable.

---

## What I did NOT test (honesty)

- Real Synapse end-to-end message flow (see Phase 4.5 above)
- Load testing beyond 20-parallel bursts (no `hey`/`wrk` installed)
- Coverage percentage numbers (no `--coverage` configured; adding it is
  a P0 dependency before real numbers can be reported)
- `gitleaks`/`trufflehog` against git history (not installed; a manual
  grep of the current tree didn't surface committed secrets but history
  wasn't audited)
- Mobile client integration (windy-pro-mobile lives in a different repo)
- Push delivery to real FCM/APNs (stubbed in the running services —
  production keys not available in my environment)
- ES256 dual-signature JWS branch on Eternitas webhooks (flagged as
  ACCEPTED RISK in Wave 6, still unbuilt — but HMAC is cryptographically
  sufficient, so not a P0)

Anything in this list could be hiding its own P0. The ones I've surfaced
above are the ones I could prove live.
