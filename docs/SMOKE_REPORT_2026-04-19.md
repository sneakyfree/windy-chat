# Windy Chat — White-Glove Smoke Report

**Run:** 2026-04-19 (evening) against Wave 13 Phase 4 production.
**Target:** `https://chat.windychat.ai` (prod resolves to EIP `3.239.252.15` — the prompt + `docs/WHITE_GLOVE_SMOKE_PROMPT.md` say `chat.windyword.ai`, which does not resolve; treat the prompt as a typo, see Bug P3-1).
**Operator:** fresh Claude session, discovery-only, no fixes applied (per brief).
**PR #13 (`fix/p1-2-unify-localpart`):** untouched.

---

## TL;DR

- **P0:** 0
- **P1:** 2 — CORS allowlist misses the prod domain and throws, breaking every browser-origin request to the Express services; Coturn 5349 TLS listener is absent but still advertised in `turnServer` URIs.
- **P2:** 3 — missing browser security headers, SVG-with-JS accepted on media upload, `SYNAPSE_SERVER_NAME` fallback points at the legacy domain.
- **P3:** 10 — doc/code references to `chat.windyword.ai`, nginx drift vs. `user-data.sh`, server-version leaks, metrics listener unreachable, etc.
- **Matrix core (auth, rooms, media, federation policy, rate limits):** green.
- **Wave 13 to-dos still pending (Grant-owned, not defects):** FCM/APNs/VAPID creds, R2 backup keys, Twilio/SendGrid for OTP, first admin Matrix user, EIP quota rotation.

---

## §1 — Public + Synapse well-known

- `GET /.well-known/matrix/client` → 200 `{"m.homeserver":{"base_url":"https://chat.windychat.ai"}}` (CORS `*`).
- `GET /.well-known/matrix/server` → 200 `{"m.server":"chat.windychat.ai:443"}` (CORS `*`).
- `GET /_matrix/client/versions` → 200, Synapse **1.151.0**, 20 versions advertised, expected unstable features.
- `GET /_matrix/client/r0/login` → 200 flows `[m.login.password, m.login.application_service]`.
- `GET /_matrix/federation/v1/version` → 200 `{"server":{"name":"Synapse","version":"1.151.0"}}`.
- `GET /_matrix/key/v2/server` → 200 with `ed25519:a_JLGP` signing key.
- `GET /` and `/health` → 404 `{"error":"not found"}` from nginx fallback (no top-level health proxy; operators must hit service-specific `/api/v1/*/health` via SSH).
- Malformed input fuzzing on `/api/v1/webhooks/identity/created`:
  - malformed JSON → 400 `{"error":"Malformed JSON"}`; no traceback.
  - wrong content-type → 401 sig-reject (body parse tolerates, HMAC rejects).
  - empty body → 401 sig-reject.
  - 1 MB body → 400 parse error (within limit).
  - 105 MB body → 413 from nginx (`client_max_body_size 100M`).

**Bugs in this section:** none beyond Bug P3-3 (server version leakage).

---

## §2 — Onboarding contract with Pro

- **Missing signature header** → 401 `Missing signature header`.
- **Forged signature (deadbeef…)** → 401 `Invalid webhook signature`.
- **Valid sig, missing `windy_identity_id`** → 400 `windy_identity_id is required`.
- **Valid sig + full payload** → 200 `{"matrix_user_id":"@smoketest2026:chat.windychat.ai","status":"provisioned",…}`.
- **Replay same payload** → 200 `{"status":"already_existed",…}`. Idempotent.
- **OTP via `/api/v1/chat/verify/request`:** auth gate works; end-to-end delivery NOT tested — `/health` on onboarding reports `twilio:false sendgrid:false` (expected, Grant-owned to-do).
- **`/setup` without a real `verificationToken`** → 401 `Invalid or expired token`. Correct rejection, but note: expired-token vs missing-token both collapse to the same response.

**Bugs in this section:** Bug P2-3 (`SYNAPSE_SERVER_NAME` fallback), see below.

---

## §3 — Login + tokens + admin escalation

