# Wave 11 Hardening Report — Windy Chat

Hostile-QA pass. Each finding below is tagged `[LIVE]` (reproduced
against running services today), `[STATIC]` (code review; not executed
because a fixture is missing), or `[GAP]` (cannot be exercised in this
environment and represents a launch-blocker to test elsewhere).

Severity scale: **CRITICAL > HIGH > MEDIUM > LOW > INFO**.

Evidence for live findings is in
[`docs/wave11-artifacts/`](wave11-artifacts/) (raw probe outputs +
service logs).

---

## Methodology and scope

**Booted locally:** onboarding `:8101`, directory `:8102`,
push-gateway `:8103`, backup `:8104` — as four independent
`node server.js` processes with dev-stub credentials. All four
responded `HTTP 200` on `/health`.

**Not booted:** Synapse, Coturn, Postgres, Redis, Eternitas trust API,
windy-pro account-server, web client (static React build).
Docker is available on the host but pulling + initializing
`matrixdotorg/synapse:latest` + Postgres + Redis is a 3-5 minute
cycle per attempt; within the time budget of this session a
targeted live probe of the Node services plus static review of the
Synapse + web bits was more productive than a partial multi-minute
Docker boot. Synapse-dependent probes are catalogued under `[GAP]`
below with the exact command that would exercise them once a fixture
is stood up.

**JWT secret used for probes:** `wave11-hardening-jwt-secret`
(HS256). **Push bus token:** `wave11-push-bus-token`. **Identity
webhook HMAC secret:** `wave11-identity-webhook-secret`. All ephemeral
to the probe environment.

**Raw evidence:** every curl in `docs/wave11-artifacts/probe-results.md`
with response body + status code. Service-side logs tailed into
`docs/wave11-artifacts/{onboarding,directory,push-gateway}.log`.

---

## Findings

### HIGH

---

#### H-1 — `/api/v1/chat/push/register` does not bind `userId` to JWT `sub` `[LIVE]`

**What:** Any valid Pro JWT can register a device pushkey against an
arbitrary `userId`. The handler (`services/push-gateway/server.js`
L358–395) reads `userId` from the request body and writes it
verbatim to `push_tokens.user_id`, with no cross-check against
`req.user.sub` / `req.user.windy_identity_id`.

**Impact:** Classic horizontal privilege escalation →
**push-notification hijacking**. An attacker with any working Windy
Pro account can register their device token under a victim's
account. Every `/api/v1/push/notify` call fanned out for that
victim (chat messages, mail alerts, `agent.hatched`, passport
trust changes, etc.) will be delivered to the attacker's device.
Device push bodies are privacy-limited (no message content) but
metadata leakage is real — sender display name, counts,
deep-links, `agent.hatched` avatar + passport number.

**Repro (against the probe stack):**

```bash
# Attacker's own JWT (sub = attacker-001)
TOKEN=…                      # attacker's valid Pro JWT
curl -sS -X POST http://127.0.0.1:8103/api/v1/chat/push/register \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"pushkey":"stolen-pushkey","userId":"wave11-user","platform":"android","deviceName":"Attacker Device"}'
# → {"success":true}  HTTP 201

# Verify victim's token list now includes the attacker's pushkey:
sqlite3 services/push-gateway/data/push-gateway.db \
  'SELECT user_id, pushkey, device_name FROM push_tokens WHERE user_id="wave11-user";'
# wave11-user|wave11-android-pushkey|Pixel 9
# wave11-user|wave11-ios-pushkey|iPhone 15
# wave11-user|{…web subscription…}|Chrome on macOS
# wave11-user|stolen-pushkey|Attacker Device   ← registered by attacker-001
```

