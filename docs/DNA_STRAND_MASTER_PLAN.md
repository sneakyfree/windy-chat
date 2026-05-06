# DNA Strand Master Plan — Windy Chat Backend

> The complete development roadmap for the windy-chat repo, organized by DNA Strand (K1–K10).
> Grounded in the actual codebase as of 2026-03-29.

---

## How to Read This Document

Each strand follows this structure:

- **Vision** — What the strand is supposed to do
- **Status** — Current implementation state with completion percentage
- **What Exists** — Actual code, with file paths and line counts
- **What's Missing** — Gaps between vision and reality
- **Dependencies** — What must exist before this strand can be completed
- **Priority** — Build order ranking (P0–P3)

**Complexity scale:**
- **S** (Small) — Days. Config changes, wiring, minor features.
- **M** (Medium) — 1–2 weeks. New endpoints, integrations, moderate new logic.
- **L** (Large) — 2–6 weeks. New service, significant new infrastructure.
- **XL** (Extra Large) — 6+ weeks. Major new system, protocol-level work, multiple services.

---

## Overall Status Summary

| Strand | Name | Status | Completion | Priority |
|--------|------|--------|------------|----------|
| **K1** | Synapse Homeserver | Production-ready | **~95%** | P0 |
| **K2** | Onboarding | Built, hardened | **~90%** | P0 |
| **K3** | Contact Discovery | Built, hardened | **~85%** | P0 |
| **K4** | Rich Media Sharing | Upload + image/video thumbnails | **~50%** | P1 |
| **K5** | VoIP / WebRTC | Call history built, Coturn ready | **~30%** | P1 |
| **K6** | Push Notifications | Built, production-ready | **~85%** | P0 |
| **K7** | E2E Encryption | Key backup + cross-signing enabled | **~75%** | P1 |
| **K8** | Cloud Backup | Built, production-ready | **~85%** | P0 |
| **K9** | Translation Integration | Proxy + appservice built | **~65%** | P2 |
| **K10** | Social Layer | Core complete, hardened | **~85%** | P0 |

---

## K1 — Synapse Homeserver

### Vision

Our own Matrix homeserver at `chat.windychat.ai`. Federation disabled (Windy-users-only
network). All registration goes through the windy-pro account-server — no direct Matrix
signups. This is the messaging backbone that everything else sits on top of.

### Status: Production-Ready (~95%)

### What Exists

| File | Lines | Purpose |
|------|-------|---------|
| `deploy/synapse/homeserver.yaml` | 153 | Full Synapse config — PostgreSQL, Redis, rate limiting, TURN, media, retention |
| `deploy/synapse/windy_registration.py` | 263 | Custom auth module — validates credentials against account-server (H1), auto-provisions Matrix accounts, display name management |
| `deploy/synapse/docker-compose.yml` | 95 | PostgreSQL 16, Redis 7, Coturn (TURN/STUN), Synapse, Nginx reverse proxy |
| `deploy/synapse/setup.sh` | 276 | One-time init script — generates signing keys, creates turnserver.conf, starts stack |

**Key configuration decisions already made:**
- `server_name: chat.windychat.ai`
- `enable_registration: false` (enforced by custom module)
- `federation_domain_whitelist: []` (federation disabled)
- Rate limits tuned for real-time chat (5 msg/sec, burst 20)
- Media upload limit: 100MB
- Message retention: 1–365 days
- Push notification content: `include_content: false` (privacy)
- TURN server configured for VoIP NAT traversal

**Custom registration module (`windy_registration.py`):**
- Intercepts `m.login.password` auth
- POSTs to account-server: `/api/v1/auth/chat-validate`
- Auto-provisions Matrix account if user doesn't exist yet
- Converts Windy identity → Matrix localpart (`windy_<name>`)

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| TLS certificates for production (nginx) | High | S |
| Monitoring / alerting (Prometheus metrics export) | Medium | S |
| Synapse worker scaling (for >1000 concurrent users) | Low | M |
| Database backup strategy (pg_dump cron) | Medium | S |
| Nginx config file — referenced but not in repo | High | S |

### Dependencies

- **windy-pro account-server** must be running at `WINDY_ACCOUNT_SERVER_URL`
- **DNS** for `chat.windychat.ai` pointing to the host
- **TLS certificates** for HTTPS

