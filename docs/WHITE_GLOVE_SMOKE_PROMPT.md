# White-Glove Smoke Prompt — windy-chat

**Created:** 2026-04-19, after Wave 13 Phase 4 deploy to AWS
**Purpose:** Hand to a fresh Claude session to do industrial-grade smoke testing on the deployed windy-chat at `https://chat.windyword.ai`.

---

## Why this prompt exists

Wave 13 Phase 4 shipped windy-chat to AWS. It's a Matrix homeserver (Synapse) wrapped in 5 microservices (directory, social, push-gateway, onboarding, media). None of this has been clicked through against the deployed surface. Matrix federation, Synapse worker pools, push notifications, and onboarding flows all have nuanced failure modes that pass unit tests and break in prod. This prompt forces a fresh Claude session to behave like a brand-new chat user, an existing power user, and an attacker probing for federation leaks.

---

## Paste this to a fresh Claude session

> You are doing **industrial-grade white-glove smoke testing** on the production windy-chat, freshly deployed to AWS as Wave 13 Phase 4 at `https://chat.windyword.ai`. Your job is to find every defect a real chat user OR a federation attacker would hit. Unit tests do NOT count — only behaviour observed against the live URL.
>
> **Read first:**
>
> 1. `~/.claude/projects/-Users-thewindstorm/memory/MEMORY.md` (auto-loaded)
> 2. `/tmp/kit-army-config/ACCESS_LOCKBOX.md` — search "Wave 13" + "windy-chat"; gives you live URL `chat.windyword.ai`, EC2 instance, RDS Postgres for Synapse, Coturn shared secret, registration_shared_secret, macaroon_secret_key, form_secret, push bus token, chat API tokens, CHAT_SERVICE_TOKEN.
> 3. `windy-chat/docker-compose.prod.yml` — what's deployed, in what topology.
> 4. `windy-chat/services/{directory,social,push-gateway,onboarding,media}/routes/` — each microservice's surface.
> 5. `windy-chat/DEPLOY.md` and `windy-chat/CLAUDE.md` — conventions.
>
> **Then do all of the following against `https://chat.windyword.ai`:**
>
> ### 1. Public + Synapse well-known
> - `GET /` and `GET /health` — both respond, latency under 200 ms?
> - `GET /.well-known/matrix/client` — returns valid Matrix client config? Points at the right `m.homeserver` URL?
> - `GET /.well-known/matrix/server` — returns valid federation hint? Port included?
> - `GET /_matrix/client/versions` — Synapse responds with supported Matrix spec versions?
> - `GET /_matrix/client/r0/login` — auth flows enumerated?
> - Send malformed JSON, wrong content-type, empty body, 10MB body to a POST endpoint → clean 400, never 500 with Python traceback or Synapse internal error envelope.
>
> ### 2. Onboarding — the Pro contract
> - The onboarding service mediates between Pro and Synapse. The mobile app calls `POST /api/v1/chat/register` (or whatever onboarding's registration endpoint is — check `services/onboarding/routes/`) with a Pro identity token. Verify it creates a Matrix user account on Synapse with the unified localpart logic (see PR #13 — there's an open hardening PR `fix/p1-2-unify-localpart` you should NOT auto-merge but should be aware of).
> - Send the registration with a **forged** Pro token → 401.
> - Send with a **valid token but already-registered identity** → idempotent 200 or 409, never 500.
> - Trigger the OTP verification flow. Verify the OTP arrives via the configured channel.
> - Set the user's profile (display name, avatar). Verify it persists in Synapse and is queryable via `/_matrix/client/r0/profile/`.
>
> ### 3. Login + tokens
> - Log in with the registered user. Verify the access token works against `_matrix/client/r0/account/whoami`.
> - Login with **wrong password** N times — does Synapse rate-limit? After how many?
> - Try to log in with the registration shared secret directly via `POST /_synapse/admin/v1/register` from outside (not as admin) → must 401/403.
>
> ### 4. Rooms — create, join, message, leave
> - Create a room. Get the room_id. Send a message. Read back via `/messages` API.
> - Invite another user. Join from the invited account. Verify membership both directions.
> - Leave the room. Verify both sides see the leave event.
> - Try to read a room you're not in → 403.
> - Try to send to a room you're not in → 403.
>
> ### 5. Media — upload, fetch, thumbnail
> - `POST /_matrix/media/r0/upload` with an image. Get the mxc:// URI.
> - `GET /_matrix/media/r0/download/<server>/<id>` → returns the file with correct mime type.
> - `GET /_matrix/media/r0/thumbnail/<server>/<id>?width=64&height=64` → returns a thumbnail.
> - Upload a file **larger than configured limit** → clean 413.
> - Upload as user A, try to fetch as user B → does it work? (Matrix media is generally public-by-mxc-id which is fine, but verify it's not inadvertently leaking PII filenames in headers.)
> - Try to upload a file with a malicious mime type / SVG with embedded JS → does the server scrub or reject?
>
> ### 6. Federation — the trickiest part
> - From an external Matrix client (Element web), try to invite a user from `@user:chat.windyword.ai`. Does federation resolve correctly? Check the `.well-known` and SRV record path.
> - From `chat.windyword.ai`, try to join a public room on `matrix.org`. Does federation work outbound?
> - Check Synapse logs for federation errors — handshake failures, dropped events, dead-letter queue.
>
> ### 7. Push notifications — push-gateway
> - Register a push pusher (FCM token) via `/_matrix/client/r0/pushers/set`.
> - Send a message in a room with notifications enabled. Verify the push arrives at the FCM token (use a real Android device or the FCM HTTP API to inspect).
> - Tear down the pusher. Verify no further pushes.
>
> ### 8. Social service — friends, presence, contacts
> - `services/social/routes/` exists. Probe what it exposes — friend requests? Presence sync from Pro identity? Contact import?
> - For each: exercise the happy path, then unauthorized access, then malformed input.
>
> ### 9. Directory service — user/room search
> - Public room directory: `GET /_matrix/client/r0/publicRooms` — returns rooms? Pagination works?
> - User directory search: searches a user that exists, doesn't exist, partial match. **Does it leak users who set themselves to private?**
>
> ### 10. Coturn — voice/video calls
> - Coturn is configured with a shared secret (lockbox). Test that a Matrix call session can ICE-negotiate through it. Use Element web or a WebRTC test page that fetches a TURN credential from chat's `/voip/turnServer` endpoint.
> - Verify Coturn doesn't leak as an open relay (try to use it for non-Matrix traffic — should 401 without valid HMAC credential).
>
> ### 11. Admin endpoints
> - `GET /_synapse/admin/...` from anonymous → 401/403.
> - Log in as the seeded admin. List users. Find the test user from §2. Deactivate. Re-activate.
> - **Screenshot every admin page you touch.** Note any 500, blank state, broken HTML.
>
> ### 12. CORS, headers, TLS
> - OPTIONS from disallowed origin → no `*`.
> - HSTS, X-Content-Type-Options, X-Frame-Options, CSP all present.
> - SSL Labs grade ≥ A.
> - Federation port (8448 or wherever) — does it have a separate cert? Is the cert valid?
>
> ### 13. Cross-service contract
> - When Pro fans `user.created` to chat (if it does — check the deployed wiring), does chat auto-provision the matching Matrix account?
> - When user deletes their Pro account, does chat clean up the matching Matrix account or leave a dangling user?
>
> ### 14. Production observability
> - Tail Synapse logs and microservice logs. ERROR/WARN must be explainable.
> - Postgres: connection pool, slow queries, replication lag if any.
> - Synapse `/metrics` if exposed — request rate, federation queue depth, dead letter count.
>
> ---
>
> **Output format:** Single Markdown report at `windy-chat/docs/SMOKE_REPORT_<YYYY-MM-DD>.md`. One H2 per section. Bug format: `**SEVERITY** — title — observed vs expected — repro — fix or "needs investigation"`. Severity: P0 = federation auth bypass / open relay / cross-tenant leak / accepts forged Pro token, P1 = breaks chat for a user, P2 = ugly nonfatal, P3 = polish.
>
> **What "done" looks like:** zero P0, zero P1.
>
> **Constraints:**
> - Test the deployed URL.
> - Don't fix yet — discovery first.
> - Per branching policy: feature branch + PR. Admin merge if CI broken.
> - **1 OPEN Apr 17 hardening PR** (#13 fix/p1-2-unify-localpart) — DON'T touch; queued for Grant.
> - Federation tests can leak data to other Matrix servers — only use disposable test accounts, don't expose Grant's real identity.
