# Security Posture — Adversarial Audit

Not a feel-good ship-readiness review. What an attacker with read access
to this repo could actually do against a fresh prod deploy.

## Summary

| Area | Verdict |
|---|---|
| JWT validation | Mostly OK. alg=none rejected. HS256 fallback is a shared-secret blast-radius risk. |
| HMAC webhook verification | OK functionally. THREE separate endpoints for Eternitas events with different secrets. Producer-side config in .env.example points at only one of them. |
| CORS | Brand-drifted allowlist. `windyword.ai` subdomains not covered. |
| Rate limiting | Per-service global limiter + per-route sensitive limiters. Trust-gate endpoints NOT rate-limited (could DoS Eternitas). |
| Auth coverage | Most routes behind auth. ANY authed user can inject directory rows (P0). |
| SQL injection | All queries are prepared statements (`db.prepare(...)`). Clean. |
| XSS | Very little server-side HTML rendering. `stripHtml()` regex scrubs display names. OK. |
| SSRF | Link-preview has naive hostname pattern check with documented bypass vectors. Feature is currently shadowed (not reachable) — dormant risk. |
| Open redirect | None found. No user-controlled redirects in code. |
| Secrets in logs | Grep-clean — token/secret/password strings appear only in field-name usage, not value-log paths. |

## Details

### JWT — the HS256 fallback is the real concern

`services/shared/jwt-verify.js` tries RS256 against the Windy Pro JWKS
first; if JWKS fetch fails, falls back to HS256 with `WINDY_JWT_SECRET`.
This means the shared HS256 secret is itself a valid auth path alongside
the RS256/JWKS chain.

- Live probe (after rate-limit cool-down): `alg=none` tokens → 401.
  Good — `jsonwebtoken` v9 rejects by default.
- Live probe: `Bearer ` (empty) → 401.
- If `WINDY_JWT_SECRET` leaks (dev machine, CI log, old Slack message),
  the attacker can mint arbitrary user identities across every chat
  service. There's also a static `CHAT_API_TOKEN` that grants a hardcoded
  `{sub:'service',role:'service'}` identity — same blast radius if it
  leaks.
- `.env.example` line 14 calls this out: `WINDY_JWT_SECRET=must_match_account_server_jwt_secret`
  — so the secret is shared across TWO repos. Leak in either = compromise
  of both.

**Recommendation**: fix the CI coverage gap and add an explicit test that
HS256 is NOT accepted in production mode. Also consider retiring the
HS256 fallback once JWKS is stable — it only exists "for development."

### HMAC webhooks — THREE endpoints, one producer

Four Eternitas webhook handlers exist:

| Path | Service | Secret env var | Wave |
|---|---|---|---|
| `/api/v1/webhooks/eternitas` | social | `ETERNITAS_WEBHOOK_SECRET` | pre-Wave-2 |
| `/api/v1/chat/provision/eternitas/webhook` | onboarding | `ETERNITAS_WEBHOOK_SECRET` | pre-Wave-2 |
| `/api/v1/webhooks/passport/revoked` | onboarding | `ETERNITAS_WEBHOOK_SECRET` | Wave 2 |
| `/api/v1/webhooks/trust/changed` | onboarding | `ETERNITAS_WEBHOOK_SECRET` | Wave 4 |

`.env.example` line 45: `ETERNITAS_WEBHOOK_URL=https://chat.windyword.ai/api/v1/webhooks/eternitas`
— points at the social one. So:

1. Eternitas fires → social `/api/v1/webhooks/eternitas` → deactivates
   Matrix user via Synapse admin + flips the social `verifiedAccounts`
   set.
2. But my Wave 4 trust-cache flush code lives in onboarding's `webhooks.js`.
   Eternitas never calls it. The trust-client cache in directory stays
   stale until its 5-min TTL.

The Wave 4 claim "passport revocation flushes trust cache synchronously"
is technically true if Eternitas calls the onboarding endpoint, but the
config says it calls the social one. Producer and consumer disagree.

