# Endpoint Crawl Audit

> Every route across all 8 microservices, verified against actual code.
> Original audit date: 2026-03-31
> **Last Verified: 2026-04-03 (second pass)**

---

## Onboarding Service (K2, port 8101)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | Reports Synapse/Redis/Twilio/SendGrid status |
| POST | `/api/v1/chat/verify/send` | JWT | 200, 400, 429 | OTP via Twilio SMS or SendGrid email; rate: 5/min, 5/hr |
| POST | `/api/v1/chat/verify/check` | JWT | 200, 400, 429 | Validate 6-digit OTP; max 3 attempts |
| GET | `/api/v1/chat/verify/status` | JWT | 200 | Check verification status by identifier |
| GET | `/api/v1/chat/profile/check-name` | JWT | 200 | Name availability + suggestions |
| POST | `/api/v1/chat/profile/setup` | JWT | 201, 400 | Create profile: name (2-64), languages, avatar; profanity filter |
| GET | `/api/v1/chat/profile/:userId` | JWT | 200, 404 | Get profile by ID |
| POST | `/api/v1/chat/profile/avatar` | JWT | 201, 400 | **NEW** Upload avatar (JPEG/PNG/GIF/WebP, 5MB max) |
| GET | `/api/v1/chat/profile/avatar/:filename` | None | 200, 404 | **NEW** Serve uploaded avatar |
| DELETE | `/api/v1/onboarding/account` | JWT | 200, 500 | **NEW** GDPR deletion: deactivate Matrix, remove local data, webhook |
| POST | `/api/v1/chat/pair/generate` | JWT | 201 | X25519 QR session; TTL 120s |
| POST | `/api/v1/chat/pair/confirm` | JWT | 200, 400, 404, 409, 410 | Link desktop to mobile |
| GET | `/api/v1/chat/pair/status/:sessionId` | JWT | 200, 404 | Poll pairing status |
| DELETE | `/api/v1/chat/pair/session/:sessionId` | JWT | 200 | Cancel session |
| POST | `/api/v1/chat/provision` | JWT | 201, 400, 502 | Provision Matrix account via Synapse admin API |
| POST | `/api/v1/chat/provision/unified-login` | JWT | 200, 400, 502 | Unified login: provision + credentials in one call |
| POST | `/api/v1/chat/provision/eternitas/webhook` | Service | 200, 400, 401 | Eternitas bot passport lifecycle events |
| GET | `/api/v1/chat/provision/agent-room` | JWT | 200, 400, 404 | Lookup DM room between agent and owner |
| GET | `/api/v1/chat/agent-room` | JWT | 200, 400, 404 | Shortcut alias for agent room lookup |
| GET | `/api/v1/chat/onboarding/status` | JWT | 200 | Onboarding completion state |

**Total: 20 endpoints**

---

## Directory Service (K3, port 8102)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | Reports Twilio/SendGrid status |
| GET | `/api/v1/chat/directory/salt` | JWT | 200 | Current SHA256 salt; 7-day rotation |
| POST | `/api/v1/chat/directory/lookup` | JWT | 200, 400 | Batch hash lookup; max 1000 hashes |
| POST | `/api/v1/chat/directory/register-hash` | JWT | 201, 400 | Register phone/email hash |
| GET | `/api/v1/chat/directory/stats` | JWT | 200 | Hash count, salt age |
| POST | `/api/v1/chat/directory/register` | JWT | 201, 400 | Register in searchable directory |
| GET | `/api/v1/chat/directory/search` | JWT | 200, 400 | Fuzzy name search; min 2 chars; max 20 results |
| POST | `/api/v1/chat/directory/invite` | JWT | 200, 400, 429 | SMS/email invite; max 20/day |

**Total: 8 endpoints**

---

## Push Gateway (K6, port 8103)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | FCM/APNs status, token count |
| POST | `/_matrix/push/v1/notify` | None | 200 | Matrix push endpoint (from Synapse); routes to FCM/APNs |
| POST | `/api/v1/chat/push/register` | JWT | 201, 400 | Register FCM/APNs token |
| POST | `/api/v1/chat/push/mute` | JWT | 200, 400 | Mute room (1h/8h/1d/1w/forever) |
| POST | `/api/v1/chat/push/unmute` | JWT | 200 | Unmute room |
| POST | `/api/v1/chat/push/prune` | JWT | 200 | Prune stale tokens (30-day threshold) |

**Total: 6 endpoints**

---

## Backup Service (K8, port 8104)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | R2 status, user count |
| POST | `/api/v1/chat/backup/create` | JWT | 201, 400, 413 | Upload encrypted backup; max 7 per user |
| GET | `/api/v1/chat/backup/list` | JWT | 200, 400 | List user's backups |
| POST | `/api/v1/chat/backup/restore` | JWT | 200, 400, 404 | Download encrypted backup |
| DELETE | `/api/v1/chat/backup/delete` | JWT | 200, 400, 404 | Delete specific backup |

**Total: 5 endpoints**

---

