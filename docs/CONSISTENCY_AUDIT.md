# Cross-Service Consistency Audit

> Verifies all 8 services follow the same patterns.
> Original audit date: 2026-03-31
> **Last Verified: 2026-04-03**

---

## 1. Shared jwt-verify.js Middleware

**Result: ALL SERVICES USE IT** ✓

| Service | Import Path | Auth Pattern |
|---------|-------------|-------------|
| Onboarding | `../shared/jwt-verify` | `createAuthMiddleware()` as route-level + global |
| Directory | `../shared/jwt-verify` | `createAuthMiddleware()` as global on `/api/v1/chat/directory` |
| Push Gateway | `../shared/jwt-verify` | `createAuthMiddleware()` per-route (Matrix endpoint has none) |
| Backup | `../shared/jwt-verify` | `createAuthMiddleware()` per-route |
| Social | `../shared/jwt-verify` | `createAuthMiddleware()` per-route |
| Translation | `../shared/jwt-verify` | `createAuthMiddleware()` per-route |
| Media | `../shared/jwt-verify` | `createAuthMiddleware()` per-route |
| Call History | `../shared/jwt-verify` | `createAuthMiddleware()` per-route |

**No deviations.**

---

## 2. Shared cors.js Config

**Result: ALL SERVICES USE IT** ✓

| Service | Import | Applied |
|---------|--------|---------|
| Onboarding | `../shared/cors` | `app.use(cors(createCorsOptions()))` |
| Directory | `../shared/cors` | `app.use(cors(createCorsOptions()))` |
| Push Gateway | `../shared/cors` | `app.use(cors(createCorsOptions()))` |
| Backup | `../shared/cors` | `app.use(cors(createCorsOptions()))` |
| Social | `../shared/cors` | `app.use(cors(createCorsOptions()))` |
| Translation | `../shared/cors` | `app.use(cors(createCorsOptions()))` |
| Media | `../shared/cors` | `app.use(cors(createCorsOptions()))` |
| Call History | `../shared/cors` | `app.use(cors(createCorsOptions()))` |

**No deviations.**

---

## 3. Shared health.js Endpoint

**Result: ALL SERVICES USE IT** ✓

All return: `{ status: "ok", service: "<name>", version: "1.0.0", uptime, uptimeMs, timestamp }`

| Service | Service Name | Has Dependency Checks |
|---------|-------------|----------------------|
| Onboarding | `windy-chat-onboarding` | Yes (Twilio, SendGrid, Redis, Synapse) |
| Directory | `windy-chat-directory` | Yes (Twilio, SendGrid) |
| Push Gateway | `windy-chat-push-gateway` | Yes (FCM, APNs, token count) |
| Backup | `windy-chat-backup` | Yes (R2 status, user count) |
| Social | `windy-chat-social` | No |
| Translation | `windy-chat-translation` | Yes (translate server URL, cache) |
| Media | `windy-chat-media` | Yes (storage path, sharp, ffmpeg) |
| Call History | `windy-chat-call-history` | No |

**Deviation: Social and Call History have no dependency checks.** Minor — these services have no external dependencies to report.

---

## 4. windy_identity_id Extraction from JWT

**Result: AUTOMATICALLY AVAILABLE VIA MIDDLEWARE** ✓

The shared `jwt-verify.js` middleware sets `req.user = decoded` which includes `windy_identity_id` from the JWT payload. All services have access via `req.user.windy_identity_id`.

**Storage in databases:**

| Service | Stored | Indexed |
|---------|--------|---------|
| Onboarding | `user_profiles.windy_identity_id` | ✓ Yes |
| Directory | `user_directory.windy_identity_id` | ✓ Yes |
| Social | `posts.windy_identity_id` | ✓ Yes |
| Backup | `backup_registry.windy_identity_id` | ✓ Yes |
| Translation | `user_preferences.windy_identity_id` | ✓ Yes |
| Media | `media.windy_identity_id` | ✓ Yes (idx_media_windy_identity_id) |
| Call History | `call_log.caller_windy_identity_id` | ✓ Yes (idx_call_log_caller_windy, idx_call_log_callee_windy) |
| Push Gateway | Not stored | N/A (per-device tokens) |

**No deviations.** All services now have indexes on `windy_identity_id` (fixed 2026-04-03).

---

## 5. JWT Rejection Consistency (401 format)

**Result: ALL SERVICES CONSISTENT** ✓

All services return the same error format on JWT failure:

```json
{ "error": "Missing Authorization header" }    // no JWT
{ "error": "Invalid or expired token" }         // bad/expired JWT
```

Verified by hardening test `test_auth_hardening.js` (40 tests across all 8 services).

**No stack traces leaked.** Error responses contain only the `error` field.

---

## 6. SQLite WAL Mode

**Result: ALL DATABASES USE WAL** ✓

| Service | DB File | WAL Pragma |
|---------|---------|-----------|
| Onboarding | `onboarding.db` | `db.pragma('journal_mode = WAL')` |
| Directory | `directory.db` | `db.pragma('journal_mode = WAL')` |
| Social | `social.db` | `db.pragma('journal_mode = WAL')` |
| Backup | `backup.db` | `db.pragma('journal_mode = WAL')` |
| Translation | `translation.db` | `db.pragma('journal_mode = WAL')` |
| Media | `media.db` | `db.pragma('journal_mode = WAL')` |
| Call History | `call-history.db` | `db.pragma('journal_mode = WAL')` |
| Push Gateway | `push-gateway.db` | `db.pragma('journal_mode = WAL')` |

**No deviations.**

---

## Summary of Deviations

| # | Issue | Severity | Action |
|---|-------|----------|--------|
| 1 | Social and Call History `/health` have no dependency checks | Low | Could add SQLite status check |
| 2 | ~~Media `windy_identity_id` column has no index~~ | ~~Low~~ | **FIXED** — `idx_media_windy_identity_id` added |
| 3 | ~~Call History `caller_windy_identity_id` has no index~~ | ~~Low~~ | **FIXED** — `idx_call_log_caller_windy` + `idx_call_log_callee_windy` added |

**Overall: High consistency across all services. No critical deviations.**