### Priority: P0 — Foundation for all other strands

### Complexity: S (remaining work is ops/config, not code)

---

## K2 — Onboarding Service

### Vision

WhatsApp-style signup: phone/email verification → display name → QR pairing (desktop ↔
mobile) → Matrix account provisioning. Zero-friction path from "download the app" to
"chatting with people." Every Windy Fly agent also goes through this flow on hatch.

### Status: Built, Hardened (~90%)

### What Exists

| File | Lines | Sub-strand | Purpose |
|------|-------|------------|---------|
| `services/onboarding/server.js` | 108 | — | Express server, CORS, rate limiting, route mounting |
| `services/onboarding/routes/verify.js` | 395 | K2.1 | 6-digit OTP via Twilio SMS / SendGrid email |
| `services/onboarding/routes/profile.js` | 318 | K2.2 | Display name validation, profanity filter, language selection (39 langs) |
| `services/onboarding/routes/pair.js` | 265 | K2.3 | QR code pairing with X25519 key exchange |
| `services/onboarding/routes/provision.js` | 289 | K2.4 | Matrix account creation via Synapse admin API |
| `services/shared/jwt-verify.js` | 85 | — | Shared JWT auth — JWKS (RS256) + HS256 fallback + service token |

**K2.1 — Phone/Email OTP:** Cryptographically secure 6-digit codes, E.164 normalization, rate limiting (5/min, 5/hour), Redis-backed with in-memory fallback, PII redaction.

**K2.2 — Display Name Setup:** 2–64 chars, Unicode, profanity filter, uniqueness enforcement with suggestions.

**K2.3 — QR Code Pairing:** X25519 ephemeral key exchange, 120-second session TTL, desktop generates → mobile scans → server links.

**K2.4 — Matrix Provisioning:** Synapse admin API (nonce → HMAC-SHA1 → register), onboarding state machine.

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| Auth token validation in QR pairing (`pair.js:158` TODO) | High | S |
| Database migration (profiles — currently file-based JSON) | High | M |
| Bot/agent onboarding flow (service-to-service provisioning) | High | M |
| Account deletion / GDPR | Medium | M |
| Avatar upload (currently URL only) | Medium | S |
| Email templates (branded HTML) | Low | S |
| Rate limit persistence (in-memory, resets on restart) | Medium | S |

### Dependencies

- **K1** (Synapse running) for provisioning
- **windy-pro account-server** for JWT validation
- **Twilio** for production SMS, **SendGrid** for email
- **Redis** for production-grade OTP/session storage

### Priority: P0 — Core user acquisition path

### Complexity: M

---

## K3 — Contact Discovery Service

### Vision

Privacy-first contact discovery — Signal-style hash-based lookup so raw phone numbers
never leave the device. Plus searchable directory with fuzzy name matching and SMS/email
invites to grow the network.

### Status: Built, Hardened (~85%)

### What Exists

| File | Lines | Sub-strand | Purpose |
|------|-------|------------|---------|
| `services/directory/server.js` | 101 | — | Express server, CORS, rate limiting |
| `services/directory/routes/lookup.js` | 249 | K3.1 | SHA256 hash-based contact lookup, weekly salt rotation |
| `services/directory/routes/search.js` | 400 | K3.2 | Fuzzy name search, exact email/phone, SMS/email invites |

**K3.1 — Hash-Based Lookup:** Client hashes phone numbers with server salt → server matches hashes → returns `{ userId, displayName, avatarUrl }`. Weekly salt rotation, max 1000 hashes/batch.

**K3.2 — Search & Invite:** Fuzzy name matching (prefix > word-start > contains), exact email/phone, referral codes with deep links.

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| Database migration (entire directory is in-memory Maps) | High | M |
| Salt rotation transition period (keep old salt briefly) | Medium | S |
| Referral tracking (codes generated but conversions untracked) | Medium | M |
| Blocked users / spam prevention | Medium | M |
| Bot directory (Eternitas-verified bots, separate facet) | Medium | M |
| Batch directory registration | Low | S |

### Dependencies