## Social Service (K10, port 8105)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | Service status |
| GET | `/api/v1/social/presence/:userId` | None | 200 | Online status + verified badge |
| POST | `/api/v1/social/posts` | JWT | 201, 400, 422 | Create post (max 5000 chars, profanity filter) |
| GET | `/api/v1/social/posts` | JWT | 200 | Feed: own + followed users; cursor pagination |
| GET | `/api/v1/social/posts/:postId` | None | 200, 404 | Single post with like count |
| GET | `/api/v1/social/posts/user/:userId` | None | 200 | User's posts; cursor pagination |
| POST | `/api/v1/social/posts/:postId/like` | JWT | 200, 404 | Like (idempotent); queues notification |
| DELETE | `/api/v1/social/posts/:postId/like` | JWT | 200, 404 | Unlike |
| DELETE | `/api/v1/social/posts/:postId` | JWT | 200, 403, 404 | **NEW** Delete own post (ownership verified) |
| GET | `/api/v1/social/posts/search` | None | 200, 400 | **NEW** Full-text search (FTS5 + LIKE fallback) |
| POST | `/api/v1/social/posts/:postId/comments` | JWT | 201, 400, 404, 422 | **NEW** Create comment (profanity filter) |
| GET | `/api/v1/social/posts/:postId/comments` | None | 200, 404 | **NEW** List comments for post |
| POST | `/api/v1/social/follow/:targetUserId` | JWT | 200, 400 | Follow (rejects self-follow) |
| DELETE | `/api/v1/social/follow/:targetUserId` | JWT | 200 | Unfollow |
| GET | `/api/v1/social/follow/following/:userId` | None | 200 | Following list |
| GET | `/api/v1/social/follow/followers/:userId` | None | 200 | Followers list |
| GET | `/api/v1/social/notifications` | JWT | 200 | Notifications; ?unread=true filter |
| POST | `/api/v1/social/notifications/read` | JWT | 200, 400 | Mark as read (batch) |
| POST | `/api/v1/social/moderation/:postId/report` | JWT | 201, 400, 404, 409 | Report post |
| POST | `/api/v1/social/eternitas/verify` | Service | 200, 400 | Add verified badge |
| DELETE | `/api/v1/social/eternitas/verify` | Service | 200, 400 | Remove verified badge |
| POST | `/api/v1/social/eternitas/webhook` | Service | 200, 400, 401 | Passport lifecycle events; HMAC verification |
| GET | `/api/v1/social/dashboard-summary` | JWT | 200 | Quick panel: recent posts, contacts, unread counts |
| GET | `/api/v1/social/ecosystem-status` | JWT | 200 | Cross-product view: chat stats + ecosystem products |
| GET | `/api/v1/social/profile/:userId` | JWT | 200 | Enriched profile: posts, followers, Eternitas passport |

**Total: 25 endpoints**

---

## Translation Service (K9, port 8106)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | Translate server URL, cache status |
| POST | `/api/v1/translate` | JWT | 200, 400, 429 | Translate text; 24h cache; 100/min rate limit |
| GET | `/api/v1/translate/preferences` | JWT | 200 | User language preference |
| POST | `/api/v1/translate/preferences` | JWT | 200, 400 | Set language preference |
| PUT | `/_matrix/app/v1/transactions/:txnId` | HS Token | 200 | Synapse appservice events (disabled by default) |
| GET | `/_matrix/app/v1/rooms/:roomAlias` | HS Token | 404 | Appservice room query |
| GET | `/_matrix/app/v1/users/:userId` | HS Token | 404 | Appservice user query |
| POST | `/_matrix/app/v1/rooms/:roomId/languages` | None | 200, 400 | Set room language preferences |

**Total: 8 endpoints**

---

## Media Service (K4, port 8107)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | Storage path, sharp, ffmpeg status |
| POST | `/api/v1/media/upload` | JWT | 201, 400, 413 | Upload file (50MB max); image/video thumbnails |
| GET | `/api/v1/media/:id` | None | 200, 404 | Serve file with Content-Type |
| GET | `/api/v1/media/:id/thumbnail` | None | 200, 404 | Serve 200x200 JPEG thumbnail |

**Total: 4 endpoints**

---

## Call History Service (K5, port 8108)

| Method | Path | Auth | Status Codes | Notes |
|--------|------|------|-------------|-------|
| GET | `/health` | None | 200 | Service status |
| POST | `/api/v1/calls/log` | JWT | 201, 400 | Log call (voice/video); quality score 0-5 |
| GET | `/api/v1/calls/history` | JWT | 200 | Paginated history (limit/offset); direction labels |
| GET | `/api/v1/calls/stats` | JWT | 200 | Total calls, minutes, avg duration, calls today |

**Total: 4 endpoints**

---

## Grand Total

| Service | Endpoints |
|---------|-----------|
| Onboarding (K2) | 20 |
| Directory (K3) | 8 |
| Push Gateway (K6) | 6 |
| Backup (K8) | 5 |
| Social (K10) | 25 |
| Translation (K9) | 8 |
| Media (K4) | 4 |
| Call History (K5) | 4 |
| **Total** | **80** |
