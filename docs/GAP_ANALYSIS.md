# Gap Analysis: Code vs DNA Strand Master Plan

> Feature-by-feature verification of what exists, what's stubbed, and what's missing.
> Audit date: 2026-03-31

---

## K1 — Synapse Homeserver (95%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| Custom auth module (windy_registration.py) | Exists | **IMPLEMENTED** | POSTs to `/api/v1/auth/chat-validate` with `{user, password}` format |
| PostgreSQL + Redis stack | Exists | **IMPLEMENTED** | docker-compose.yml: PostgreSQL 16 + Redis 7 |
| Federation disabled | Exists | **IMPLEMENTED** | `federation_domain_whitelist: []` in homeserver.yaml |
| TURN/Coturn for VoIP | Exists | **IMPLEMENTED** | Ports 3478/5349, shared secret auth |
| Rate limiting | Exists | **IMPLEMENTED** | 5 msg/sec, burst 20; login 1/sec, burst 5 |
| Media store | Exists | **IMPLEMENTED** | 100MB limit, URL preview enabled |
| Key backup | Missing | **IMPLEMENTED** | `enable_room_key_backup: true` in homeserver.yaml |
| Cross-signing | Missing | **IMPLEMENTED** | `enable_cross_signing: true` in homeserver.yaml |
| TLS certificates | Missing | **STUB** | `setup-tls.sh` script exists; certs not generated |
| Monitoring/alerting | Missing | **MISSING** | `enable_metrics: true` but no Prometheus/Grafana |
| Worker scaling | Missing | **MISSING** | Single Synapse process |
| DB backup strategy | Missing | **MISSING** | No pg_dump cron |

---

## K2 — Onboarding (90%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| Phone OTP (Twilio) | Exists | **IMPLEMENTED** | 6-digit codes, E.164 normalization, rate limited |
| Email OTP (SendGrid) | Exists | **IMPLEMENTED** | Same flow as phone |
| Display name validation | Exists | **IMPLEMENTED** | 2-64 chars, Unicode, profanity filter, uniqueness |
| Language selection (39 langs) | Exists | **IMPLEMENTED** | Validated against ISO 639-1 |
| QR pairing (X25519) | Exists | **IMPLEMENTED** | 120s TTL, key exchange, desktop ↔ mobile |
| Matrix provisioning | Exists | **IMPLEMENTED** | Synapse admin API with HMAC-SHA1 nonce auth |
| QR auth token validation | Missing | **MISSING** | TODO comment at pair.js — token accepted without validation |
| Bot/agent onboarding | Missing | **MISSING** | No service-to-service provisioning flow |
| Account deletion / GDPR | Missing | **MISSING** | No delete endpoints |
| Avatar upload | Missing | **MISSING** | URL only; no file upload integration with K4 |

---

## K3 — Contact Discovery (85%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| SHA256 hash lookup | Exists | **IMPLEMENTED** | 64-char hex validation, batch up to 1000 |
| Weekly salt rotation | Exists | **IMPLEMENTED** | 7-day rotation, persisted in SQLite |
| Fuzzy name search | Exists | **IMPLEMENTED** | Prefix > word-start > contains scoring |
| Exact email/phone match | Exists | **IMPLEMENTED** | Lowercased email, E.164 phone |
| SMS/email invites | Exists | **IMPLEMENTED** | Referral codes, deep links, 20/day limit |
| Salt rotation transition | Missing | **MISSING** | Old salt not kept during transition |
| Referral tracking | Missing | **MISSING** | Codes generated but conversions untracked |
| Blocked users | Missing | **MISSING** | No block/spam list |
| Bot directory | Missing | **MISSING** | No Eternitas-verified bot facet |

---