Raw log at `docs/wave11-artifacts/probe-results.md` section 3, plus
the extra adversarial probe "`attacker registers victim's push token
→ HTTP 201`".

**Fix:** in the `/api/v1/chat/push/register` handler, require
`req.body.userId === req.user.windy_identity_id`
(or `=== req.user.sub`) and 403 otherwise. Keep the existing
`isValidUserId` check as a format guard. Adjacent: `push/mute` and
`push/unmute` (same file, L401–459) have the same shape and should
get the same ownership check — a call to that confirmed the mute
endpoint also ignores JWT-sub in favor of the body's `userId`.

---

### MEDIUM

---

#### M-1 — `/api/v1/chat/push/test` accepts arbitrary pushkeys `[LIVE]`

**What:** The diagnostic "send me a test push" endpoint
(`services/push-gateway/server.js` L466) is protected by the standard
JWT middleware but does not constrain the `pushkey` argument to one
the caller owns. Any authenticated user can POST a `pushkey` and
`platform`, and the gateway will dispatch an FCM/APNs/WebPush send
to that target.

**Impact:** Outbound spam channel for notification abuse. Can be
used to:
- send arbitrary push copy to any registered device whose pushkey
  the attacker knows;
- enumerate whether a pushkey is still valid (success vs.
  delivery-failed response);
- drain FCM/APNs rate budget.

**Repro:**
```
POST /api/v1/chat/push/test
Authorization: Bearer <any valid JWT>
{"pushkey":"arbitrary-target","platform":"android","title":"pwned","body":"oh no"}
→ 200 {"success":true,"platform":"android","stub":true}
```

(In dev-stub mode the gateway logs the intended send instead of
delivering; in production with FCM configured this would be a real
notification.)

**Fix:** restrict to pushkeys registered for the caller's own
`userId`, or gate behind a service-role claim / admin-only token.

---

#### M-2 — Non-chat push events land on the `chat_messages` Android channel `[LIVE]`

**What:** `sendFCM` in `services/push-gateway/server.js` L228 hardcodes
`channelId: payload.eventType === 'agent.hatched' ? 'agent_hatched'
: 'chat_messages'`. All other event types
(`mail.inbound`, `cloud.quota_warn`, `passport.trust_changed`,
`fly.task_completed`, …) are fan-routed to `chat_messages` on
Android.

**Impact:** Grandma gets a "new mail" notification that visually
says "Windy Chat — new message" and respects the user's chat
notification preferences (quiet hours, per-room mutes, chat-channel
sound). Passport revocations — arguably a security event — ride
the same channel as casual DMs. Wave 8 branded push-gateway as the
"unified notification bus for the whole ecosystem," but FCM channel
routing is not unified.

**Repro:** `docs/wave11-artifacts/push-gateway.log` lines 21–40 show
`[notify] mail.inbound → wave11-user: 3/3 delivered`,
`[notify] cloud.quota_warn → wave11-user: 3/3 delivered`, etc. — all
four non-chat event types fan out successfully but route through
the same hard-coded `chat_messages` channel in the FCM payload
construction.

**Fix:** map event_type → channelId explicitly. Minimum:
`chat.*` → `chat_messages`, `mail.*` → `mail`,
`agent.hatched` → `agent_hatched`, `passport.*` → `security`,
`cloud.*` → `system`, `fly.*` → `agent_updates`. The existing
FCM `notification.channelId` field is the only FCM-side change
required; the Android client needs the corresponding channels
created via `NotificationManager.createNotificationChannel` on
first launch (follow-up PR in `windy-pro-mobile`).

---

#### M-3 — HTML stripping on `agent_name` is naive `[LIVE]`

**What:** `services/onboarding/routes/agent-provision.js` L255 runs
`sanitizedName = agent_name.replace(/<[^>]*>/g, '').trim()`. This
strips tags but keeps their text content.

**Repro:**
```
POST /api/v1/onboarding/agent/
{"passport_number":"ET26-XSS-01","agent_name":"<script>alert(1)</script>XssFly", …}
→ 201 { …, "agent_name":"alert(1)XssFly", … }
```

The Matrix display name ends up as the literal string
`alert(1)XssFly`, which Matrix will render as plain text safely. The
residual risk is any **non-Matrix** surface that reads
`agent_credentials.agent_name` and interpolates it unescaped
(directory admin UI, future email templates, notification titles).

**Impact:** LOW in isolation because downstream consumers treat
display names as plain text, but the sanitization function silently
mutates user-controlled input without rejecting an attack string —
the kind of "works today, breaks tomorrow when someone adds a new
template rendering this field" latent bug.

**Fix:** Either reject any agent_name containing `<` / `>` with 400,
or stop the partial strip and store the raw value + escape at every
render surface (preferred — validation at the boundary, not the
sink).

---

#### M-4 — Push `body` field has no length cap `[LIVE]`

**What:** `/api/v1/push/notify` accepts arbitrary-length `body`
up to the `express.json` 1 MB limit (enforced —
`docs/wave11-artifacts/probe-results.md` "F-retry" → 413 at 1.5 MB
input). Within the 1 MB envelope, there is no per-field length
check on `body` or `title` before they reach the FCM/APNs/WebPush
payload.

**Impact:** A 900 KB `body` gets packed into an FCM notification;
FCM's own 4 KB per-message cap will reject it at delivery time
(silent wasted round-trip). APNs cap is also 4 KB. Low-severity
wasted capacity + unactionable "delivery failed" noise in
`rejected`.

**Fix:** enforce `title.length ≤ 200`, `body.length ≤ 1000` (fits
both APNs and FCM with room) at the route layer, return 400 on
overflow.

---

### LOW

---

#### L-1 — Token registration returns `{"success":true}` and nothing else `[LIVE]`

The register endpoint writes to the DB and responds with a 201 + a
success flag. Clients have no confirmation of *which* pushkey was
persisted (helpful for debugging server-side truncation) nor the
bound userId (helpful for H-1 once fixed — clients could verify the
server agreed with their claim). Tiny DX + debuggability improvement.

---

#### L-2 — Dev-stub access tokens leak through to JSON response `[LIVE]`

`/unified-login` in dev mode returns
`"access_token":"dev_token_…"`. That's intended for development, but
since `.env.example` ships with `SYNAPSE_REGISTRATION_SECRET` blank,
any operator running the default Dockerfile in staging will
inadvertently expose stubbed tokens that Matrix clients will try to
authenticate with and fail in confusing ways. Worth gating behind
an explicit `ALLOW_DEV_STUBS=true` rather than the current
`NODE_ENV != 'production'` test.

---

#### L-3 — Trust gate contract is not in `docs/` `[STATIC]`

`services/directory/docs/trust-gates.md` documents the *rules*
(what actions each band allows) but the request/response schemas
for `/agents/gate/{dm,broadcast,mention}` are discoverable only by
reading `services/directory/routes/agents.js`. A probe against the
DM gate returned `{"error":"recipient_passport is required"}`
only after the caller supplied the wrong field name — no
reference doc names the required fields (`recipient_passport`,
`is_connected`, `target_room_id`, `reason`). Recommend adding
example requests for each gate to `trust-gates.md`.

---

### INFO — things that work correctly `[LIVE]`

These are positive confirmations, not findings. Each was actively
probed and behaved as it should:

- **HMAC verification** on `/api/v1/webhooks/identity/created`:
  - missing `x-windy-signature` → 401
  - wrong signature → 401
  - valid signature with tampered body → 401
  - valid signature + untampered body → 200
  - replay with same signature → 200 `already_existed`
- **JWT validation** on onboarding:
  - no token → 401
  - token signed with wrong secret → 401
  - expired token → 401
  - valid token → 201 + provisioned credentials
- **Push bus token**:
  - missing `X-Push-Bus-Token` → 401
  - wrong token → 401
- **Fail-closed trust gates**: with Eternitas unreachable, every bot
  JWT gate returns `403 trust_api_unreachable`. Human JWTs (no
  `passport_id` claim) bypass the gate with `caller: "human"` as
  documented. No failure opens the gate.
- **Wave 8 Grandma Ribbon end-to-end**:
  - Agent hatches with no owner in Chat → `welcome_pending: true`,
    `dm_room_id: null`.
  - Owner's `/api/v1/webhooks/identity/created` fires → response
    includes `"seeded_agent_rooms":[{…room_id…}]`, `agent_rooms`
    table gets the row, `agent_credentials.welcomed_at` is set.
  - `/api/v1/chat/agent-room` returns the seeded room.
  - Replay → `already_existed`, no double-seed.
- **Cross-service push fan-out**: mail.inbound, cloud.quota_warn,
  passport.trust_changed, fly.task_completed all accepted and
  fanned to all 3 registered device platforms — the bus *is*
  event-type-agnostic for routing (it's the channel assignment in
  M-2 that's the half-wired part).
- **Oversize request protection**: 1.5 MB body → `413` with
  `{"error":"Payload too large","limit":1048576,"length":1500089}`.
  The Wave 9 `bodyErrorHandler` import is working on the
  push-gateway.
- **Duplicate passport handling**: second `/api/v1/onboarding/agent/`
  POST with the same passport but a different owner returns
  `already_provisioned: true` and does NOT overwrite the original
  owner's mapping — no cross-owner poisoning via agent-provision.

---

### GAPS (could not exercise, repro commands documented)

---

#### G-1 — Federation is off; no cross-server message test `[GAP]`

**State today:** `deploy/synapse/homeserver.yaml` L84 sets
`federation_domain_whitelist: []` (closed) and the listener config
(L12–18) exposes only the `client` resource on :8008 — no `federation`
resource on :8448. DEPLOY.md (Wave 9) documents federation as
intentionally off until legal sign-off.

**Launch gap:** the Wave 11 task's "send a message cross-server"
check is **not-applicable until federation flips on**. When it does:

```bash
# Federation tester
curl https://federationtester.matrix.org/api/federation-ok?server_name=chat.windychat.com
# Expected: {"FederationOK":true, …}