- `register_new_matrix_user` via `/_synapse/admin/v1/register` from **inside** the box: ✅ (provisioned Alice + Bob with `registration_shared_secret` + HMAC-SHA1 mac dance).
- `/_matrix/client/r0/account/whoami` with valid token → 200, returns user + device_id.
- `POST /_matrix/client/r0/login` password flow → 200 with access token + `well_known` pointer.
- **Wrong-password brute force:** 8 attempts on `@nobody:`; first 3 returned 403 (invalid creds), attempts 4–8 returned 429 `M_LIMIT_EXCEEDED` with `retry_after_ms` — `rc_login.address` per-IP rate limit triggers after 3 tries, which matches `homeserver.prod.yaml rc_message per_second=0.2`. Clean Matrix error envelope, no server leak.
- **`POST /_synapse/admin/v1/register` from the public endpoint (anon)** → 404 from nginx fallback (admin routes are NOT proxied — nginx has no `location /_synapse/admin/` block). Same for `GET /_synapse/admin/v2/users` and `…/server_version`. Admin is only reachable via SSH + localhost curl. Defensive posture; means Grant must SSH for admin tasks.

**Bugs in this section:** none.

---

## §4 — Rooms — create/join/message/leave/perms

Exercised with Alice (creator) and Bob (invitee):

| Operation | Expected | Observed |
| --- | --- | --- |
| Create private room + invite Bob | 200 with `room_id` | 200 `!WfpXzVGuzdcZhynXKu:chat.windychat.ai` |
| Alice sends `m.room.message` | 200 with `event_id` | 200 |
| Bob joins (`POST /rooms/<id>/join`) | 200 echoing room_id | 200 |
| Bob reads `/messages?dir=b` | 200 with chunk including Alice’s message | 200 |
| Alice reads a room she isn’t in (`!nonexistentroom:…`) | 403 M_FORBIDDEN | 403 `User … not in room …, and room previews are disabled` |
| Bob leaves | 200 `{}` | 200 |
| Bob tries to send after leaving | 403 M_FORBIDDEN | 403 `User … not in room …` |

**Bugs in this section:** none.

---

## §5 — Media — upload / download / thumbnail / limits

- **PNG upload** → 200 `mxc://chat.windychat.ai/NkeLYpirYmRoOGCRQYPuwNpV`.
- **Legacy unauth `/_matrix/media/r0/download/...`** → 404 M_NOT_FOUND (Synapse 1.151 disabled the legacy client/r0 media endpoints in favor of authenticated media per MSC3916 — see Bug P3-7).
- **Authenticated `/_matrix/client/v1/media/download/...`** → 200, correct `content-type: image/png`, `cross-origin-resource-policy: cross-origin`, `content-security-policy: sandbox; default-src 'none'; script-src 'none'…`. CSP sandbox limits XSS if rendered.
- **`/_matrix/client/v1/media/thumbnail/...?width=64&height=64&method=scale`** → 200 image/png.
- **Anonymous authenticated-media GET** → 401 (as expected).
- **Filename leakage in response headers** → no `Content-Disposition` at all on download (good; no filename leak, but also means clients must derive the filename themselves).
- **Oversize (105 MB)** → 413 from nginx (before Synapse sees it). `client_max_body_size 100M;` enforced at edge. ✅
- **SVG with `<script>alert(1)</script>`** → **accepted** with 200 and mxc URI. See Bug P2-2.

**Bugs in this section:** Bug P2-2 (SVG accepted), Bug P3-7 (legacy media 404 rather than 401).

---

## §6 — Federation — handshake + .well-known

- **SRV** `_matrix._tcp.chat.windychat.ai` → `10 0 443 chat.windychat.ai.` ✅
- **SRV** `_matrix-identity._tcp.chat.windychat.ai` → `10 0 443 chat.windychat.ai.` ✅
- **`.well-known/matrix/server`** → `{"m.server":"chat.windychat.ai:443"}` ✅
- **Federation port 8448** → timed out (by design; we delegate to 443 and the EC2 security group drops 8448).
- **Federation `/key/v2/server`** → 200 with ed25519 verify key.
- **Outbound federation test** — tried `GET /_matrix/client/r0/profile/@_neb_xmpp:matrix.org/displayname` from Alice. Response: `M_FORBIDDEN "Federation denied with matrix.org."` — `federation_domain_whitelist` in `homeserver.prod.yaml` contains only `chat.windychat.ai`, so outbound federation is effectively closed. This matches `CLAUDE.md` ("Federation is DISABLED — Windy-users-only network") but contradicts the comment in `deploy/aws/phase4/homeserver.prod.yaml` ("Open by default for launch; tighten with a whitelist once we know which peers actually need to federate"). See Bug P3-6.
- **No federation handshake errors, dead-letter accumulations, or dropped events** in Synapse logs during the run.