- **K1** (Synapse) for Matrix user ID resolution
- **K2** (Onboarding) — users must be onboarded before appearing in directory
- **Twilio / SendGrid** for invite delivery

### Priority: P0 — Network growth depends on discoverability

### Complexity: M

---

## K4 — Rich Media Sharing

### Vision

Share images, video, audio, files, and voice messages in chat. Matrix already supports
media uploads via `/_matrix/media/`, but Windy Chat needs a polished layer on top:
thumbnails, previews, voice message waveforms, link previews, and media gallery.

### Status: Upload + Serve + Thumbnails (~40%)

### What Exists

| File | Lines | Purpose |
|------|-------|---------|
| `services/media/server.js` | 200 | Express server — upload, serve, thumbnail generation |
| `services/media/lib/db.js` | 45 | SQLite media registry with windy_identity_id |

- **Synapse media store** configured in `homeserver.yaml` with 100MB upload limit and URL preview enabled.
- **Media service** on port 8107 — upload with file type validation, 50MB max, local disk storage, optional sharp thumbnails.

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| Thumbnail generation service | High | M |
| Voice message processing (waveform visualization) | High | M |
| Link preview service (Open Graph metadata) | Medium | M |
| Media gallery API (per-room media index, paginated) | Medium | M |
| File type validation + virus scan (ClamAV) | Medium | S |
| CDN / edge caching | Low | L |
| Sticker packs (Windy-branded default + user-created) | Low | M |

### Dependencies

- **K1** (Synapse media store operational)
- **Client repos** (windy-pro, windy-pro-mobile) for rendering
- **Storage** — Synapse media store or R2/S3

### Priority: P1 — Enhances messaging core

### Complexity: L (service: `services/media/`, port 8107)

---

## K5 — VoIP / WebRTC

### Vision

Voice and video calls between Windy Chat users. 1:1 calls first, group calls later. Matrix
supports VoIP via `m.call.*` event types and TURN/STUN for NAT traversal.

### Status: Call History Built, Coturn Ready (~30%)

### What Exists

| File | Lines | Purpose |
|------|-------|---------|
| `services/call-history/server.js` | 145 | Call log, history, stats endpoints |
| `services/call-history/lib/db.js` | 70 | SQLite call log with windy_identity_id |

- **Coturn (TURN/STUN)** fully configured in `deploy/synapse/docker-compose.yml`:
  - Ports: 3478 (UDP/TCP), 5349 (TLS), 49152–49200 (relay range)
  - Shared secret auth with Synapse, 24-hour user lifetime
- **Synapse TURN config** in `homeserver.yaml` (turn URIs for UDP/TCP/TLS)
- **Call history service** on port 8108 — log calls, query history with pagination, aggregate stats (total calls, minutes, avg duration, today count)

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| Client-side VoIP implementation (matrix-js-sdk) | High | L |
| Call history service (metadata: who, when, duration) | Medium | M |
| Group call support (MSC3401 or custom SFU) | Low | XL |
| Call quality monitoring (WebRTC stats) | Low | M |
| Voicemail (record → deliver as voice message, ties into K4) | Low | L |
| Screen sharing | Low | M |

### Dependencies

- **K1** (Synapse + Coturn running)
- **Client repos** for all call UI/UX
- **K6** (Push) for incoming call notifications

### Priority: P1 — Most work is client-side; backend is TURN + optional SFU

### Complexity: L (backend is call history service; client-side is the heavy lift)

---

## K6 — Push Notification Gateway

### Vision

Every message, call, and mention generates a push notification. Matrix sends push events
to our gateway, which routes to FCM (Android) and APNs (iOS). Message content is **never**
included in push payloads — privacy is non-negotiable.

### Status: Built, Needs Credentials (~85%)

### What Exists

| File | Lines | Purpose |
|------|-------|---------|
| `services/push-gateway/server.js` | 471 | Complete push gateway — Matrix endpoint, FCM, APNs, mute, token management |

**K6.1 — Matrix Push Endpoint:** `POST /_matrix/push/v1/notify` — receives from Synapse, body always `"New message"`.

**K6.2 — FCM (Android):** `firebase-admin` SDK, high priority, custom channel. Stubs when credentials missing.

