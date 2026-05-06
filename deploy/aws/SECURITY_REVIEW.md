# Windy Chat — Production Security Review

Pre-launch audit for the v1 AWS deployment. Every item is either
**VERIFIED** (tested end-to-end, safe to ship), **ACCEPTED RISK** (known,
consciously deferred), or **BLOCKING** (must be resolved before launch).

No BLOCKING items at the time of this review. Two ACCEPTED RISKS are
queued for Wave 7.

## Identity & authentication

### VERIFIED — Matrix registration is locked to Windy Pro

- `homeserver.yaml` has `enable_registration: false` and
  `enable_registration_without_verification: false`.
- The custom `windy_registration.WindyRegistrationModule` (at
  `deploy/synapse/windy_registration.py`) is the only account-creation
  path — it validates credentials against the Windy Pro account-server's
  `/api/v1/auth/chat-validate` endpoint before minting a Matrix account.
- Direct Matrix `/register` returns 403 at the homeserver level; the ALB
  additionally holds a WAF rule blocking the path from outside the
  VPC-internal CIDR.

### VERIFIED — JWT validation via Windy Pro JWKS

- `services/shared/jwt-verify.js` pulls keys from
  `https://windyword.ai/.well-known/jwks.json` and caches
  with ETag/refresh.
- RS256 verified against published keys; HS256 fallback uses
  `WINDY_JWT_SECRET` (kept in Secrets Manager).
- Bot callers present an EPT (Eternitas Platform Token) — `passport_id`
  claim is what triggers trust-gate enforcement downstream.

## Trust gating

### VERIFIED — Gates enforce live Trust API

- Gates in `services/directory/routes/agents.js` check `status=='active'`,
  `band !== 'critical'`, and the concrete `allowed_actions` list from the
  live Trust API (not a mock).
- Contract ref: `eternitas/docs/trust-api.md`. Client:
  `services/shared/trust-client.js`. Cache: 5 min Redis + in-memory
  fallback.
- **Live-band proof**: all 13 assertions in
  `tests/integration/test_trust_live_bands.js` pass against real
  Eternitas at `localhost:8500` — EXCP/GOOD/FAIR/POOR/REVD behave per
  the contract.
- **Stand-in proof**: `tests/integration/test_trust_live.js` exercises
  exceptional→max-privileges, critical→blocked, suspended→flush,
  revoked→flush, human→skip. 6/6 scenarios pass over real HTTP; 2 live
  probes additionally pass when Eternitas is reachable.

### VERIFIED — Cache invalidation on band flip / revocation

- `POST /api/v1/webhooks/passport/revoked` deactivates the Matrix account
  AND flushes `windy:chat:trust:{passport}`. Response includes
  `trust_cache_flushed: true|false` so Eternitas can observe the flush.
- `POST /api/v1/webhooks/trust/changed` is a pure cache-flush endpoint
  (no Matrix side effects) for band/clearance changes short of full
  revocation.
- Regression tests: `services/onboarding/tests/webhooks.test.js` covers
  cached→flushed→null round-trip for both endpoints. 20/20 pass.

### VERIFIED — Humans bypass trust calls

- Gates short-circuit on `!req.user?.passport_id` so humans (Pro JWT,
  no passport claim) never hit Eternitas.
- Live test asserts zero upstream GETs for human callers
  (`tests/integration/test_trust_live.js` — "human bypasses" scenario,
  counts stand-in hits before/after).
- Avoids a trivial DoS vector where human login could amplify Eternitas
  load via the 100 req/min/IP rate limit.

## Webhook integrity

### VERIFIED — HMAC-SHA256 on every webhook path

Every inbound webhook is HMAC-verified against the raw request body
(not re-serialized JSON — the raw bytes are captured in the
`express.json({ verify })` hook):

| Endpoint | Header | Secret |
|---|---|---|
| `/api/v1/webhooks/identity/created` | `X-Windy-Signature` | `WINDY_IDENTITY_WEBHOOK_SECRET` |
| `/api/v1/webhooks/passport/revoked` | `X-Eternitas-Signature` | `ETERNITAS_WEBHOOK_SECRET` |
| `/api/v1/webhooks/trust/changed` | `X-Eternitas-Signature` | `ETERNITAS_WEBHOOK_SECRET` |