## K4 — Rich Media (50%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| File upload with validation | Missing→Built | **IMPLEMENTED** | Multer; 50MB max; allowlist enforced |
| Image thumbnails (sharp) | Missing→Built | **IMPLEMENTED** | 200x200 cover crop, JPEG 80% quality; verified working |
| Video thumbnails (ffmpeg) | Missing→Built | **IMPLEMENTED** | Frame at 1s with retry; verified via `execFile('ffmpeg')` |
| File serving with Content-Type | Missing→Built | **IMPLEMENTED** | Correct headers, inline disposition |
| Voice message waveforms | Missing | **MISSING** | No audio analysis |
| Link preview (Open Graph) | Missing | **MISSING** | No URL metadata extraction |
| Media gallery API | Missing | **MISSING** | No per-room media index |
| Virus scan (ClamAV) | Missing | **MISSING** | No scanning |
| CDN/edge caching | Missing | **MISSING** | Local disk only |
| Sticker packs | Missing | **MISSING** | Not started |

---

## K5 — VoIP / WebRTC (30%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| Coturn TURN/STUN | Exists | **IMPLEMENTED** | Ports 3478/5349, shared secret, 24hr user lifetime |
| Synapse TURN config | Exists | **IMPLEMENTED** | turn_uris configured in homeserver.yaml |
| Call history service | Missing→Built | **IMPLEMENTED** | Log, history (paginated), stats; standalone service |
| Client-side VoIP | Missing | **MISSING** | No matrix-js-sdk VoIP module integration |
| Call history auto-logging | Missing | **MISSING** | Clients must submit manually; no Synapse event hook |
| Group calls (SFU) | Missing | **MISSING** | No MSC3401 or custom SFU |
| Call quality monitoring | Missing | **MISSING** | quality_score field exists but client must submit |
| Voicemail | Missing | **MISSING** | Not started |
| Screen sharing | Missing | **MISSING** | Not started |

---

## K6 — Push Notifications (85%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| Matrix push endpoint | Exists | **IMPLEMENTED** | `POST /_matrix/push/v1/notify` routes to FCM/APNs |
| FCM (Android) | Exists | **IMPLEMENTED** | firebase-admin SDK; stubs when no credentials |
| APNs (iOS) | Exists | **IMPLEMENTED** | apn module; stubs when no credentials |
| Per-room mute | Exists | **IMPLEMENTED** | 1h/8h/1d/1w/forever; mention override |
| Privacy: no content in push | Exists | **IMPLEMENTED** | Body always "New message" |
| Firebase credentials | Missing | **MISSING** | `FIREBASE_SERVICE_ACCOUNT` not set |
| APNs credentials | Missing | **MISSING** | `.p8` key not provided |
| Token cleanup | Missing | **MISSING** | Stale tokens not purged |
| Web push (VAPID) | Missing | **MISSING** | Not started |

---

## K7 — E2E Encryption (75%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| Synapse E2E support | Exists | **IMPLEMENTED** | Native key storage/distribution |
| Key backup server | Missing→Enabled | **IMPLEMENTED** | `enable_room_key_backup: true` |
| Cross-signing | Missing→Enabled | **IMPLEMENTED** | `enable_cross_signing: true` |
| Nginx key/backup proxying | Missing→Built | **IMPLEMENTED** | Routes for `/room_keys` and `/keys` |
| Client-side Olm/Megolm | Missing | **MISSING** | Client repos must implement |
| Device verification UX | Missing | **MISSING** | Client-side emoji/QR verification |
| Key rotation policy | Missing | **MISSING** | Default Synapse settings |

---

## K8 — Cloud Backup (85%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| PBKDF2 + AES-256-GCM encryption | Exists | **IMPLEMENTED** | 100k iterations, SHA-512; verified in tests |
| Upload to R2 | Exists | **IMPLEMENTED** | S3 client; stubs when no credentials |
| Restore from R2 | Exists | **IMPLEMENTED** | Download + decrypt flow |
| 7-backup retention | Exists | **IMPLEMENTED** | Auto-prune oldest on create |
| Metadata tracking | Exists | **IMPLEMENTED** | Unencrypted metadata (no PII) |
| R2 credentials | Missing | **MISSING** | Not configured |
| Scheduled backups | Missing | **MISSING** | No cron/timer |
| Incremental backups | Missing | **MISSING** | Full backup only |
| Soul File integration | Missing | **MISSING** | Not started |

