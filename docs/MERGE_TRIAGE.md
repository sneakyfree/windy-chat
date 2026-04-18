# Merge Triage — Wave 7 PR Queue

**Triaged**: 2026-04-17
**Open PRs**: 23 (#1–#23, all branched off `wave-7-gap-analysis`)
**Total cumulative diff if all land**: ~6,400 adds + 500 deletes ≈ **6,900 lines**
(PR #1 alone is ~5,720 lines — the Wave 2-6 work bundle + audit docs.
Subsequent PRs each add 30–340 incremental lines.)

The 23 PRs are a chain: #1 is the base (Wave 2-6 work + audit), #2–#23
each branch off it with one targeted fix. Until #1 merges, every other
PR shows the full stack in its diff view.

---

## Bucket A — MERGE NOW (5 PRs)

Pure fix, low blast radius, all tests green, no behavior change visible
to users. Can batch-merge without smoke-test.

- **#1** — GAP ANALYSIS — docs + the Wave 2-6 work bundle. No live code runs that isn't already behind service-token or HMAC. Every other PR depends on this being the base.
- **#6** — P0-5: unblock jest — stubs `jwks-rsa` at the jest layer only, fixes onboarding's `app` export. Zero production code change. Brings CI from 0 → 58 passing tests.
- **#16** — P2-6: stale `chat.windypro.com` regex — test-file-only fix, repairs 4 pre-existing failing assertions.
- **#18** — P2-2: CORS sibling subdomains — purely additive to the allowlist (`mail.windyword.ai`, `clone.windyword.ai`, etc.). Can't break an existing request.
- **#22** — P3-1: trust-cache telemetry — read-only counters on `/health`. No request path behavior change.

## Bucket B — SAFE WITH SMOKE (4 PRs)

Real fix that changes user-visible behavior but is well-tested and
reversible. Merge after a 5-min smoke-test in staging.

- **#8** — P1-4: body-parser 4xx translation — oversized/malformed bodies now return 413/400 instead of 500. Improves clarity; anyone relying on 500 for those is already broken. Smoke: hit each service with a malformed JSON body and confirm 400.
- **#10** — P1-9+10: env consistency + `ETERNITAS_URL` canonicalization — unifies variable names across services, default now `http://localhost:8500` instead of the production Eternitas URL. Smoke: confirm every deployed service has `ETERNITAS_URL` explicitly set (the changed default only bites if the var is unset).
- **#17** — P2-4: pair.js defaults to localhost — fixes a dev footgun. Pair sessions in dev no longer get a prod URL baked into the QR payload. Prod deploys already override.
- **#19** — P2-3: Content-Disposition filename sanitization — strips CR/LF + escapes quotes from user-supplied filenames. Smoke: download a file with a weird filename and confirm the header quoting is sane.

## Bucket C — HIGH RISK, NEEDS EYES (14 PRs)

Touches auth / webhooks / rate limits / identity / trust cache / Matrix
account provisioning. Review with a second pair of eyes before batch-
merging.

- **#2** — P0-1: unshadow `/api/v1/media/link-preview` — unlocks a route that was 404-ing. **Must merge paired with #15** (SSRF hardening) or you ship a live SSRF.
- **#3** — P0-4: `sha256=` prefix in social/provision HMAC verifiers — prerequisite for Eternitas webhooks landing at all in prod. **Top-3 must-merge.**
- **#4** — P0-3: trust-cache flush on passport revoke (social handler) — without this, revoked bots retain gate privileges for up to 5 min.
- **#5** — P0-2: gate `/agents/register` + Trust API re-verify — closes the directory-poisoning hole where any authed user could forge `trust_score:999` bots. **Top-3 must-merge.**
- **#7** — P1-5: strip full profile from gate 403s — removes info leak of internal scoring dimensions. Small response-shape change for callers that inspected `profile` field.
- **#9** — P1-8: fail-closed HMAC when secret unset — tightens webhook auth. Tests + CI must set `ETERNITAS_WEBHOOK_SECRET` + `WINDY_IDENTITY_WEBHOOK_SECRET` (they already do).
- **#11** — P1-3: flush social `eternitasVerifyCache` on revoke/reinstate — identity layer cache. Low blast radius (only the module's export graph changes).
- **#12** — P1-6: per-passport gate rate limit — adds 30/min/passport limit to gate routes. Could deny legitimate bots in retry loops; test in staging with a real bot.
- **#13** — P1-2: unified mail-aligned localpart — **changes the chat handle for brand-new users** from `@windy_grant` to `@grant.whitmer`. Existing users unaffected (DB lookup by `windy_identity_id` first). Confirm no downstream system (Mail, Clone, Fly) depends on the `windy_` prefix.
- **#14** — P1-1: `/unified-login` concurrency lock — serializes first-login bursts to prevent orphan Matrix accounts. **Top-3 must-merge.** Touches identity provisioning; single-process only.
- **#15** — P1-7: SSRF-hardened link-preview — must merge with #2. DNS-rebinding defense, IPv6-mapped IPv4, cloud metadata blocklist.
- **#20** — P2-5: require auth on `/social/presence/:userId` — breaks any unauthenticated caller. Confirm no frontend widget probes presence anonymously.
- **#21** — P2-1: retire legacy `/chat/provision/eternitas/webhook` (returns 410) — confirm Eternitas is NOT still configured against this URL. `.env.example` already points at the canonical social endpoint, so this should be a no-op in prod.
- **#23** — P3-2: scale gate rate limit by `tier_multiplier` — depends on #12. Tier-based budgets: POOR → 15/min, EXCEPTIONAL → 150/min.

## Bucket D — BLOCKED ON GRANT (0 PRs)

None. Every PR stands alone on its own technical merit. No UX choice,
AWS account, or product-policy decision gates merge.

## Bucket E — DEFER (0 PRs)

Nothing in the current queue is P3 polish that's merge-optional. The
one P3 item left open in the gap analysis (P3-3, retire HS256 JWT
fallback) has no PR — it needs a dedicated migration sprint before code
can ship. Documented as "not in this stack."

---

## TOP 3 MUST-MERGE BEFORE LAUNCH

Ranked by severity of real user pain at launch.

### 1. **#5 — P0-2: gate `/agents/register` + re-verify against Trust API**

**What breaks without it**: any authenticated user can POST to
`/agents/register` with `trust_score:999, clearance_level:top_secret`
and an arbitrary agent name, and that row shows up on the public
Discover page. Live-reproduced with a throwaway user JWT during the
audit — returned `201 Created` and the fake bot appeared in lookup.

**User pain**: a day-1 social-engineering vector. An attacker
registers "Anthropic Official" with `trust_score:999` next to the
real Anthropic bot. Users who click through the Discover page trust
the verified-looking row. The gates still enforce Eternitas on action
attempts, but the directory display lies.

### 2. **#3 — P0-4: accept `sha256=` prefix in social + provision HMAC verifiers**

**What breaks without it**: every live Eternitas webhook delivery
401s at `/api/v1/webhooks/eternitas` because the canonical format is
`X-Eternitas-Signature: sha256=<hex>` and social's verifier only
accepted bare `<hex>`. Confirmed against `eternitas/docs/webhooks.md`.

**User pain**: passport revocations never take effect in Chat.
Eternitas fires `passport.revoked`, we 401 it, the bad bot keeps its
Matrix account, keeps the verified badge, keeps broadcasting — up to
5 min worst case (trust-cache TTL), longer if the trust cache wasn't
being hit. Combined with the fix in #4, this is "revocation actually
works." Miss either one and the advertised safety guarantee is
vapor.

### 3. **#14 — P1-1: `/unified-login` concurrency lock**

**What breaks without it**: launch-day login storm = every first-time
user who happens to hit the server with two client retries in flight
mints 2+ Matrix accounts. Wave-7 concurrency test showed 20 parallel
`/unified-login` for the same identity produced 20 distinct
`access_token` values; only one profile row survived via `INSERT OR
REPLACE`, but 19 Matrix user IDs orphaned in Synapse.

**User pain**: immediate — the client receives `access_token` A but
our DB row maps their identity to `access_token` B's Matrix user. The
client tries to send a message with token A, Synapse authenticates
them as a ghost user that has no profile. "Chat doesn't work after I
log in." Synapse storage also fills with orphaned rooms/devices per
burst.

---

## Recommended merge order

1. **#1** (base) → enables every other PR to show only its own diff
2. **#6** (jest unblock) → downstream PRs' test suites actually run in CI
3. **Top-3** in order: **#5**, then **#3 + #4** paired (they're both "revocation works"), then **#14**
4. Rest of Bucket A (#16, #18, #22) — batch, no individual review needed
5. Bucket B (#8, #10, #17, #19) — 5-min smoke each
6. Remaining Bucket C — paired reviews; merge #2 and #15 together

With that order, the system is safe-to-ship by the end of Bucket C's
top-3. Everything after is polish + hardening that can trickle in.
