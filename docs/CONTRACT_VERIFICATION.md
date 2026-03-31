# Ecosystem Contract Verification

> Verifies every integration listed in ECOSYSTEM_CONTRACT.md against actual code.
> Audit date: 2026-03-31

---

## Endpoints Chat CALLS (outbound)

### POST /api/v1/auth/chat-validate

| Check | Status | Evidence |
|-------|--------|---------|
| Code calls this endpoint | **VERIFIED** | `deploy/synapse/windy_registration.py:174` — constructs URL from `windy_account_server` config |
| Request format matches contract | **VERIFIED** | Sends `{"user": username, "password": password}` — matches contract spec |
| Does NOT send `shared_secret` in body | **VERIFIED** | Removed in earlier fix; only `user` and `password` fields |
| Handles 401 (bad credentials) | **VERIFIED** | `windy_registration.py:197-199` — logs info, returns None |
| Handles 500 (server error) | **VERIFIED** | `windy_registration.py:200-205` — logs error, returns None |
| Handles network timeout | **VERIFIED** | `windy_registration.py:206-209` — catches `socket.timeout`, logs error |
| Handles unreachable server | **VERIFIED** | `windy_registration.py:210-214` — catches `URLError`, logs error |
| Response parsing: {windy_user_id, display_name, avatar_url} | **VERIFIED** | `windy_registration.py:183-189` — extracts all three fields |
| Remote endpoint exists | **NOT_IMPLEMENTED** | Account-server endpoint not yet built |

### POST /api/v1/identity/chat/provision

| Check | Status | Evidence |
|-------|--------|---------|
| Code calls this endpoint | **VERIFIED** | `services/onboarding/routes/provision.js` calls Synapse admin API directly (not via account-server) |
| Request format matches | **MISMATCH** | Provision calls Synapse `/_synapse/admin/v1/register` directly, NOT the account-server endpoint listed in contract |
| Remote endpoint exists | **NOT_IMPLEMENTED** | Account-server endpoint not yet built |

**Note:** The contract describes the ideal flow (client → account-server → Synapse). Current implementation shortcuts this: client → onboarding → Synapse admin API directly. This works for now but should be updated when account-server integration is complete.

### GET /api/v1/identity/me

| Check | Status | Evidence |
|-------|--------|---------|
| Code calls this endpoint | **NOT_IMPLEMENTED** | No service currently calls this endpoint |
| Remote endpoint exists | **NOT_IMPLEMENTED** | Account-server endpoint not yet built |

**Note:** Services rely on JWT payload for identity, not a round-trip to `/identity/me`. This is acceptable — the JWT contains all needed fields (`sub`, `windy_identity_id`, `email`, `display_name`).

### GET /.well-known/jwks.json

| Check | Status | Evidence |
|-------|--------|---------|
| Code fetches JWKS | **VERIFIED** | `services/shared/jwt-verify.js:9-15` — jwks-rsa client configured with `ACCOUNT_SERVER_URL/.well-known/jwks.json` |
| RS256 verification | **VERIFIED** | `jwt-verify.js:35-38` — verifies RS256 tokens via JWKS public key |
| 1-hour cache | **VERIFIED** | `jwt-verify.js:12` — `cacheMaxAge: 60 * 60 * 1000` |
| HS256 fallback | **VERIFIED** | `jwt-verify.js:39-41` — falls back to `WINDY_JWT_SECRET` on JWKS fetch failure |
| Contract test exists | **VERIFIED** | `tests/integration/test_jwks_contract.js` — 7 tests with mock JWKS server |
| Remote endpoint exists | **NOT_IMPLEMENTED** | Account-server JWKS endpoint not yet built |

### POST /_synapse/admin/v1/register

| Check | Status | Evidence |
|-------|--------|---------|
| Code calls this endpoint | **VERIFIED** | `services/onboarding/routes/provision.js` — HMAC-SHA1 nonce auth |
| Request format | **VERIFIED** | Follows Synapse admin API spec with nonce + mac |
| Error handling | **VERIFIED** | Returns 502 on Synapse unreachable |

---

## Webhooks Chat RECEIVES (inbound)

### POST /api/v1/social/eternitas/webhook