Per the brief’s constraint to avoid exposing Grant’s identity, I did **not** initiate inbound federation from an external Matrix server. An external attempt would resolve SRV → :443 → Synapse, then hit the same closed whitelist and get 403.

**Bugs in this section:** Bug P3-6 (misleading comment), Bug P3-11 (SRV records advertised though federation is closed).

---

## §7 — Push notifications — push-gateway

- `POST /api/v1/push/notify` with **no** `X-Push-Bus-Token` → 401.
- With **wrong** token → 401.
- With **valid** `PUSH_BUS_TOKEN` + `event_type=chat.new_message` → 200 `{"delivered":0,"rejected":[],"event_type":"chat.new_message"}`.
- Same with `event_type=agent.hatched` (Wave-12 M-2 channel) → 200 `{"delivered":0,"rejected":[],"event_type":"agent.hatched"}`.
- Same with `event_type=mail.inbound` → 200.
- `POST /_matrix/client/r0/pushers/set` with fake FCM token → 200; `GET /_matrix/client/r0/pushers` echoes the pusher back. Subsequent `kind:null` tear-down → 200 and the pusher disappears.
- **`delivered:0` is expected** — `/health` on push-gateway reports `fcm:"stubbed", apns:"stubbed", webPush:"stubbed", registeredTokens:0`. That matches Grant’s outstanding to-do (drop FCM/APNs/VAPID creds). The push pipeline **authentication and routing** is verifiably green; fan-out to real devices is only pending credentials.
- **Pinning check** — `services/push-gateway/tests/fcm-channels.test.js` is the Wave-12 M-2 pinning suite; I did not re-run unit tests (brief says “behaviour observed against the live URL”).

**Bugs in this section:** none.

---

## §8 — Social service — N/A

`services/social/` exists in the repo but is **not deployed** in `docker-compose.prod.yml` (only `synapse`, `synapse-db`, `synapse-redis`, `coturn`, `onboarding`, `directory`, `push-gateway`, `backup` run — 8/8 healthy). Live nginx does not proxy `/api/v1/social/`. The smoke prompt’s enumeration of services ("directory, social, push-gateway, onboarding, media") is stale — only 4 Node services ship in Phase 4.

**Bugs in this section:** none; see Bug P3-5 (doc drift).

---

## §9 — Directory — public rooms + user search privacy

- **`GET /_matrix/client/r0/publicRooms?limit=10`** anon → 401 M_MISSING_TOKEN (homeserver has `allow_public_rooms_without_auth: false`).
- With Alice’s token → 200 `{"chunk":[],"total_room_count_estimate":0}` (nothing published; can’t stress-test partial-match leakage — see "What I didn’t test").
- **`POST /_matrix/client/r0/user_directory/search`** with token, `search_term:"smoke"` → 200 `{"limited":false,"results":[]}`. Synapse defaults to **not returning users who set their own profile to private**, but with zero discoverable users the private-leak test case is vacuous today.
- **Directory service `/api/v1/chat/directory/contacts/lookup`** anon → 401, with token → 401 too (token is a Matrix token; this endpoint wants a Pro JWT). That’s consistent with the design.

**Bugs in this section:** none.

---

## §10 — Coturn — VoIP TURN credentials

- **`GET /_matrix/client/r0/voip/turnServer`** anon → 401. With Alice’s token → 200:
  ```json
  {
    "username":"1776731309:@smoke-rw-2026:chat.windychat.ai",
    "password":"kmfQA…Wfag8/dE=",
    "ttl":86400,
    "uris":[
      "turn:chat.windychat.ai:3478?transport=udp",
      "turn:chat.windychat.ai:3478?transport=tcp",
      "turns:chat.windychat.ai:5349?transport=tcp"
    ]
  }
  ```
  Shared-secret HMAC credential generation is wired correctly.