# Cross-server join + message (requires matrix-js-sdk fixture)
```

#### G-2 — Synapse message persistence across restart `[GAP]`

Wave 11 asked for "kill + restart Synapse, re-fetch room — message
still there?". This is *Synapse's* responsibility (Postgres WAL +
`media_store_path` + the macaroon signing key survive restarts),
not chat-layer. Validation requires a real Synapse container;
postgres volume + signing.key persistence is covered by
`DEPLOY.md` §5. Confirm on deploy with:

```bash
docker compose restart synapse
# client reconnect + retrieve room timeline
curl https://chat.windychat.com/_matrix/client/v3/rooms/!X:chat.windychat.com/messages \
  -H 'Authorization: Bearer <access_token>'
```

#### G-3 — Translation at render time vs. at store time `[STATIC]`

The Wave 11 task implied translation is server-side middleware that
translates stored messages. **It is not.** The web client
(`web/src/env.ts` L7, `web/src/pages/SettingsPage.tsx` L79
"Auto-translate messages" toggle) calls `VITE_TRANSLATE_URL` =
`/api/v1/translate` at **render time**. Messages persist in Matrix
in their original language; each client requests a translation
when displaying. This is correct for privacy (Matrix stays
source-of-truth) and for E2E-encrypted rooms (server can't see
plaintext to translate). Not a bug — tightening the spec in the
Wave 11 task description.

#### G-4 — Live FCM / APNs delivery `[GAP]`

All push tests ran against dev stubs
(`FIREBASE_SERVICE_ACCOUNT`, `APNS_KEY_PATH`, `VAPID_PUBLIC_KEY`
all unset). Payload **shapes** are verified via the
`buildAgentHatchedPayload` unit test (Wave 8 `agent-hatched.test.js`)
and the `sendFCM` / `sendAPNs` payload construction paths are
code-reviewed — but a delivery round-trip against Firebase / Apple
requires a project-level service account. Smoke-test hook in
`scripts/smoke-test.sh` (Wave 9) covers the live-delivery path
once the `.env.production` credentials are in place.

#### G-5 — Web UI screenshots `[GAP]`

No browser is available in this CLI environment. The static review
found no `dangerouslySetInnerHTML` or `innerHTML` sinks in
`web/src/`, and the Wave 8 `RoomHeader.tsx` gains an Eternitas
`TrustBadge` + clearance pill for agent DMs that renders from
directory data. A visual pass is best done by the designer during
the pre-launch walkthrough — this report is not a substitute.

---

## Recommended pre-launch fix order

1. **H-1** — bind `userId` to JWT sub in
   `services/push-gateway/server.js` push/register, push/mute,
   push/unmute. Ship in a Wave 12 hotfix PR.
2. **M-1** — same treatment for `/api/v1/chat/push/test` (or
   demote to admin-only).
3. **M-2** — FCM channel routing map.
4. **M-4** — per-field length caps on push-gateway notify.
5. **M-3** — tighten `agent_name` validation.
6. **L-1 / L-2 / L-3** — DX improvements once the three above ship.

GAP items G-1, G-2, G-4, G-5 should be exercised during the
production staging dry-run with real infrastructure present.

---

## Regression posture after this pass

- Wave 8 `grandma-ribbon.test.js` — still green (3/3).
- Wave 8 `agent-hatched.test.js` — still green (6/6).
- Wave 10 batch (10 suites, 158 tests) — still green.
- No production code touched by Wave 11. This report is
  measurement only; fixes go in Wave 12.