**K6.3 — APNs (iOS):** `apn` module, production/sandbox toggle. Stubs when credentials missing.

**K6.4 — Per-Conversation Mute:** 1h, 8h, 1d, 1w, forever. Mention override bypasses mute.

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| Firebase credentials (`FIREBASE_SERVICE_ACCOUNT`) | High | S |
| APNs credentials (`.p8` key, key ID, team ID) | High | S |
| Database migration (push tokens — file-based) | High | M |
| Token cleanup (purge stale tokens rejected by FCM/APNs) | Medium | S |
| Web push (PWA/VAPID) | Medium | M |
| Rich notifications (iOS service extension, Android custom layout) | Low | M |
| Notification preferences API (per-category toggles) | Medium | S |

### Dependencies

- **K1** (Synapse) configured to push to `http://push-gateway:8103/_matrix/push/v1/notify`
- **Apple Developer Account** for APNs
- **Firebase project** for FCM
- **Client apps** with correct bundle IDs

### Priority: P0 — Mobile experience depends on push

### Complexity: S (code is done; credentials + DB migration)

---

## K7 — End-to-End Encryption

### Vision

All private messages are E2E encrypted via the Matrix protocol (Olm/Megolm Double Ratchet).
The server never sees plaintext message content.

### Status: Delegated to Matrix (~60%)

### What Exists

- **Synapse** handles server-side E2E natively: device key storage/distribution, key upload/query/claim APIs, to-device message routing
- **K8** (Backup) ensures encrypted messages can be recovered on new devices
- **K6** (Push) enforces `include_content: false` — encrypted content never leaks via push

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| Client-side Olm/Megolm initialization | High | L |
| Key backup server (Synapse supports, needs enabling) | High | M |
| Cross-signing (device verification, SSSS) | High | L |
| Device verification UX (emoji, QR — ties into K2.3) | Medium | L |
| Audit / compliance logging (metadata only, no content) | Low | M |
| Key rotation policy config | Low | S |

### Dependencies

- **K1** (Synapse) with key backup APIs enabled
- **K2** (Onboarding) — device keys uploaded during provisioning
- **K8** (Backup) — encrypted key backup for device recovery
- **Client repos** for all encryption UI/UX

### Priority: P1 — Primarily client-side; backend enables key backup + cross-signing

### Complexity: L

---

## K8 — Cloud Backup & Sync

### Vision

Zero-knowledge encrypted backup of chat data to Cloudflare R2. Users set a backup password;
key derived via PBKDF2, encrypted with AES-256-GCM. Server can never decrypt backups.

### Status: Built, Needs Credentials (~85%)

### What Exists

| File | Lines | Purpose |
|------|-------|---------|
| `services/backup/server.js` | 445 | Complete backup service — create, list, restore, delete, encryption, R2 storage |

**K8.1 — Encrypted Backup:** PBKDF2 (100k iterations) + AES-256-GCM. Format: `salt(32) + iv(12) + authTag(16) + ciphertext`. Max 500MB. R2 storage at `backups/{userId}/{timestamp}.enc`.

**K8.2 — Restore:** List backups (max 7 retained), download encrypted blob, client decrypts. Auto-prune oldest when limit exceeded.

**K8.3 — Metadata:** Optional unencrypted metadata (messageCount, roomCount, clientVersion). Never includes PII.

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| R2 credentials (Cloudflare bucket + API keys) | High | S |
| Database migration (registry is file-based JSON) | High | M |
| Automatic scheduled backups (daily at 3am) | Medium | M |
| Incremental backups | Medium | L |
| Soul File integration (personality, voice clone, agent config) | Low | L |
| Backup verification (checksum without download) | Low | S |
| Cross-device sync (real-time, conflict resolution) | Medium | L |

### Dependencies

- **Cloudflare R2** account and bucket
- **Client repos** for backup trigger UI and password management
- **K7** (E2E) — Megolm session keys must be included in backup

### Priority: P0 — Data safety is table stakes

### Complexity: S (code is done; credentials + DB migration)

---

## K9 — Translation Integration

### Vision

Real-time message translation powered by Windy Traveler's 2,500+ fine-tuned language pair
models. Every message auto-translated into the reader's language. The social feed (K10) is
multilingual by default. Translation drives Traveler pair purchases — every cross-language
conversation is a monetization event.