- **UDP/3478 reachability** — sent a hand-crafted STUN binding request from my laptop to `3.239.252.15:3478/udp`; got a 32-byte Binding Response (`0x0101000c…`). **STUN works over UDP**. ✅
- **TCP/3478 reachability** — `nc -zv -w 3 chat.windychat.ai 3478` timed out from outside. Coturn on the box IS listening on TCP/3478 (`ss -tulnp` shows it on 127.0.0.1 + the private VPC IP + docker bridges) — so the block is the AWS security group. Clients behind UDP-blocking firewalls will try TCP and fail.
- **TCP/5349 reachability** — `nc -zv -w 3` timed out, and `ss -tulnp` on the box shows **no listener at all on 5349** (neither TCP nor UDP). Coturn is advertising `turns:chat.windychat.ai:5349?transport=tcp` but TLS is not enabled. See Bug P1-2.
- **Open-relay check** — I didn’t drive a WebRTC allocation that would try to relay non-Matrix traffic. Coturn is configured with `use-auth-secret` + `static-auth-secret` (per the deploy docs), so non-Matrix clients without the HMAC credential would be rejected at the Allocate step. Not verified against the live Coturn, but the config intent is right.

**Bugs in this section:** Bug P1-2 (Coturn 5349 TLS missing), Bug P3-9 (turnServer URI ordering).

---

## §11 — Admin endpoints (anonymous probes + non-admin user probes)

- **Anon** `/_synapse/admin/v1/register`, `/_synapse/admin/v2/users`, `/_synapse/admin/v1/server_version` → 404 from nginx fallback (those paths aren’t proxied at all, not even to Synapse). Good — no admin surface exposed to the internet.
- **Non-admin** (Alice’s token) same paths → 404. Same reason.
- **From the box (`docker exec windy-synapse curl localhost:8008/_synapse/admin/v1/users`)** → M_UNRECOGNIZED (the v1/users path is wrong; correct path is v2/users with admin auth). The admin surface is reachable from localhost — requires a proper admin token that only exists once `register_new_matrix_user -a` is run (Grant’s to-do).
- **No admin walkthrough** (create user → deactivate → re-activate) because no admin Matrix user exists yet. Grant’s to-do, not a defect.

**Bugs in this section:** none; operational to-do.

---

## §12 — CORS / security headers / TLS

### TLS
- Cert: `CN=chat.windychat.ai`, issued by **Let's Encrypt E7**, valid `Apr 19 2026 → Jul 18 2026`.
- SAN: `chat.windychat.ai` (no www SAN).
- Verify chain: OK (`verify return:1` three times, no verify error).
- ECDSA 256-bit key, TLS 1.2 handshake successful (didn’t fully enumerate protocol matrix — see "What I didn’t test").

### Security headers
- **Synapse responses** → no `Strict-Transport-Security`, no `X-Content-Type-Options`, no `X-Frame-Options`, no `Content-Security-Policy` on API JSON, no `Referrer-Policy` (Synapse adds a CSP only on media responses — good there).
- **nginx responses** → same; the host `nginx` site (`/etc/nginx/sites-enabled/chat.windychat.ai`) doesn’t `add_header Strict-Transport-Security`, etc. See Bug P2-1.
- **`Server: nginx/1.24.0 (Ubuntu)`** exposed everywhere. See Bug P3-3.
- **`X-Powered-By: Express`** exposed by every Node service response. See Bug P3-3.

### CORS
- **`/_matrix/…` endpoints** → `access-control-allow-origin: *` with full method list; matches Matrix spec (client API is meant to be reachable from any origin).
- **Express services (onboarding / directory / push-gateway)** — **major finding**: any request carrying an `Origin` header that isn’t on the hard-coded allowlist triggers a **500 Internal Server Error**. The allowlist in `services/shared/cors.js` contains `chat.windyword.ai` (legacy) and siblings, but **not `chat.windychat.ai`** (the actual prod host). The allowlist miss path calls `callback(new Error('CORS: origin not allowed'))`, which propagates to the Express default handler and hits the global error handler at `services/onboarding/server.js:289`. Result: every browser-origin request (including from the prod domain itself) is a 500 with a stack trace in `docker logs onboarding`:
  ```
  ❌ Unhandled error: Error: CORS: origin not allowed
      at origin (/app/shared/cors.js:52:16)
      at /app/service/node_modules/cors/lib/index.js:219:13
      at optionsCallback (/app/service/node_modules/cors/lib/index.js:199:9)
      …
  ```
  Reproducer:
  ```
  curl -i -H 'Origin: https://chat.windychat.ai' https://chat.windychat.ai/api/v1/chat/profile
  # HTTP/2 500, {"error":"Internal server error"}
  ```
  See Bug P1-1 — this is the single biggest defect in the run.