Fix options:
- Re-point `ETERNITAS_WEBHOOK_URL` to the onboarding endpoints (breaks
  social's flow)
- Or add the `invalidateTrustCache(passport)` call to social's webhook
  handler
- Or have Eternitas fan out to every subscriber path

Second HMAC hazard: all three handlers accept a missing-signature
"skip verify" fallback when `ETERNITAS_WEBHOOK_SECRET` is empty and
`NODE_ENV !== 'production'`. If `NODE_ENV` isn't explicitly set in prod
(e.g. someone runs `pm2 start` without setting it), webhooks accept any
payload unauthenticated.

### HMAC prefix handling

Wave 5 fix: `sha256=<hex>` prefix is now stripped in onboarding's
`verifyHmac`. Good.

But **social's `/api/v1/webhooks/eternitas` still expects bare hex**:

```js
// services/social/routes/eternitas-webhook.js:29
const signature = req.headers['x-eternitas-signature'];
...
if (signature.length !== expected.length) return false;
return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
```

Eternitas's live webhook format is `sha256=<hex>` per
`eternitas/docs/webhooks.md`. Social's signature check will reject every
real-Eternitas-signed webhook. The shim I added in onboarding/webhooks.js
is the ONLY place that accepts the live format.

### CORS allowlist is brand-drifted

`services/shared/cors.js:8-18`:

```
https://windypro.com
https://windychat.com
https://chat.windyword.ai
https://windyword.ai
```

Missing: `https://mail.windyword.ai`, `https://clone.windyword.ai`,
`https://fly.windyword.ai`, `https://code.windyword.ai`. Since ecosystem
services increasingly XHR into Chat's REST API, expect CORS rejections
for cross-product calls from the sibling hosts.

Localhost bypass is wide: `/^http:\/\/localhost(:\d+)?$/.test(origin)` —
any port in non-production is allowed with `credentials: true`. Fine for
dev, but combine with any `.env` with `NODE_ENV` left as `development` in
a prod container and suddenly a local browser can hit prod Chat API with
credentials.

### Rate limiting — trust gates unprotected

Every service has a global limiter:
- onboarding: 100 req/min per IP (server.js:52)
- directory: 60 req/min
- push-gateway: 100 req/min
- backup: 60 req/min

Sensitive per-route limits:
- `/api/v1/onboarding/agent`: 10 req/min
- `/api/v1/chat/verify/send`: 10/min + hourly cap
- `/api/v1/chat/pair/generate`: per-route
- link-preview: 30/min
- push register: 10/min

**Missing per-route limits:**
- `/api/v1/chat/directory/agents/gate/dm`, `/broadcast`, `/mention` —
  each gate call makes 1-2 Eternitas GETs. Eternitas is rate-limited to
  100 req/min/IP on its side. If a single authenticated bot bursts 200
  gate calls in a minute, Chat chews through Eternitas's IP budget and
  starts getting 429s — which the gate translates to `trust_api_unreachable`
  (fail-closed) — legitimate traffic in the same deploy gets denied for
  up to 5 minutes while the cache populates.
- `/api/v1/chat/directory/agents/register` — per P0 below, this is a
  directory-poisoning vector. Needs both service-token auth AND a rate
  limit.
- `/api/v1/push/notify` — no per-route limit beyond the global. A
  compromised Mail/Chat service could blast notifications at users.

### Auth — directory/agents/register is the big hole

**P0**: `POST /api/v1/chat/directory/agents/register`
(`services/directory/routes/agents.js:154`) is mounted behind
`authMiddleware` but does no service-token gating. Any authenticated
human can:

```bash
TOKEN=<a valid Pro JWT>
curl -X POST https://chat.windyword.ai/api/v1/chat/directory/agents/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"passport_number":"ET26-FAKE","agent_name":"Totally Real Bot",
       "trust_score":999,"clearance_level":"top_secret",
       "description":"Trust me bro","avatar_url":"..."}'
```

Response: 201 Created. The agent is now listed on the Discover page with
trust_score=999 and clearance_level=top_secret. Users see "verified" UI
chrome on a bot that never touched Eternitas.

The ACTION gates (`/gate/dm`, `/gate/broadcast`, `/gate/mention`) still
re-verify via Eternitas before authorizing anything — so the bot can't
actually send broadcasts. But the directory UI is a social-engineering
weapon: fake "Anthropic Official Bot" listed with 999 score next to
actual Anthropic bot.

Live-probed, reproduced. See GAP_ANALYSIS P0 #2.

### SQL injection

No string concatenation or template interpolation in any query across
services/**. All queries use `db.prepare(sql).run({...})` or `.get(...)`
with named parameters. Clean.

### XSS

Backend renders JSON. The `web/` SPA is React which escapes by default.
One caveat: `Content-Disposition` header in `services/media/server.js:396`
sets `filename="${record.original_name}"` with no sanitization — an
uploaded file named `bad.jpg\r\nX-Injected: yes` could inject headers.
(The upload path uses multer diskStorage with generated `media_<uuid>`
names for the actual filename on disk, but `original_name` is stored as
provided.) P2.

### SSRF — link-preview

`services/media/routes/link-preview.js:40-56` checks hostname against
pattern allowlist:

```js
const privatePatterns = [
  /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./, /^0\./, /^169\.254\./, /^fc00:/i, /^fd/i, /^fe80:/i,
  /^::1$/, /^\[::1\]$/,
];
```

Documented bypass vectors:

1. **DNS rebinding** — attacker's domain resolves to a public IP at check
   time, then re-resolves to `127.0.0.1` / `169.254.169.254` when Node
   actually fetches. Classic attack, fully bypasses hostname-based check.
2. **IPv6-mapped IPv4** — `[::ffff:127.0.0.1]` or
   `[0:0:0:0:0:ffff:7f00:1]` — not matched by any pattern.
3. **Integer/hex IP encodings** — `http://2130706433/` or
   `http://0x7f000001/` — not matched.
4. **Cloud metadata hostnames** not in the list: `metadata.google.internal`,
   `metadata.azure.com`, ECS task metadata endpoint `169.254.170.2`
   (the ECS v2 one is covered by `/^169\.254\./`, but the Google/Azure
   ones aren't).
5. **Redirect chain** — validateUrl is called on redirects (line 104) but
   the pattern is still hostname-string-based, so DNS rebinding applies
   there too.

Good news: the route is currently shadowed by `/:id` (see GAP_ANALYSIS
P0 #1), so the SSRF is dormant. Fix the shadowing → SSRF becomes live.

Real fix: resolve the hostname to IP addresses server-side (DNS lookup),
validate EACH resolved IP against a deny-list that includes IPv4, IPv6,
and IPv6-mapped forms, AND refetch on redirect. Look at Node's
`dns.lookup` with `all: true` and iterate.

### Open redirects

No `res.redirect(user_input)` patterns found. Clean.

### Secrets in logs

Grep of `console.log.*(secret|token|password|key)`: all hits are
field-name contexts ("push token registered", "signing key path"), not
value logs. Clean.

### Error surface

Two live-probed 500s where 4xx is expected:

- Oversized body (> 5MB limit) → 500 `Internal server error` instead of
  413. Body-parser's `entity.too.large` propagates to the express default
  error handler (the one after sentryErrorHandler on server.js:228)
  which blindly returns `{error: 'Internal server error'}`. Attacker
  signal: any 500 is noise in the logs and normal rejection is
  impossible to distinguish from crash behavior.
- Malformed JSON → 500 instead of 400. Same cause.

Fix: either attach `{ limit, verify }` options that set clean 413 / 400,
or teach the error handler to check `err.type === 'entity.too.large'` /
`entity.parse.failed` and translate.

### Info leak in trust-gate 403s

Gate-denial responses (`missing_allowed_action`, `passport_not_found`)
include the full Eternitas profile in the response body:

```json
{
  "allowed": false, "reason": "missing_allowed_action",
  "profile": {
    "integrity_score": 700,
    "dimensions": {"honesty": 700, "reliability": 700, ...},
    "tier_multiplier": 1.0,
    ...
  }
}
```

A rejected caller learns the exact integrity score and dimensional
breakdown, which enables targeted gaming ("what's my reliability
score?"). Responders should be `{allowed, reason, required}` only —
profile body is caller's responsibility to fetch if they need it.

### Fail-open HMAC in non-production

`services/onboarding/routes/webhooks.js:67` prints a warning and allows
the webhook through when `ETERNITAS_WEBHOOK_SECRET` or
`WINDY_IDENTITY_WEBHOOK_SECRET` is empty AND `NODE_ENV !== 'production'`.
Same pattern in:

- `services/onboarding/routes/provision.js:367-372`
- `services/social/routes/eternitas-webhook.js:207-210`

Any container deployed without `NODE_ENV=production` explicitly set
(common foot-gun — Dockerfile defaults matter, `pm2` defaults matter)
will accept unauthenticated revoke-the-world webhook calls.