### Status: Proxy + Preferences Built (~50%)

### What Exists

| File | Lines | Purpose |
|------|-------|---------|
| `services/translation/server.js` | 200 | Translation proxy — cache, preferences, rate limiting |
| `services/translation/lib/db.js` | 55 | SQLite cache + user preferences with windy_identity_id |

- **Translation proxy service** on port 8106 — bridges to Windy Pro's translate-api.
- **SQLite caching** with 24h TTL, SHA-256 cache keys.
- **User language preferences** API (get/set preferred language, auto-translate toggle).
- **Rate limiting** at 100 translations/min per user.
- K3 (Directory) stores user language preferences (39 languages).
- Synapse can be extended with application services.

### What's Missing

| Gap | Priority | Complexity |
|-----|----------|------------|
| Translation proxy service (`services/translate-proxy/`, port 8106) | High | L |
| Per-user language preferences API | Medium | S |
| Matrix Application Service for auto-translation | High | L |
| Translation caching | Medium | M |
| Monetization hooks to Windy Traveler | Medium | M |
| Bulk translation (pre-translate K10 feed posts) | Low | M |

### Dependencies

- **windy-pro translate-api** accessible with stable API
- **K1** (Synapse) for message event stream
- **K3** (Directory) for language preferences
- **K10** (Social Layer) for feed post translation
- **Windy Traveler** pair models deployed

### Priority: P2 — Monetization bridge; requires K10 to maximize impact

### Complexity: L

### Recommended Architecture

```
Option A — Application Service (recommended for real-time):
  Synapse → events to AS → AS calls translate-api → AS posts translated
  event as related message (m.relates_to)

Option B — Client-side translation:
  Client receives → calls translate-proxy → renders both
  (simpler but slower; per-reader not per-message)

Option C — Hybrid:
  Popular languages pre-translated server-side (AS);
  rare pairs on-demand client-side
```

---

## K10 — Social Layer

### Vision

From BRAND-ARCHITECTURE.md: _"Rather than building a separate social media product, Windy
Chat evolves from private messaging into messaging + public social. This concentrates the
network effect in one place."_

### Status: Core Complete, Hardened (~85%)

### What Was Just Built

| File | Lines | Purpose |
|------|-------|---------|
| `services/social/server.js` | 101 | Express server, CORS, rate limiting, route mounting |
| `services/social/routes/posts.js` | 201 | Create/read posts, text (5000 chars max), profanity filter, `translated_versions` field |
| `services/social/routes/follow.js` | 82 | Follow/unfollow, followers/following lists, self-follow prevention |
| `services/social/routes/notifications.js` | 61 | Like/follow notifications, mark as read, unread count |
| `services/social/routes/moderation.js` | 60 | Report posts (spam, harassment, hate_speech, violence, nudity, misinformation) |
| `services/social/lib/store.js` | — | In-memory data store with JSON file persistence |
| `services/social/lib/profanity.js` | — | Basic profanity filtering |

**What's working now:**
- Posts: create, read, list by user, feed (own + followed), pagination with cursor
- Likes/unlike with counts and notifications
- Follow graph: follow, unfollow, followers list, following list
- Notifications: retrieve, mark read, unread count
- Moderation: report with reason enum, duplicate prevention
- Eternitas verified badges on posts/profiles
- Presence: online status + verified badge lookup

### What's Needed Next

| Gap | Priority | Complexity |
|-----|----------|------------|
| **Database migration** (everything is in-memory Maps/Sets) | **Critical** | M |
| Algorithmic feed (currently chronological only) | Medium | L |
| Trending topics / hashtag system | Medium | L |
| Discovery engine ("people you may know", suggested users) | Medium | L |
| Media attachments in posts (ties into K4) | Medium | M |
| Full-text search across posts | Medium | L |
| Privacy controls (public/private accounts, post visibility) | Medium | M |
| Bot social presence auto-posting (Eternitas integration) | Medium | M |
| Content moderation workflows (flagged → human review queue) | Medium | M |
| Repost / share functionality | Low | S |
| Comments vs reply threads | Low | M |

### Dependencies