- Constant-time comparison via `crypto.timingSafeEqual`.
- Accepts both `sha256=<hex>` (live Eternitas format) and bare `<hex>`
  (legacy producers) — regression tests in
  `services/onboarding/tests/webhooks.test.js` "HMAC signature" suite
  prove both formats verify and wrong-prefix / wrong-hex deny. 5/5
  pass.
- Missing-secret behavior: fail-closed in production
  (`NODE_ENV === 'production'` → 503), warn-and-pass in dev only.

### VERIFIED — Replay resistance

- Every handler is idempotent on its effect — replayed messages don't
  double-provision or double-deactivate:
  - `identity.created` → idempotency via `user_profiles.windy_identity_id`
    lookup; replay returns the existing matrix_user_id with
    `status: 'already_existed'`.
  - `passport.revoked` → Synapse deactivate is idempotent
    (`erase=false`); cache-flush is DEL-based.
  - `trust.changed` → pure DEL.

### ACCEPTED RISK — ES256 dual-signature not yet verified

- Eternitas co-signs every webhook with a detached ES256 JWS via
  `X-Windy-Signature`. We currently only verify the `X-Eternitas-Signature`
  HMAC branch. HMAC alone is cryptographically sufficient (shared-secret,
  timing-safe comparison, raw-body), so this is an additive defense, not
  a gap.
- **Deferred to Wave 7**. Tracking: add JWS verification via the
  `jose` lib we already depend on, keyed off Eternitas's public JWKS.
  Either signature verifying is sufficient (OR semantics).

## Synapse hardening

### VERIFIED — Federation disabled end-to-end

- `homeserver.yaml`:
  - `federation_domain_whitelist: []`
  - `allow_public_rooms_over_federation: false`
  - `allow_public_rooms_without_auth: false`
  - `restrict_public_rooms_to_local_users: true`
- ALB has **no listener on port 8448** — the federation port is
  unreachable even if config drifted.
- Security group on Synapse tasks allows ingress only from the ALB SG.

### VERIFIED — Push privacy

- `homeserver.yaml`: `push: include_content: false`.
- `services/push-gateway/server.js` additionally overrides any sender
  content with the constant string `"New message"` before handing off
  to FCM/APNs/WebPush (K6.1.3 invariant).
- Privacy-body invariant is doubly enforced.

### VERIFIED — E2E key backup is zero-knowledge

- `homeserver.yaml`: `enable_room_key_backup: true`.
- Backup is stored encrypted on Synapse — the server never sees plaintext
  keys. Recovery key is derived client-side (PBKDF2 in windy-pro's chat
  client).

## Rate limiting

### VERIFIED — Service-level rate limits

Every service applies a global express-rate-limit middleware (60s window,
per-IP):

| Service | Window max | Per-route overrides |
|---|---|---|
| onboarding | 100 req/min | `/provision`: 10 req/min |
| directory | 60 req/min | `/agents`: 30 req/min |
| push-gateway | 100 req/min | `/register`: 10 req/min |
| backup | 60 req/min | — |

### VERIFIED — Synapse-level rate limits

Tuned for real-time chat in `homeserver.yaml`:

- `rc_message`: 5/sec, burst 20 (per user)
- `rc_registration`: 0.5/sec, burst 3
- `rc_login`: 1/sec per address + per account, burst 5
- `rc_federation`: capped at 50 concurrent

### VERIFIED — Eternitas-side rate limits honored

- Trust-client caches for 5 min keyed on passport (or the shorter
  `cache_ttl_seconds` hint from the response). Eternitas's 100
  req/min/IP ceiling is not a practical concern for a single deployment
  with caching; humans skip the Trust API entirely.

## Secrets & configuration

### VERIFIED — No plaintext secrets in images or task definitions

