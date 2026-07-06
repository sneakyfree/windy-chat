# Client Integration Guide

> How to wire windy-pro (desktop) and windy-pro-mobile to the Windy Chat backend.

---

## Quick Start

```bash
# 1. Backend
cd windy-chat
./scripts/setup-credentials.sh   # Generate secrets
./scripts/setup-synapse-dev.sh   # Start Synapse + create test user
./scripts/dev-start.sh           # Start all microservices

# 2. Client
# Set these in your client's .env or config:
CHAT_HOMESERVER_URL=https://chat.windychat.ai   # or http://localhost:8008 for dev
CHAT_API_BASE=http://localhost                   # base for microservice ports
WINDY_JWT_SECRET=<must match backend>
```

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Windy Pro Desktop / Mobile Client                                │
│                                                                   │
│  matrix-js-sdk  ──────────────────────► Synapse (:8008)           │
│  (messaging, E2E, sync)                                           │
│                                                                   │
│  HTTP API calls ──► Onboarding  (:8101)  Phone/email OTP, profile │
│                 ──► Directory   (:8102)  Contact discovery         │
│                 ──► Push GW     (:8103)  Register push tokens      │
│                 ──► Backup      (:8104)  Encrypted backup/restore  │
│                 ──► Social      (:8105)  Posts, follows, likes     │
│                 ──► Translation (:8106)  Translate text             │
│                 ──► Media       (:8107)  Upload/serve files         │
│                 ──► Call History(:8108)  VoIP call metadata         │
└──────────────────────────────────────────────────────────────────┘
```

---

## Auth: How Clients Authenticate

### 1. User JWT (for all client requests)

The client obtains a JWT from the windy-pro account-server on login. This JWT is
passed as `Authorization: Bearer <jwt>` to all chat microservices.

**JWT payload:**

```json
{
  "sub": "chat_user_id",
  "windy_identity_id": "uuid (cross-product correlation ID)",
  "email": "user@example.com",
  "display_name": "Grant",
  "iat": 1234567890,
  "exp": 1234567890
}
```

**Algorithm:** RS256 (production) or HS256 (development)

### 2. Matrix access token (for Synapse)

After onboarding, the client receives a Matrix access token from the provisioning
endpoint. Use this with matrix-js-sdk for all Matrix API calls.

---

## Onboarding Flow (K2)

The client drives this flow step by step:

> **2026-07-06:** the OTP steps (`verify/send` / `verify/check`) are RETIRED.
> Identity verification happens in the windy-pro account-server (signup +
> email OTP there); clients arrive at chat already authenticated via SSO /
> unified-login. The remaining chat-side steps:

```
1. GET  /api/v1/chat/profile/check-name   → Check display name availability
2. POST /api/v1/chat/profile/setup        → Create profile (name, languages, avatar)
3. POST /api/v1/chat/provision            → Provision Matrix account
   ↓ Returns: { matrix_user_id, access_token, device_id, home_server }
4. Initialize matrix-js-sdk with the access token
```

All endpoints on port **8101**.

### QR Pairing (desktop ↔ mobile)

```
Desktop: POST /api/v1/chat/pair/generate  → Get QR payload
Mobile:  POST /api/v1/chat/pair/confirm   → Scan and confirm
Desktop: GET  /api/v1/chat/pair/status/:id → Poll until paired
```

---

## Matrix SDK Integration

After provisioning, initialize the Matrix client:

```javascript
import sdk from 'matrix-js-sdk';

const client = sdk.createClient({
  baseUrl: 'https://chat.windychat.ai',
  accessToken: provisionResult.access_token,
  userId: provisionResult.matrix_user_id,
  deviceId: provisionResult.device_id,
});

// Start syncing
await client.startClient({ initialSyncLimit: 20 });

// E2E encryption (K7)
await client.initCrypto();
await client.uploadKeys();
```

### Key Backup (K7)

```javascript
// Check for existing backup
const backup = await client.checkKeyBackup();
if (!backup) {
  // Create new backup with recovery key
  const recovery = await client.createRecoveryKeyFromPassphrase(passphrase);
  await client.bootstrapSecretStorage({ createSecretStorageKey: () => recovery });
}

// Restore from backup on new device
await client.restoreKeyBackupWithRecoveryKey(recoveryKey, backup.version);
```

### Cross-Signing (K7)

```javascript
// Bootstrap cross-signing (first device)
await client.bootstrapCrossSigning({
  authUploadDeviceSigningKeys: async (makeRequest) => {
    await makeRequest({ /* auth */ });
  },
});