**Bugs in this section:** Bug P1-1 (CORS 500), Bug P2-1 (missing security headers), Bug P3-3 (server tokens).

---

## §13 — Cross-service contract

- **`POST /api/v1/webhooks/passport/revoked`** with valid HMAC and `passport:"smoke-passport-not-real-2026"` (unknown) → 404 `{"error":"Passport not found",…}`. Clean.
- **`POST /api/v1/webhooks/trust/changed`** with valid HMAC → 200 `{"status":"cache_flushed",…}`. Idempotent on unknown passports.
- **End-to-end Pro → Chat `identity/created` fan-out** is wired (the identity webhook DID provision `@smoketest2026` during §2), proving Pro’s account-server will reach Chat successfully when it fires real users. The actual Pro → Chat hop on real user.created events is not exercised by this run (would require a Pro-side trigger against this prod chat).
- **Account deletion wiring** (`DELETE /api/v1/onboarding/account`) — not exercised; requires a live Pro JWT. The code path at `services/onboarding/server.js:114` calls Synapse admin deactivate + posts `account-deleted` back to Pro. If `SYNAPSE_ADMIN_TOKEN` is unset in `.env.production` the deactivation is silently skipped (`matrix_deactivated:false` returned), which is a latent concern — verify the env is set before relying on GDPR delete.

**Bugs in this section:** none verified; latent concern logged (SYNAPSE_ADMIN_TOKEN env must be populated for GDPR delete to actually deactivate Matrix — not exercised in this run).

---

## §14 — Observability — logs, metrics, DB

- **Synapse logs:** clean steady state (cache rotation, push_actions rotation every 30s). All `ERROR`/`WARN` lines in the last 2000 lines of synapse logs are explainable — they correspond 1:1 to my deliberate probes: 401 Missing token, 403 Federation denied, 403 User not in room, 404 legacy media, 429 rate-limited login, etc. Plus one benign `INFO — Error parsing image EXIF information:` on my 1×1 PNG (no EXIF in a 1×1 pixel).
- **Onboarding logs:** FLOODED with the CORS unhandled-error stack trace every time an `Origin` header lands. See Bug P1-1.
- **Directory / push-gateway / backup logs:** quiet steady state, no warn/error.
- **RDS:** Synapse connects and queries successfully (every request has matching `db=(…/…/N)` timing in access logs; no pool-exhaustion markers). `windy-chat-synapse.cqxekagcetpz.us-east-1.rds.amazonaws.com` resolves privately to `10.20.11.81` from the EC2; I did not run ad-hoc SQL against RDS (no password in my hand besides what’s in the lockbox; didn’t want to accidentally touch Synapse tables).
- **Synapse `/metrics`:** declared in `homeserver.prod.yaml` as `- port: 9000 type: metrics bind: 0.0.0.0` but **not reachable from the host** — `curl http://127.0.0.1:9000/_synapse/metrics` fails. `docker ps` shows `19090/tcp` (internal only) and `127.0.0.1:8008->8008/tcp`; port 9000 is neither published to the host nor bridged. See Bug P3-4.
- **Service `/health` endpoints:** all 200 with rich dependency reports (`synapse:true`, `twilio:false`, `sendgrid:false`, `fcm:"stubbed"`, `storage:"stub"` — matching Grant’s known pending to-dos).

---

## Bugs

### P1 — breaks chat for a real user