---

## K9 — Translation Integration (65%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| Translation proxy | Missing→Built | **IMPLEMENTED** | Forwards to `WINDY_TRANSLATE_URL`; verified in contract test |
| SQLite cache (24h TTL) | Missing→Built | **IMPLEMENTED** | SHA-256 cache keys; hourly pruning |
| User language preferences | Missing→Built | **IMPLEMENTED** | Get/set preferred language; stored with windy_identity_id |
| Rate limiting (100/min) | Missing→Built | **IMPLEMENTED** | Per-user via express-rate-limit |
| Graceful fallback (stub) | Missing→Built | **IMPLEMENTED** | Returns original text with `stub: true` when server down |
| Matrix Application Service | Missing→Built | **IMPLEMENTED** | Handler code complete; registration.yaml exists |
| Appservice enabled in Synapse | Missing | **DISABLED** | Commented out in homeserver.yaml |
| Monetization hooks | Missing | **MISSING** | No Windy Traveler integration |
| Bulk feed translation | Missing | **MISSING** | No batch endpoint |

---

## K10 — Social Layer (85%)

| Feature | Plan Status | Code Status | Verification |
|---------|------------|------------|-------------|
| Post CRUD | Built | **IMPLEMENTED** | Create, read; no update or delete by owner |
| Feed (followed users) | Built | **IMPLEMENTED** | Filters by `[userId, ...following]`; verified in tests |
| Likes with notifications | Built | **IMPLEMENTED** | Idempotent; notification queued on new like |
| Follow/unfollow | Built | **IMPLEMENTED** | Self-follow blocked; notification on follow |
| Notifications (mark read) | Built | **IMPLEMENTED** | Batch read marking; unread filter |
| Content moderation (reports) | Built | **IMPLEMENTED** | 7 reason types; duplicate prevention |
| Eternitas verified badges | Built | **IMPLEMENTED** | Local toggle via service-to-service call; NOT external API call to Eternitas |
| Eternitas webhook (HMAC) | Built | **IMPLEMENTED** | Passport revoked/suspended/reinstated; timing-safe HMAC-SHA256 |
| Profanity filter | Built | **IMPLEMENTED** | Blocks content + translated_versions |
| Presence API | Built | **IMPLEMENTED** | Returns online status + verified flag |
| Post delete by owner | Missing | **MISSING** | No DELETE endpoint for posts |
| Algorithmic feed | Missing | **MISSING** | Chronological only |
| Trending/hashtags | Missing | **MISSING** | Not started |
| Discovery engine | Missing | **MISSING** | Not started |
| Media in posts | Missing | **MISSING** | Text only; no K4 integration |
| Full-text search | Missing | **MISSING** | Not started |
| Privacy controls | Missing | **MISSING** | All posts public |
| Bot auto-posting | Missing | **MISSING** | Not started |
| Repost/share | Missing | **MISSING** | Not started |
| Comments/threads | Missing | **MISSING** | Not started |

---

## Summary: NOT_IN_PLAN_BUT_EXISTS

| Feature | Service | Notes |
|---------|---------|-------|
| Translation appservice handler | K9 | Built but not in original plan's "What Exists" |
| ffmpeg video thumbnails | K4 | Built beyond plan's "Not started" |
| Call history service | K5 | Built beyond plan's "Infrastructure only" |
| Credential setup wizard | Ops | `scripts/setup-credentials.sh` |
| TLS automation | Ops | `scripts/setup-tls.sh` |
| Dev start script | Ops | `scripts/dev-start.sh` |
| Synapse dev setup | Ops | `scripts/setup-synapse-dev.sh` |
| Client integration guide | Docs | `docs/CLIENT_INTEGRATION.md` |
| 408-test hardening suite | Tests | Comprehensive coverage not in original plan |