| Check | Status | Evidence |
|-------|--------|---------|
| Endpoint exists | **VERIFIED** | `services/social/server.js:99` |
| Payload format: {event, passport, bot_name, operator_id, reason, timestamp, signature} | **VERIFIED** | All fields extracted from `req.body` |
| HMAC-SHA256 verification | **VERIFIED** | `verifyEternitasSignature()` using `x-eternitas-signature` header |
| Timing-safe comparison | **VERIFIED** | Uses `crypto.timingSafeEqual()` |
| Dev mode bypass | **VERIFIED** | Skips verification when `ETERNITAS_WEBHOOK_SECRET` not set |
| passport.revoked → account_deactivated | **VERIFIED** | Removes from verified set |
| passport.suspended → account_locked | **VERIFIED** | Removes from verified set |
| passport.reinstated → account_reactivated | **VERIFIED** | Adds to verified set |
| Contract test exists | **VERIFIED** | `tests/integration/test_eternitas_webhook_contract.js` — 9 tests |
| Invalid event type → 400 | **VERIFIED** | Checked against `['passport.revoked', 'passport.suspended', 'passport.reinstated']` |

### POST/DELETE /api/v1/social/eternitas/verify

| Check | Status | Evidence |
|-------|--------|---------|
| POST endpoint exists | **VERIFIED** | `services/social/server.js:78` |
| DELETE endpoint exists | **VERIFIED** | `services/social/server.js:88` |
| Requires service token auth | **VERIFIED** | Uses `serviceAuth` middleware |
| Toggles local verified set | **VERIFIED** | `verifiedAccounts.add()`/`.delete()` — no external call |
| Persists to SQLite | **VERIFIED** | `persistVerified()` called after each change |

### POST /_matrix/push/v1/notify

| Check | Status | Evidence |
|-------|--------|---------|
| Endpoint exists | **VERIFIED** | `services/push-gateway/server.js` |
| No auth (server-to-server) | **VERIFIED** | No middleware on this route |
| Privacy: no content in push | **VERIFIED** | Push body is always "New message" |
| Mute respect | **VERIFIED** | Checks `muted_until` before sending |
| Returns `{rejected: []}` | **VERIFIED** | Standard Matrix push gateway response |

---

## Cross-Product Identity

### windy_identity_id propagation

| Service | Stored | Source | Status |
|---------|--------|--------|--------|
| Onboarding | `user_profiles.windy_identity_id` | `req.user.windy_identity_id` | **VERIFIED** |
| Directory | `user_directory.windy_identity_id` | `req.user.windy_identity_id` | **VERIFIED** |
| Social | `posts.windy_identity_id` | `req.user.windy_identity_id` | **VERIFIED** |
| Backup | `backup_registry.windy_identity_id` | `req.user.windy_identity_id` | **VERIFIED** |
| Translation | `user_preferences.windy_identity_id` | `req.user.windy_identity_id` | **VERIFIED** |
| Media | `media.windy_identity_id` | `req.user.windy_identity_id` | **VERIFIED** |
| Call History | `call_log.caller_windy_identity_id` | `req.user.windy_identity_id` | **VERIFIED** |

### JWT payload structure

| Field | Expected | Status |
|-------|----------|--------|
| `sub` | Chat user ID | **VERIFIED** — all services use `req.user.sub` |
| `windy_identity_id` | UUID | **VERIFIED** — stored in all databases |
| Algorithm: RS256 (prod) / HS256 (dev) | Both supported | **VERIFIED** — jwt-verify.js handles both |

---

## Summary

| Integration | Direction | Contract Status |
|-------------|-----------|----------------|
| POST /api/v1/auth/chat-validate | Chat → Pro | **VERIFIED** (code correct; remote not built) |
| POST /api/v1/identity/chat/provision | Chat → Pro | **MISMATCH** (code calls Synapse directly, not via account-server) |
| GET /api/v1/identity/me | Chat → Pro | **NOT_IMPLEMENTED** (JWT used instead) |
| GET /.well-known/jwks.json | Chat → Pro | **VERIFIED** (code correct; remote not built) |
| POST /_synapse/admin/v1/register | Chat → Synapse | **VERIFIED** |
| POST /api/v1/social/eternitas/webhook | Eternitas → Chat | **VERIFIED** |
| POST/DELETE /api/v1/social/eternitas/verify | Pro → Chat | **VERIFIED** |
| POST /_matrix/push/v1/notify | Synapse → Chat | **VERIFIED** |
| windy_identity_id propagation | All services | **VERIFIED** |

**Critical finding:** The provision endpoint calls Synapse admin API directly instead of going through the account-server as the contract specifies. This is a known shortcut that should be addressed when the account-server is built.
