# API Contract: windy-chat <-> windy-pro Integration

> Canonical reference for how the Windy Chat backend (`windy-chat`) integrates with the
> Windy Pro account-server (`windy-pro`). All services in this repo delegate identity to
> the account-server -- windy-chat has **no user database**.

---

## Table of Contents

- [Auth Model](#auth-model)
- [Part 1: Endpoints This Repo CALLS on windy-pro](#part-1-endpoints-this-repo-calls-on-windy-pro)
  - [POST /api/v1/identity/chat/provision](#post-apiv1identitychatprovision)
  - [GET /api/v1/identity/me](#get-apiv1identityme)
  - [POST /api/v1/identity/eternitas/webhook](#post-apiv1identityeternitaswebhook)
- [Part 2: Endpoints This Repo EXPOSES](#part-2-endpoints-this-repo-exposes)
  - [Onboarding Service (port 8101)](#onboarding-service-port-8101)
  - [Directory Service (port 8102)](#directory-service-port-8102)
  - [Push Gateway (port 8103)](#push-gateway-port-8103)
  - [Backup Service (port 8104)](#backup-service-port-8104)
- [Environment Variables](#environment-variables)

---

## Auth Model

All inter-service communication uses one of two auth mechanisms:

| Mechanism | Header | When Used |
|-----------|--------|-----------|
| **User JWT** | `Authorization: Bearer <jwt>` | Client requests on behalf of a logged-in user |
| **Service Token** | `Authorization: Bearer <CHAT_API_TOKEN>` | Server-to-server calls between windy-pro and windy-chat |

**JWT details:**
- Algorithm: HS256
- Issuer: windy-pro account-server
- Shared secret: `WINDY_JWT_SECRET` (must match across both repos)
- Decoded payload is set to `req.user` by the auth middleware

**Service token details:**
- Static shared secret: `CHAT_API_TOKEN` env var
- When matched, `req.user` is set to `{ sub: "service", role: "service" }`

**Auth middleware location:** `services/shared/jwt-verify.js`

---

## Part 1: Endpoints This Repo CALLS on windy-pro

Base URL: `WINDY_ACCOUNT_SERVER_URL` (default: `http://localhost:8098`)

These endpoints live in the windy-pro account-server. The windy-chat backend calls them
during onboarding and identity operations.

---

### POST /api/v1/identity/chat/provision

**Purpose:** Creates a Matrix account for a Windy user. Called by the onboarding service
after phone/email verification and profile setup are complete.

**Called by:** Onboarding service (K2) during `POST /api/v1/chat/provision`

**Auth:** Service token (`Authorization: Bearer <CHAT_API_TOKEN>`)

**Request:**

```json
{
  "windy_identity_id": "string (UUID)",
  "display_name": "string",
  "avatar_url": "string | null"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `windy_identity_id` | string (UUID) | yes | The user's canonical identity from account-server |
| `display_name` | string | yes | User's chosen display name (2-64 chars) |
| `avatar_url` | string \| null | no | URL to user's avatar image |

**Response (201 Created):**

```json
{
  "matrix_user_id": "@windy_<localpart>:chat.windychat.ai",
  "access_token": "string",
  "device_id": "string",
  "home_server": "chat.windychat.ai"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `matrix_user_id` | string | Full Matrix user ID on chat.windychat.ai |
| `access_token` | string | Matrix access token for the client |
| `device_id` | string | Matrix device ID |
| `home_server` | string | Homeserver domain |

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "missing_fields" }` | Required fields not provided |
| 401 | `{ "error": "unauthorized" }` | Invalid or missing service token |
| 409 | `{ "error": "already_provisioned" }` | Matrix account already exists for this identity |
| 500 | `{ "error": "provision_failed" }` | Synapse admin API call failed |

**Flow:**

```
windy-chat onboarding                      windy-pro account-server
         |                                          |
         |  POST /api/v1/identity/chat/provision     |
         |  Authorization: Bearer <CHAT_API_TOKEN>   |
         | ----------------------------------------> |
         |                                          |
         |                            Calls Synapse Admin API
         |                            /_synapse/admin/v1/register
         |                            (shared-secret HMAC auth)
         |                                          |
         |  201 { matrix_user_id, access_token, ... }|
         | <---------------------------------------- |
```

---

### GET /api/v1/identity/me

**Purpose:** Validates a user JWT and returns their canonical identity. Used by chat
services to resolve "who is this user?" from a JWT.

**Called by:** All chat services during auth validation and identity lookups.

**Auth:** User JWT (`Authorization: Bearer <jwt>`)

**Request:** No body. Auth header only.

**Response (200 OK):**

```json
{
  "windy_identity_id": "string (UUID)",
  "email": "string | null",
  "phone": "string | null",
  "display_name": "string",
  "avatar_url": "string | null",
  "created_at": "ISO8601",
  "chat_provisioned": true,
  "matrix_user_id": "@windy_<localpart>:chat.windychat.ai | null"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `windy_identity_id` | string (UUID) | Canonical user ID across all Windy services |
| `email` | string \| null | User's registered email |
| `phone` | string \| null | User's phone in E.164 format |
| `display_name` | string | User's display name |
| `avatar_url` | string \| null | Avatar URL |
| `created_at` | string (ISO8601) | Account creation timestamp |
| `chat_provisioned` | boolean | Whether a Matrix account exists |
| `matrix_user_id` | string \| null | Matrix user ID if provisioned |

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "error": "invalid_token" }` | JWT expired, malformed, or signature mismatch |
| 404 | `{ "error": "user_not_found" }` | JWT valid but user deleted from account-server |

---

### POST /api/v1/identity/eternitas/webhook

**Purpose:** Receives bot passport lifecycle events from the Eternitas registry. When a
bot passport is revoked or suspended, the chat backend suspends the corresponding Matrix
account.

**Called by:** Eternitas registry (via windy-pro as relay) or windy-pro directly.

**Auth:** Service token (`Authorization: Bearer <CHAT_API_TOKEN>`)

**Request:**

```json
{
  "event": "passport.revoked | passport.suspended | passport.reinstated",
  "bot_id": "string (UUID)",
  "passport_id": "string (UUID)",
  "matrix_user_id": "@bot_<localpart>:chat.windychat.ai | null",
  "reason": "string",
  "timestamp": "ISO8601"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | yes | Lifecycle event type |
| `bot_id` | string (UUID) | yes | Eternitas bot identifier |
| `passport_id` | string (UUID) | yes | Eternitas passport identifier |
| `matrix_user_id` | string \| null | no | Matrix user ID of the bot (if known) |
| `reason` | string | yes | Human-readable reason for the action |
| `timestamp` | string (ISO8601) | yes | When the event occurred |

**Event Types:**

| Event | Action Taken |
|-------|-------------|
| `passport.revoked` | Deactivate Matrix account, remove from directory |
| `passport.suspended` | Lock Matrix account (prevent sending), flag in directory |
| `passport.reinstated` | Reactivate Matrix account, restore directory listing |

**Response (200 OK):**

```json
{
  "acknowledged": true,
  "action_taken": "account_deactivated | account_locked | account_reactivated",
  "matrix_user_id": "string"
}
```

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "invalid_event" }` | Unknown event type or missing fields |
| 401 | `{ "error": "unauthorized" }` | Invalid service token |
| 404 | `{ "error": "bot_not_found" }` | No Matrix account for this bot_id |

---

## Part 2: Endpoints This Repo EXPOSES

These endpoints are implemented in windy-chat and called by clients (desktop/mobile apps)
or by windy-pro and other Windy services.

---

### Onboarding Service (port 8101)

**Base path:** `/api/v1/chat`
**Rate limit:** 100 req/min global

#### POST /api/v1/chat/verify/send

Send a 6-digit OTP via SMS or email.

**Auth:** User JWT or service token
**Rate limit:** 5/min, 5/hour

**Request:**

```json
{
  "type": "phone | email",
  "identifier": "string",
  "countryCode": "string (optional, e.g. 'US')"
}
```

**Response (200):**

```json
{
  "success": true,
  "type": "phone | email",
  "identifier": "+1***5678 | g***@example.com",
  "expiresInSeconds": 600
}
```

**Errors:** 400 (invalid identifier), 429 (rate limited / cooldown active)

---

#### POST /api/v1/chat/verify/check

Validate OTP and receive a verification token.

**Auth:** User JWT or service token

**Request:**

```json
{
  "identifier": "string",
  "code": "string (6 digits)",
  "type": "phone | email (optional)",
  "countryCode": "string (optional)"
}
```

**Response (200):**

```json
{
  "success": true,
  "verified": true,
  "verificationToken": "UUID",
  "identifier": "string",
  "type": "phone | email"
}
```

**Errors:** 400 (wrong code / max attempts), 429 (rate limited)

---

#### GET /api/v1/chat/verify/status

Check if an identifier has been verified.

**Auth:** User JWT or service token

**Query:** `?identifier=<phone_or_email>`

**Response (200):**

```json
{
  "identifier": "string",
  "verified": true,
  "verifiedAt": "ISO8601 | null",
  "type": "phone | email"
}
```

---

#### GET /api/v1/chat/profile/check-name

Check display name availability.

**Auth:** User JWT or service token

**Query:** `?name=<display_name>`

**Response (200):**

```json
{
  "name": "string",
  "available": true,
  "suggestions": ["Name W", "Name 2", "name_variant"]
}
```

---

#### POST /api/v1/chat/profile/setup

Create user profile with display name, languages, and avatar.

**Auth:** User JWT or service token

**Request:**

```json
{
  "verificationToken": "UUID",
  "displayName": "string (2-64 chars)",
  "languages": ["en", "es"],
  "avatarUrl": "string | null"
}
```

**Response (201):**

```json
{
  "success": true,
  "profile": {
    "chatUserId": "windy_<12chars>",
    "displayName": "string",
    "languages": ["en", "es"],
    "primaryLanguage": "en",
    "avatarUrl": "string | null",
    "createdAt": "ISO8601",
    "onboardingComplete": false
  },
  "nextStep": "provision"
}
```

**Errors:** 400 (profanity / invalid name), 409 (name taken)

---

#### GET /api/v1/chat/profile/:userId

Get a user profile by ID.

**Auth:** User JWT or service token

**Response (200):**

```json
{
  "profile": {
    "chatUserId": "string",
    "displayName": "string",
    "languages": ["string"],
    "primaryLanguage": "string",
    "avatarUrl": "string | null",
    "createdAt": "ISO8601",
    "onboardingComplete": true
  }
}
```

**Errors:** 404 (user not found)

---

#### POST /api/v1/chat/pair/generate

Generate a QR pairing session (called by desktop client).

**Auth:** User JWT or service token
**Rate limit:** 10/min

**Request:** Empty body.

**Response (200):**

```json
{
  "sessionId": "UUID",
  "qrPayload": {
    "session": "UUID",
    "pubkey": "base64 (X25519)",
    "ts": "timestamp",
    "server": "https://chat.windychat.ai",
    "version": 1
  },
  "qrDataString": "JSON string (for QR encoding)",
  "expiresAt": "ISO8601",
  "ttlSeconds": 120
}
```

---

#### POST /api/v1/chat/pair/confirm

Confirm QR pairing (called by mobile after scanning).

**Auth:** User JWT or service token

**Request:**

```json
{
  "sessionId": "UUID",
  "authToken": "string",
  "userId": "string",
  "displayName": "string (optional)",
  "deviceName": "string (optional)",
  "platform": "desktop | mobile | web (optional)"
}
```

**Response (200):**

```json
{
  "success": true,
  "paired": true,
  "deviceId": "string",
  "message": "string"
}
```

**Errors:** 400 (invalid session), 404 (session expired), 409 (already paired)

---

#### GET /api/v1/chat/pair/status/:sessionId

Poll pairing status (called by desktop).

**Auth:** User JWT or service token

**Response (200):**

```json
{
  "sessionId": "UUID",
  "status": "pending | paired | expired",
  "expiresAt": "ISO8601",
  "linkedAccount": {
    "userId": "string",
    "displayName": "string",
    "deviceId": "string"
  }
}
```

`linkedAccount` is only present when `status` is `"paired"`.

---

#### DELETE /api/v1/chat/pair/session/:sessionId

Cancel a pairing session.

**Auth:** User JWT or service token

**Response (200):**

```json
{
  "success": true,
  "message": "Session cancelled"
}
```

---

#### POST /api/v1/chat/provision

Provision a Matrix account via Synapse admin API.

**Auth:** User JWT or service token
**Rate limit:** 10/min

**Request:**

```json
{
  "chatUserId": "string",
  "displayName": "string",
  "verificationToken": "UUID"
}
```

**Response (201):**

```json
{
  "success": true,
  "matrix": {
    "matrixUserId": "@windy_<localpart>:chat.windychat.ai",
    "accessToken": "string",
    "deviceId": "string",
    "homeServer": "chat.windychat.ai"
  },
  "onboarding": {
    "complete": true,
    "provisionedAt": "ISO8601"
  }
}
```

**Errors:** 400 (missing fields / invalid token), 409 (already provisioned), 500 (Synapse unreachable)

---

#### GET /api/v1/chat/onboarding/status

Check onboarding completion state.

**Auth:** User JWT or service token

**Query:** `?chatUserId=<id>`

**Response (200):**

```json
{
  "chatUserId": "string",
  "complete": true,
  "matrixUserId": "@windy_<localpart>:chat.windychat.ai",
  "steps": {
    "verified": true,
    "profileCreated": true,
    "matrixProvisioned": true
  },
  "provisionedAt": "ISO8601"
}
```

When incomplete, `nextStep` is included: `"verify"`, `"profile"`, or `"provision"`.

---

### Directory Service (port 8102)

**Base path:** `/api/v1/chat/directory`
**Rate limit:** 60 req/min global

#### GET /api/v1/chat/directory/salt

Get the current hashing salt for contact discovery.

**Auth:** User JWT or service token

**Response (200):**

```json
{
  "salt": "hex (32 bytes)",
  "createdAt": "ISO8601",
  "rotatesAt": "ISO8601",
  "algorithm": "SHA256",
  "usage": "Hash phone numbers as SHA256(E164_number + salt) before lookup"
}
```

---

#### POST /api/v1/chat/directory/lookup

Batch hash-based contact lookup (Signal-style privacy).

**Auth:** User JWT or service token
**Rate limit:** 10/min per user

**Request:**

```json
{
  "hashes": ["SHA256 hex string", "..."]
}
```

Max 1000 hashes per request.

**Response (200):**

```json
{
  "submitted": 500,
  "matches": [
    {
      "hash": "SHA256 hex",
      "userId": "string",
      "displayName": "string",
      "avatarUrl": "string | null"
    }
  ],
  "matchCount": 12
}
```

---

#### POST /api/v1/chat/directory/register-hash

Register a user's hashed phone/email for contact discovery.

**Auth:** User JWT or service token

**Request:**

```json
{
  "userId": "string",
  "displayName": "string",
  "avatarUrl": "string | null",
  "identifierHash": "SHA256 hex (single)",
  "identifiers": ["raw identifiers (hashed server-side, alternative)"]
}
```

Provide either `identifierHash` (pre-hashed) or `identifiers` (server hashes them).

**Response (200):**

```json
{
  "success": true,
  "registeredCount": 1,
  "message": "Hash(es) registered"
}
```

---

#### GET /api/v1/chat/directory/stats

Directory statistics.

**Auth:** User JWT or service token

**Response (200):**

```json
{
  "totalHashes": 42000,
  "saltAge": "2d 5h",
  "nextRotation": "ISO8601"
}
```

---

#### POST /api/v1/chat/directory/register

Register a user in the searchable directory.

**Auth:** User JWT or service token

**Request:**

```json
{
  "userId": "string",
  "displayName": "string",
  "email": "string (optional)",
  "phone": "string (optional)",
  "languages": ["en", "es"],
  "avatarUrl": "string | null",
  "searchable": true
}
```

**Response (200):**

```json
{
  "success": true,
  "userId": "string",
  "searchable": true
}
```

---

#### GET /api/v1/chat/directory/search

Fuzzy search by name, exact match by email or phone.

**Auth:** User JWT or service token
**Rate limit:** 30/min

**Query:** `?q=<search_term>` (min 2 characters)

**Response (200):**

```json
{
  "query": "Grant",
  "results": [
    {
      "userId": "string",
      "displayName": "Grant Whitmer",
      "avatarUrl": "string | null",
      "languages": ["en"],
      "matchType": "name | email | phone"
    }
  ],
  "count": 3,
  "totalMatches": 3,
  "truncated": false
}
```

Max 20 results. Sorted by relevance score then alphabetically.

---

#### POST /api/v1/chat/directory/invite

Send an SMS/email invite to someone not on Windy Chat.

**Auth:** User JWT or service token
**Rate limit:** 5/min, 20/day per user

**Request:**

```json
{
  "fromUserId": "string",
  "fromDisplayName": "string (optional)",
  "type": "sms | email",
  "identifier": "string (phone E.164 or email)"
}
```

**Response (200):**

```json
{
  "success": true,
  "type": "sms | email",
  "identifier": "string (redacted)",
  "referralCode": "string (8 chars)",
  "deepLink": "https://windyword.ai/chat/join?ref=<code>",
  "invitesRemaining": 15
}
```

**Errors:** 400 (invalid identifier), 429 (daily limit reached)

---

### Push Gateway (port 8103)

**Base path:** `/api/v1/chat/push` (client) + `/_matrix/push/v1` (Synapse)
**Rate limit:** 100 req/min global

#### POST /_matrix/push/v1/notify

**Matrix push notification endpoint. Called by Synapse, NOT by clients.**

**Auth:** None (server-to-server, Synapse calls this directly)

**Request (from Synapse):**

```json
{
  "notification": {
    "room_id": "!abc:chat.windychat.ai",
    "event_id": "$xyz",
    "sender": "@windy_alice:chat.windychat.ai",
    "sender_display_name": "Alice",
    "type": "m.room.message",
    "prio": "high",
    "content": {
      "msgtype": "m.text",
      "body": "Hello!"
    },
    "devices": [
      {
        "pushkey": "FCM-or-APNs-token",
        "app_id": "com.windypro.chat.android"
      }
    ],
    "counts": {
      "unread": 3
    }
  }
}
```

**Privacy:** The push notification sent to the device contains `"New message"` as the body.
Message content is **never** included in push payloads.

**Response (200):**

```json
{
  "rejected": ["pushkey-if-invalid"]
}
```

`rejected` is an array of pushkeys that should be unregistered (token expired, etc.).

---

#### POST /api/v1/chat/push/register

Register a device push token.

**Auth:** User JWT or service token
**Rate limit:** 10/min

**Request:**

```json
{
  "pushkey": "string (FCM or APNs token)",
  "userId": "string",
  "platform": "android | ios | web",
  "appId": "string (optional, e.g. 'com.windypro.chat.ios')",
  "deviceName": "string (optional)"
}
```

**Response (200):**

```json
{
  "success": true
}
```

---

#### POST /api/v1/chat/push/mute

Mute notifications for a conversation.

**Auth:** User JWT or service token

**Request:**

```json
{
  "userId": "string",
  "roomId": "!abc:chat.windychat.ai",
  "duration": "1h | 8h | 1d | 1w | forever (default: 1d)",
  "mentionOverride": true
}
```

When `mentionOverride` is `true`, @mentions still generate notifications.

**Response (200):**

```json
{
  "success": true,
  "mutedUntil": "ISO8601"
}
```

---

#### POST /api/v1/chat/push/unmute

Unmute a conversation.

**Auth:** User JWT or service token

**Request:**

```json
{
  "userId": "string",
  "roomId": "!abc:chat.windychat.ai"
}
```

**Response (200):**

```json
{
  "success": true
}
```

---

### Backup Service (port 8104)

**Base path:** `/api/v1/chat/backup`
**Rate limit:** 60 req/min global

All backup data is encrypted client-side with AES-256-GCM before upload.
The server has **zero knowledge** of backup contents.

**Encryption spec:**
- Key derivation: PBKDF2 (100,000 iterations, SHA-512)
- Cipher: AES-256-GCM (authenticated encryption)
- Format: `salt(32 bytes) + iv(12 bytes) + authTag(16 bytes) + ciphertext`
- Storage: Cloudflare R2 (S3-compatible) at `backups/{userId}/{timestamp}.enc`

#### POST /api/v1/chat/backup/create

Upload an encrypted backup.

**Auth:** User JWT or service token

**Request:**

```json
{
  "userId": "string",
  "encryptedData": "base64-encoded encrypted blob",
  "metadata": {
    "messageCount": 1500,
    "roomCount": 12,
    "clientVersion": "1.2.0"
  }
}
```

`metadata` is optional and stored unencrypted (never include PII).

**Response (201):**

```json
{
  "success": true,
  "backupId": "UUID",
  "timestamp": "ISO8601",
  "size": 204800,
  "path": "backups/<userId>/<timestamp>.enc"
}
```

**Retention:** Max 7 backups per user. Oldest is auto-deleted when limit is exceeded.

---

#### GET /api/v1/chat/backup/list

List a user's backups.

**Auth:** User JWT or service token

**Query:** `?userId=<id>`

**Response (200):**

```json
{
  "userId": "string",
  "backups": [
    {
      "id": "UUID",
      "timestamp": "ISO8601",
      "size": 204800,
      "sizeFormatted": "200 KB",
      "metadata": { "messageCount": 1500 }
    }
  ],
  "count": 3,
  "maxBackups": 7
}
```

---

#### POST /api/v1/chat/backup/restore

Download an encrypted backup.

**Auth:** User JWT or service token

**Request:**

```json
{
  "userId": "string",
  "backupId": "UUID"
}
```

**Response (200):**

```json
{
  "success": true,
  "backupId": "UUID",
  "timestamp": "ISO8601",
  "size": 204800,
  "encryptedData": "base64-encoded encrypted blob"
}
```

**Errors:** 404 (backup not found)

---

#### DELETE /api/v1/chat/backup/delete

Delete a specific backup.

**Auth:** User JWT or service token

**Request:**

```json
{
  "userId": "string",
  "backupId": "UUID"
}
```

**Response (200):**

```json
{
  "success": true,
  "deleted": "UUID"
}
```

**Errors:** 404 (backup not found)

---

## Environment Variables

These variables control the integration between repos. Both sides must agree on shared secrets.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WINDY_ACCOUNT_SERVER_URL` | yes | `http://localhost:8098` | windy-pro account-server base URL |
| `WINDY_JWT_SECRET` | yes | `dev-secret-change-me` | Shared JWT signing secret (must match account-server) |
| `CHAT_API_TOKEN` | yes | (none) | Static token for service-to-service auth |
| `SYNAPSE_REGISTRATION_SECRET` | yes | `windy_dev_reg_secret` | Shared secret for Synapse admin API registration |
| `SYNAPSE_ADMIN_TOKEN` | no | (none) | Synapse admin access token (alternative to shared secret) |
| `REDIS_URL` | no | `redis://localhost:6379` | Redis for OTP store, rate limiting, sessions |