- **K3** (Directory) — user profiles and search as foundation
- **K4** (Rich Media) — media attachments in posts
- **K6** (Push) — social notification delivery (new follower, like, reply)
- **K9** (Translation) — multilingual feed
- **Eternitas** — bot social identity and verification badges

### Priority: P0 — Just built; needs hardening and DB migration immediately

### Complexity: M for hardening, XL for full vision

---

## Cross-Cutting Concerns

### Database Migration (affects K2, K3, K6, K8, K10)

All five existing services use in-memory Maps with file-based JSON persistence. This is the
single most critical gap — a restart loses all state.

**Plan:**
1. Add shared PostgreSQL to root `docker-compose.yml` (separate from Synapse's DB)
2. Create `services/shared/db.js` connection pool module
3. Migrate each service incrementally:
   - K2: profiles, display name registry, onboarding state
   - K3: hash directory, user directory, invite tracking
   - K6: push tokens, mute settings
   - K8: backup registry (blobs stay in R2)
   - K10: posts, follows, likes, notifications, reports

### Production Credentials (affects K2, K3, K6, K8)

| Credential | Service | Status |
|------------|---------|--------|
| Twilio account SID + auth token | K2, K3 | Missing |
| SendGrid API key | K2, K3 | Missing |
| Firebase service account JSON | K6 | Missing |
| APNs .p8 key + key ID + team ID | K6 | Missing |
| Cloudflare R2 bucket + API keys | K8 | Missing |

---

## Recommended Build Order

```
Phase 0 — Hardening (immediate)                         Priority: P0
├── Database migration for K2, K3, K6, K8, K10
├── Auth token validation fix (K2 pair.js TODO)
├── Production credentials (Twilio, SendGrid, Firebase, APNs, R2)
├── K10 hardening (DB, search, moderation queue)
├── TLS certificates + nginx config (K1)
└── Basic test coverage

Phase 1 — Complete the Messaging Core                   Priority: P1
├── K7: Enable Synapse key backup + cross-signing config
├── K5: Call history service (VoIP UI is client-side)
└── K4: Media service (thumbnails, voice waveforms, link previews)

Phase 2 — Translation (the monetization bridge)         Priority: P2
├── K9: Translation proxy service
├── K9: Synapse Application Service for auto-translation
└── K9: Monetization hooks to Windy Traveler

Phase 3 — Polish & Scale                                Priority: P3
├── K1: Synapse worker scaling
├── K4: CDN / edge caching
├── K5: Group calls (SFU)
├── K6: Web push, rich notifications
├── K10: Algorithmic feed, trending, discovery engine
└── K10: Bot social presence auto-posting
```

---

## Service Port Map

| Port | Service | Strand | Status |
|------|---------|--------|--------|
| 8008 | Synapse | K1 | Running |
| 8101 | Onboarding | K2 | Running |
| 8102 | Directory | K3 | Running |
| 8103 | Push Gateway | K6 | Running |
| 8104 | Backup | K8 | Running |
| 8105 | Social | K10 | Running |
| 8106 | Translation Proxy | K9 | Running |
| 8107 | Media | K4 | Running |
| 8108 | Call History | K5 | **Running (new)** |

---

## Strand Dependency Graph

```
K1 (Synapse) ──────────────────────────────────────────┐
  ├── K2 (Onboarding) ── K3 (Directory) ── K10 (Social)│
  ├── K5 (VoIP) ← K6 (Push)                            │
  ├── K6 (Push) ← K1                                   │
  ├── K7 (E2E) ← K2, K8                                │
  ├── K8 (Backup) ← K7                                 │
  ├── K4 (Rich Media) ← K1                             │
  └── K9 (Translation) ← K1, K3, K10                   │
       └── Windy Traveler (external)                    │
                                                        │
K10 (Social) ← K3, K4, K6, K9, Eternitas ──────────────┘
```

---

_Last updated: 2026-03-31 (K7 key backup, K4 video thumbs, K9 appservice, prod hardening, client integration). Update strand statuses as work is completed.
For ecosystem-wide strategy, see [BRAND-ARCHITECTURE.md](../BRAND-ARCHITECTURE.md).
For API contracts with windy-pro, see [API_CONTRACT.md](./API_CONTRACT.md)._
