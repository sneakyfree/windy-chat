# Ecosystem Contract: Windy Chat Integration Points

> Every endpoint Chat CALLS on external services, every webhook Chat RECEIVES,
> and the exact request/response formats. Status: IMPLEMENTED vs STUB.

---

## Part 1: Endpoints Chat CALLS

### 1.1 Windy Pro Account Server (`WINDY_ACCOUNT_SERVER_URL`)

Default: `http://localhost:8098`

---

#### POST /api/v1/auth/chat-validate

**Status: STUB** (account-server endpoint not yet confirmed)

**Called by:** Synapse auth module (`deploy/synapse/windy_registration.py`)

**Purpose:** Validate user credentials during Matrix login.

**Auth:** None (server-to-server, trusted network)

**Request:**

```json
{
  "user": "username_or_email",
  "password": "plaintext_password"
}
```

**Response (200):**

```json
{
  "windy_user_id": "uuid",
  "display_name": "Grant Whitmer",
  "avatar_url": "https://cdn.windypro.com/avatars/abc.jpg"
}
```

**Error Responses:**

| Status | Meaning |
|--------|---------|
| 401 | Invalid credentials |
| 500 | Account server internal error |
| Timeout (10s) | Network unreachable |

---

#### POST /api/v1/identity/chat/provision

**Status: STUB** (endpoint defined in API_CONTRACT.md, not yet built on account-server)

**Called by:** Onboarding service (`services/onboarding/routes/provision.js`)

**Purpose:** Create a Matrix account for a verified Windy user.

**Auth:** `Authorization: Bearer <CHAT_API_TOKEN>`

**Request:**

```json
{
  "windy_identity_id": "uuid",
  "display_name": "string (2-64 chars)",
  "avatar_url": "string | null"
}
```

**Response (201):**

```json
{
  "matrix_user_id": "@windy_<localpart>:chat.windypro.com",
  "access_token": "string",
  "device_id": "string",
  "home_server": "chat.windypro.com"
}
```

**Errors:** 400, 401, 409 (already provisioned), 500

---

#### GET /api/v1/identity/me

**Status: STUB** (endpoint defined in API_CONTRACT.md, not yet built on account-server)

**Called by:** All chat services (identity resolution from JWT)

**Auth:** `Authorization: Bearer <user_jwt>`

**Request:** No body.

**Response (200):**

```json
{
  "windy_identity_id": "uuid",
  "email": "string | null",
  "phone": "string | null",
  "display_name": "string",
  "avatar_url": "string | null",
  "created_at": "ISO8601",
  "chat_provisioned": true,
  "matrix_user_id": "@windy_<localpart>:chat.windypro.com | null"
}
```

**Errors:** 401 (invalid token), 404 (user deleted)

---

#### GET /.well-known/jwks.json

**Status: STUB** (JWKS endpoint not yet built on account-server)

**Called by:** JWT middleware (`services/shared/jwt-verify.js`)

**Purpose:** Fetch RS256 public keys for JWT verification.

**Auth:** None (public endpoint)

**Response (200):**