- All secrets land via ECS task `secrets:` field from AWS Secrets
  Manager. Container images have no embedded credentials (checked via
  `docker history | grep -i "secret\|key\|password"`).
- `.env` files are gitignored; `.env.example` contains only placeholders.
- Task execution role has `secretsmanager:GetSecretValue` narrowed to
  the specific ARNs per service.

### VERIFIED — Signing key lives in Secrets Manager

- `chat.windychat.ai.signing.key` is stored as a binary secret, not a
  plain S3 object.
- See `CHAT_DEPLOYMENT.md` → "Signing-key generation and rotation" for
  the rotation runbook.

## Data & storage

### VERIFIED — Data at rest

- RDS: encryption enabled (`kms_key_id` set), automated backups, Multi-AZ.
- ElastiCache: encryption in transit (TLS, `rediss://`) + at rest.
- ECS task ephemeral storage is sized to 20 GB per task; sensitive data
  never lands there (everything hot is in RDS/ElastiCache).
- S3 (backup storage for Windy Cloud): SSE-KMS, bucket policy blocks
  public access, versioning on.

### VERIFIED — Data in transit

- ACM-issued certs on ALB and CloudFront, TLS 1.2+ only,
  `ELBSecurityPolicy-TLS13-1-2-2021-06` policy.
- Synapse uses Client-Server API over HTTPS (terminated at ALB).
- Inter-service calls inside the VPC are HTTP (trust boundary is the VPC
  edge). This is standard and matches how production Synapse installs
  run — but flagged here for completeness.

## Dependencies & supply chain

### VERIFIED — Dependency audit

- `npm audit` clean on every service package (no high/critical).
- Python deps (Synapse custom modules): pinned via `pyproject.toml` where
  applicable; Synapse itself runs the official `matrixdotorg/synapse`
  image, pinned to a specific minor.
- Dependabot enabled on the repo.

### ACCEPTED RISK — SQLite state in push-gateway

- Device push tokens live in SQLite on local task storage. Multi-task
  push-gateway deployments need ALB sticky cookies on `/register` (see
  `CHAT_DEPLOYMENT.md`). Correct but fragile.
- **Deferred to Wave 7**. Tracking: migrate `push_tokens` to RDS. Small
  table, low write rate.

## Logging & auditability

### VERIFIED — Audit trail

- Synapse emits structured logs for every auth decision and admin API
  call.
- Microservices log JWT `sub` + `passport_id` (if present) on every
  protected request — enough to reconstruct "who did what when" without
  leaking tokens themselves.
- Sentry captures exceptions across all services with user context
  (`sub` only — no PII).

### VERIFIED — No secrets in logs

- `services/shared/jwt-verify.js` never logs token contents.
- Webhook handlers log `passport` (public identifier) but never
  `signature` or `secret`.
- Grep-auditable: `grep -riE "console\.log.*(secret|token|password|key)" services/` returns only false positives in field-name strings.

## Attack surface matrix

| Vector | Defense |
|---|---|
| Direct Matrix registration | Disabled in homeserver.yaml + WAF block |
| Federation abuse | Port 8448 not in ALB; domain whitelist empty |
| Bot impersonation | EPT JWT validated against Eternitas JWKS; trust gates fail-closed |
| Revoked-bot replay | `passport.revoked` webhook flushes trust cache synchronously |
| Webhook forgery | HMAC-SHA256 constant-time compare, raw-body based, `sha256=` prefix-tolerant |
| DoS on trust API | 5-min local cache + humans bypass |
| Push-bus abuse | `X-Push-Bus-Token` shared secret; ALB-local traffic only |
| TURN relay abuse | `turn_allow_guests: false`; shared-secret auth per lifetime window |
| DB credential leak | IAM auth on RDS; rotation via Secrets Manager quarterly |

## Sign-off

Prepared for the v1 launch audit. Ship-ready subject to the two ACCEPTED
RISKS above being tracked for Wave 7:

- **[Wave 7]** ES256 dual-signature verification on webhooks
- **[Wave 7]** Migrate `push_tokens` from SQLite to RDS

Reviewer: — (sign here)
Date: 2026-04-16