// Verify another device
await client.requestVerification(userId, [deviceId]);
```

---

## Social Features (K10)

All endpoints on port **8105**, auth required.

```
POST /api/v1/social/posts                  → Create post
GET  /api/v1/social/posts                  → Feed (own + followed)
GET  /api/v1/social/posts/:id              → Single post
GET  /api/v1/social/posts/user/:userId     → User's posts
POST /api/v1/social/posts/:id/like         → Like
DELETE /api/v1/social/posts/:id/like       → Unlike
POST /api/v1/social/follow/:userId         → Follow
DELETE /api/v1/social/follow/:userId       → Unfollow
GET  /api/v1/social/notifications          → Notifications
POST /api/v1/social/notifications/read     → Mark as read
GET  /api/v1/social/presence/:userId       → Online status
```

### Post with translations

```json
POST /api/v1/social/posts
{
  "content": "Hello world!",
  "translated_versions": {
    "es": "¡Hola mundo!",
    "ja": "こんにちは世界！"
  }
}
```

---

## Translation (K9)

Port **8106**, auth required.

```
POST /api/v1/translate
{ "text": "Hello", "source_lang": "en", "target_lang": "es" }
→ { "translated_text": "Hola", "confidence": 0.95, "cached": false }

GET  /api/v1/translate/preferences
POST /api/v1/translate/preferences
{ "preferred_language": "es", "auto_translate": true }
```

Real-time translation in Matrix rooms is handled by the appservice —
messages are auto-translated when rooms have users with different language
preferences.

---

## Media Upload (K4)

Port **8107**, auth required.

```javascript
// Upload
const form = new FormData();
form.append('file', fileBlob, 'photo.jpg');

const res = await fetch('http://localhost:8107/api/v1/media/upload', {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}` },
  body: form,
});
// → { media_id, url, thumbnail_url, mime_type, size }

// Serve
<img src="http://localhost:8107/api/v1/media/{media_id}" />
<img src="http://localhost:8107/api/v1/media/{media_id}/thumbnail" />
```

Supported types: jpg, png, gif, webp, mp4, mp3, ogg, pdf, doc, docx. Max 50MB.
Thumbnails auto-generated for images (sharp) and video (ffmpeg).

---

## Push Notifications (K6)

Port **8103**, auth required.

```
POST /api/v1/chat/push/register
{ "pushkey": "fcm-token", "userId": "user_id", "platform": "android" }

POST /api/v1/chat/push/mute
{ "userId": "id", "roomId": "!room:server", "duration": "8h" }
```

Push payloads never contain message text — the body is always "New message".

---

## Call History (K5)

Port **8108**, auth required.

```
POST /api/v1/calls/log
{ "room_id", "caller_id", "callee_id", "started_at", "ended_at",
  "duration_seconds", "call_type": "voice"|"video", "quality_score" }

GET /api/v1/calls/history?limit=20&offset=0
GET /api/v1/calls/stats
→ { total_calls, total_minutes, avg_duration, calls_today }
```

Actual VoIP signaling is handled by Matrix (`m.call.*` events) + Coturn TURN server.
The client uses matrix-js-sdk's VoIP module; this service just records metadata.

---

## Backup & Restore (K8)

Port **8104**, auth required.

```
POST /api/v1/chat/backup/create
{ "userId": "id", "encryptedData": "base64...", "metadata": {} }

GET  /api/v1/chat/backup/list?userId=id
POST /api/v1/chat/backup/restore { "userId": "id", "backupId": "uuid" }
```

**Client-side encryption:**

```javascript
// Encrypt before upload
const key = await deriveKey(passphrase); // PBKDF2, 100k iterations, SHA-512
const encrypted = await encrypt(data, key); // AES-256-GCM
// Format: salt(32) + iv(12) + authTag(16) + ciphertext
```

---

## Contact Discovery (K3)

Port **8102**, auth required.

```javascript
// Privacy-first: hash phone numbers before sending
const salt = await fetch('/api/v1/chat/directory/salt').then(r => r.json());
const hashes = contacts.map(phone =>
  sha256(normalizeE164(phone) + salt.salt)
);

const matches = await fetch('/api/v1/chat/directory/lookup', {
  method: 'POST',
  body: JSON.stringify({ hashes }),
});
```

---

## Environment Variables (Client Side)

| Variable | Value | Description |
|----------|-------|-------------|
| `CHAT_HOMESERVER_URL` | `https://chat.windychat.ai` | Matrix homeserver |
| `CHAT_ONBOARDING_URL` | `http://localhost:8101` | Onboarding service |
| `CHAT_DIRECTORY_URL` | `http://localhost:8102` | Directory service |
| `CHAT_PUSH_URL` | `http://localhost:8103` | Push gateway |
| `CHAT_BACKUP_URL` | `http://localhost:8104` | Backup service |
| `CHAT_SOCIAL_URL` | `http://localhost:8105` | Social service |
| `CHAT_TRANSLATE_URL` | `http://localhost:8106` | Translation proxy |
| `CHAT_MEDIA_URL` | `http://localhost:8107` | Media service |
| `CHAT_CALLS_URL` | `http://localhost:8108` | Call history |

In production, all services are behind nginx on `https://chat.windychat.ai`
with path-based routing.