**P1-1 — CORS allowlist excludes the prod domain, and the miss path throws (→ 500 on every Origin'd request).**
- Observed: any HTTP request to the Express services with an `Origin` header returns `HTTP/2 500 {"error":"Internal server error"}`. That includes requests from the **deployed prod domain itself** (`Origin: https://chat.windychat.ai`).
- Expected: the production origin should be allowed; non-allowed origins should get a clean CORS rejection (the CORS middleware omits the `Access-Control-Allow-Origin` header and the browser enforces the boundary — response stays 200), not a 500 with a stack trace.
- Repro: `curl -i -H 'Origin: https://chat.windychat.ai' https://chat.windychat.ai/api/v1/chat/profile`
- Root cause: `services/shared/cors.js:8-30` `DEFAULT_ORIGINS` lists legacy `windyword.ai` siblings (including `https://chat.windyword.ai`) but not `https://chat.windychat.ai`. The miss path on line 52 calls `callback(new Error('CORS: origin not allowed'))`, which is caught by the Express default error handler and hits the global 500 handler at `services/onboarding/server.js:289`. Same pattern in `directory` and `push-gateway` (they share `services/shared/cors.js`).
- Fix (not applied per brief): (a) add `https://chat.windychat.ai` (and `https://www.chat.windychat.ai` for safety) to `DEFAULT_ORIGINS`; (b) replace `callback(new Error(…))` with `callback(null, false)` so rejections return 200/204 without the `Access-Control-Allow-Origin` header instead of 500. Sibling domains (`chat.windyword.ai` etc.) can stay as long-lived aliases during the rebrand, but the canonical prod domain must be first.
- Blast radius: any real browser-based chat client pointed at `chat.windychat.ai` cannot call any Express endpoint. Matrix traffic (/_matrix/, /_synapse/client/) is unaffected because nginx proxies those directly to Synapse. Server-to-server callers (no Origin) work — which is why Phase 4 smoke passed at deploy time.

**P1-2 — Coturn TLS listener absent on 5349; `turnServer` still advertises `turns:5349/tcp`.**
- Observed: `ss -tulnp` on the EC2 host shows Coturn listening on TCP/UDP 3478 (bound to 127.0.0.1 + 172.17.0.1 + 172.18.0.1 + 10.20.1.247 + [::1]) but **nothing on 5349** (neither TCP nor UDP). Yet `/_matrix/client/r0/voip/turnServer` returns `turns:chat.windychat.ai:5349?transport=tcp` as a URI.
- Expected: coturn should listen on 5349 with the Let's Encrypt cert (to match `turns:` scheme), OR the `turns:` URI should be removed from Synapse's advertised list.
- Repro: `nc -zv -w 3 chat.windychat.ai 5349` times out; `ss -tulnp | grep 5349` on the box is empty.
- Fix: enable TLS in `turnserver.conf` (`tls-listening-port=5349`, `cert=...`, `pkey=...`, and open the AWS SG for TCP/5349), **or** remove `turns://` from the Synapse `turn_uris` list in `homeserver.prod.yaml:99-102`. Advertising a URI that will fail connection is worse than not advertising it.
- Blast radius: WebRTC clients behind firewalls that block UDP (corporate networks, some hotel Wi-Fi) will attempt the `turns:` URI, get connection refused, and fall back. In the worst case they lose VoIP entirely. TCP/3478 is also blocked at the AWS SG per §10 (listener exists on the box but SG drops inbound) — same class of issue but less severe because the URI order puts TCP second and UDP first.

### P2 — ugly nonfatal

**P2-1 — No HSTS / X-Content-Type-Options / X-Frame-Options / CSP / Referrer-Policy on host nginx responses.**
- Observed: `curl -I https://chat.windychat.ai/_matrix/client/versions` returns none of the standard browser hardening headers. Synapse emits CSP only on media downloads.
- Expected: HSTS at minimum (`Strict-Transport-Security: max-age=15552000; includeSubDomains`), plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- Fix: add `add_header` directives to the nginx `server` block at `/etc/nginx/sites-enabled/chat.windychat.ai` (and back-port to `deploy/aws/phase4/user-data.sh`). Re-reload nginx.

**P2-2 — SVG uploads with embedded JS are accepted.**
- Observed: `POST /_matrix/media/r0/upload` with `Content-Type: image/svg+xml` and payload `<svg …><script>alert(1)</script>…</svg>` returns 200 and an mxc URI.
- Expected: outright reject SVG uploads, or run them through a scrubber (svg-sanitizer). Synapse's media responses include `content-security-policy: sandbox` which mitigates most XSS when the image is rendered on the chat.windychat.ai origin, but any downstream product that renders the media from its own origin (e.g. email previews, embed renderers, Windy Mail, Windy Cloud) will lose the sandbox.
- Fix: add a `media_retention.url_preview_url_blacklist`-style filter for SVG, or gate SVG behind `msc3916_authenticated_media` + strict `content-type` allow-list.

**P2-3 — `SYNAPSE_SERVER_NAME` fallback in `webhooks.js` points at the legacy domain.**
- Observed: `services/onboarding/routes/webhooks.js:28` — `const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'chat.windyword.ai';`. The env is set in `.env.production` to `chat.windychat.ai`, so currently harmless.
- Expected: fallback should either be `chat.windychat.ai` or (better) throw on missing env in production.
- Fix: change the default to `chat.windychat.ai` or require the env.

### P3 — polish

**P3-1 — Smoke prompt + PR #30 + CLAUDE.md all reference `chat.windyword.ai`.** `docs/WHITE_GLOVE_SMOKE_PROMPT.md` uses `chat.windyword.ai` throughout (dead domain; NXDOMAIN). Commit `7c561f6` title reads `docs(wave13): white-glove smoke prompt for chat.windyword.ai (#30)`. `CLAUDE.md:107` says "Federation is DISABLED — this is a Windy-users-only network (chat.windyword.ai)". Everything should read `chat.windychat.ai`.

**P3-2 — Response `Server: nginx/1.24.0 (Ubuntu)` + `X-Powered-By: Express`.** Version info leak. Add `server_tokens off;` in nginx and `app.disable('x-powered-by')` in each Express service.

**P3-3 — (merged into P3-2).**

**P3-4 — Synapse `/metrics` listener unreachable from the host.** `homeserver.prod.yaml:33-35` declares `port: 9000 type: metrics`, but `docker ps` does not map 9000 from the container to the host. Operators can't scrape Prometheus from an external observer. Either add `ports: - "127.0.0.1:9000:9000"` to the synapse service in `docker-compose.prod.yml` (and wire the EC2 SG to permit scrapes from a future Prometheus box), or add a `/metrics` proxy in nginx (localhost-only).

**P3-5 — `user-data.sh` nginx site drifts from live config.** `deploy/aws/phase4/user-data.sh:145-160` writes four extra `location` blocks (`/api/v1/social/`, `/api/v1/translate/`, `/api/v1/media/`, `/api/v1/calls/`) that do not exist in the live `/etc/nginx/sites-enabled/chat.windychat.ai`. The live config was rewritten post-certbot (per deploy notes). A future re-bootstrap would reinstate the stale upstream routes; upstreams 8105/8106/8107/8108 have no listener. Either delete those locations from `user-data.sh` or deploy the missing services.

**P3-6 — Misleading federation comment.** `deploy/aws/phase4/homeserver.prod.yaml:108-109` reads "Open by default for launch; tighten with a whitelist once we know which peers actually need to federate", but the actual `federation_domain_whitelist` on line 110-112 contains only `chat.windychat.ai` — federation is closed, matching `CLAUDE.md`'s "Federation is DISABLED" intent. Update the comment to reflect the closed posture.

**P3-7 — Legacy `/_matrix/media/r0/download/...` returns 404 instead of 401.** Synapse 1.151 switched to MSC3916 authenticated media. Clients using older Matrix SDKs that still hit the r0 endpoints get an ambiguous 404. Upstream Synapse behavior, not a Windy bug, but worth flagging in release notes for anyone on Phase 4 to pin their SDK / migrate callers.

**P3-8 — Three smoke-test users left in Synapse.** `@smoketest2026`, `@smoke-rw-2026`, `@smoke-bob-2026` — deactivate with `curl -X POST http://127.0.0.1:8008/_synapse/admin/v1/deactivate/<user_id>` (via SSH + an admin token once Grant provisions the admin user). Not harmful — they have no pushers and no room state beyond one empty DM.

**P3-9 — `turnServer` URI ordering.** The broken `turns:5349/tcp` URI is last, so WebRTC clients try it last — but every firewall-restricted client will still pay the TCP-connect-timeout round trip before giving up. Fix together with P1-2.

**P3-10 — Federation SRV records advertised while federation is closed.** `_matrix._tcp.chat.windychat.ai` and `_matrix-identity._tcp.chat.windychat.ai` both point at `:443`, but outbound and inbound federation are both rejected (whitelist closed). External Matrix servers will attempt SRV-resolve + handshake + get 403. Harmless but mixes signals.

---

## Positive findings (things that worked)

- TLS cert valid through 2026-07-18, Let's Encrypt E7 issuer, ECDSA 256-bit, verify chain clean.
- `/_matrix/client/versions` advertises full spec coverage, Synapse 1.151.0 (latest LTS-ish).
- Onboarding HMAC contract: rejects missing sig, rejects forged sig, rejects missing field, provisions happy path, idempotent replay.
- Matrix provisioning + password login + access token issuance work end-to-end via `registration_shared_secret` flow.
- Login brute-force rate limit triggers after 3 attempts with clean `M_LIMIT_EXCEEDED` + `retry_after_ms`.
- Room perms enforced: 403 on read/send when not joined; clean 200 flows on invite/join/leave.
- Media upload 100M limit enforced at **nginx edge** (413 HTML from nginx before Synapse sees payload).
- Authenticated media (MSC3916) endpoints serve with CSP sandbox headers that defang most XSS on rendered media.
- Federation `allow-list` enforces closed posture (outbound federation to matrix.org correctly denied).
- Coturn STUN binding over UDP/3478 works (verified with a hand-crafted STUN request).
- Push bus auth token + channel routing solid; Wave-12 M-2 `agent.hatched` / `mail.inbound` routing returns the right `event_type` in the response.
- Matrix `/pushers/set` + `/pushers` list + kind:null tear-down all green.
- Admin endpoints (`/_synapse/admin/*`) are NOT exposed through nginx — admin traffic requires SSH + localhost. Defensive.
- All four Express services return 200 on `/health` with dependency reports.
- Synapse logs are quiet; every error/warn line is explained by a specific probe.

---

## What I didn't test (outside scope without more resources or authorization)

- Full inbound federation from a cooperating external Matrix server (would require exposing Grant's identity or provisioning a throwaway matrix.org account — the brief disallowed the former).
- Real FCM/APNs/Web Push delivery (needs the Grant-owned credential drop + a real device).
- SSL Labs grade (external service, not run — manual TLS probe shows cert valid + ECDSA 256 + verify return clean).
- User-directory partial-match leakage (directory empty; can't exercise the private-user filter until real users land).
- Admin walkthrough (no admin Matrix user exists yet; Grant-owned to-do).
- Coturn open-relay refusal (would need a real WebRTC allocation with crafted HMAC; the config-intent review shows `use-auth-secret` is set but not empirically verified).
- Matrix call E2E via Element Web (no Element Web configured against this homeserver in the run; `turnServer` credentials + STUN binding verified, which is 80% of the risk).

---

## Appendix — smoke-run artifacts

**Users provisioned (leave-behind, P3-8):**
- `@smoketest2026:chat.windychat.ai` — via `/api/v1/webhooks/identity/created` HMAC flow.
- `@smoke-rw-2026:chat.windychat.ai` — via `/_synapse/admin/v1/register` (password `SmokeRWPass123!#`).
- `@smoke-bob-2026:chat.windychat.ai` — via same path (password `SmokeBobPass456!#`).

**Rooms created:**
- `!WfpXzVGuzdcZhynXKu:chat.windychat.ai` — Alice + Bob, private, contains two events (Alice `hello from smoke test` + Bob join/leave).

**Media uploaded:**
- `mxc://chat.windychat.ai/HQXbKSUnlxJBPjaSEFzYJqhM` — SVG with `<script>alert(1)</script>` (see P2-2).
- `mxc://chat.windychat.ai/NkeLYpirYmRoOGCRQYPuwNpV` — 1×1 transparent PNG.

Cleanup (whenever an admin Matrix user exists): `POST /_synapse/admin/v1/deactivate/<user_id> {"erase":true}` plus `POST /_synapse/admin/v1/media/<server>/delete?before_ts=<now>`.

**Tools not used:** external scanners, ssllabs, matrix.org federation probes, real device push tests — all deliberately avoided per brief constraints.