```json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "key-id",
      "use": "sig",
      "alg": "RS256",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

**Fallback:** If unreachable, JWT middleware falls back to HS256 with `WINDY_JWT_SECRET`.

---

### 1.2 Synapse Admin API (internal)

#### POST /_synapse/admin/v1/register

**Status: IMPLEMENTED**

**Called by:** Onboarding service (`services/onboarding/routes/provision.js`)

**Purpose:** Provision Matrix accounts via shared-secret HMAC auth.

**Auth:** HMAC-SHA1 nonce (`SYNAPSE_REGISTRATION_SECRET`)

---

## Part 2: Webhooks Chat RECEIVES

### 2.1 Eternitas Bot Passport Lifecycle

#### POST /api/v1/social/eternitas/webhook

**Status: IMPLEMENTED** (in `services/social/server.js`)

**Called by:** Eternitas registry (via Windy Pro relay) or Windy Pro directly.

**Auth:** `Authorization: Bearer <CHAT_API_TOKEN>`

**Request:**

```json
{
  "event": "passport.revoked | passport.suspended | passport.reinstated",
  "passport": "uuid (passport ID)",
  "bot_name": "string",
  "operator_id": "uuid | null",
  "reason": "string",
  "timestamp": "ISO8601",
  "signature": "HMAC-SHA256 hex (TODO: verification not yet implemented)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | yes | One of: `passport.revoked`, `passport.suspended`, `passport.reinstated` |
| `passport` | string (UUID) | yes | Eternitas passport identifier |
| `bot_name` | string | yes | Human-readable bot name |
| `operator_id` | string (UUID) | no | Operator who triggered the event |
| `reason` | string | no | Reason for the action |
| `timestamp` | string (ISO8601) | yes | When the event occurred |
| `signature` | string | no | HMAC signature (verification TODO) |

**Response (200):**

```json
{
  "acknowledged": true,
  "action_taken": "account_deactivated | account_locked | account_reactivated",
  "bot_user_id": "bot_<passport_id>",
  "event": "string",
  "timestamp": "ISO8601"
}
```

**Errors:** 400 (missing fields / invalid event), 401 (bad service token)

---

### 2.2 Eternitas Verified Badge (simple API)

#### POST /api/v1/social/eternitas/verify

**Status: IMPLEMENTED**

**Auth:** `Authorization: Bearer <CHAT_API_TOKEN>`

**Request:** `{ "userId": "string" }`

**Response:** `{ "verified": true, "userId": "string" }`

#### DELETE /api/v1/social/eternitas/verify

**Status: IMPLEMENTED**

**Auth:** `Authorization: Bearer <CHAT_API_TOKEN>`

**Request:** `{ "userId": "string" }`

**Response:** `{ "verified": false, "userId": "string" }`

---

### 2.3 Matrix Push Notifications (from Synapse)

#### POST /_matrix/push/v1/notify

**Status: IMPLEMENTED** (in `services/push-gateway/server.js`)

**Called by:** Synapse homeserver (not external services)

**Auth:** None (internal server-to-server)

**Request:** Standard Matrix push gateway format (see API_CONTRACT.md)

---

## Part 3: Cross-Product Identity

### windy_identity_id

The `windy_identity_id` field is a UUID that correlates a user across all Windy products (Pro, Chat, Traveler, Eternitas, etc.).

**Source:** Included in JWT payload by the account-server.

**Propagation:**
- Extracted from `req.user.windy_identity_id` after JWT middleware
- Stored in SQLite tables:
  - `user_profiles.windy_identity_id` (onboarding, port 8101)
  - `user_directory.windy_identity_id` (directory, port 8102)
  - `posts.windy_identity_id` (social, port 8105)
  - `backup_registry.windy_identity_id` (backup, port 8104)

### JWT Payload Structure (expected from account-server)

```json
{
  "sub": "chat_user_id",
  "windy_identity_id": "uuid",
  "email": "user@example.com",
  "display_name": "Grant Whitmer",
  "iat": 1234567890,
  "exp": 1234567890
}
```

**Algorithm:** RS256 (production, via JWKS) or HS256 (development, via `WINDY_JWT_SECRET`)

---

## Part 4: Environment Variables

| Variable | Required | Used By | Purpose |
|----------|----------|---------|---------|
| `WINDY_ACCOUNT_SERVER_URL` | yes | All services + Synapse module | Account server base URL |
| `WINDY_JWT_SECRET` | yes | `jwt-verify.js` | HS256 shared secret (dev fallback) |
| `CHAT_API_TOKEN` | yes | `jwt-verify.js` | Service-to-service static token |
| `SYNAPSE_REGISTRATION_SECRET` | yes | Synapse module + onboarding | Synapse admin API shared secret |
| `ETERNITAS_WEBHOOK_SECRET` | no | Social service | HMAC key for webhook signature verification (TODO) |

---

## Summary: Implementation Status

| Integration | Direction | Status |
|-------------|-----------|--------|
| POST /api/v1/auth/chat-validate | Chat -> Pro | **STUB** (endpoint not built on account-server) |
| POST /api/v1/identity/chat/provision | Chat -> Pro | **STUB** (endpoint not built on account-server) |
| GET /api/v1/identity/me | Chat -> Pro | **STUB** (endpoint not built on account-server) |
| GET /.well-known/jwks.json | Chat -> Pro | **STUB** (JWKS not built, using HS256 fallback) |
| POST /_synapse/admin/v1/register | Chat -> Synapse | **IMPLEMENTED** |
| POST /api/v1/social/eternitas/webhook | Eternitas -> Chat | **IMPLEMENTED** (signature verification TODO) |
| POST/DELETE /api/v1/social/eternitas/verify | Pro -> Chat | **IMPLEMENTED** |
| POST /_matrix/push/v1/notify | Synapse -> Chat | **IMPLEMENTED** |
