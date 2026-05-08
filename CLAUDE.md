# Windy Chat — AI Context File

This file is automatically loaded by Claude Code / AntiGravity at conversation start.
It contains critical project knowledge that prevents regressions.

## ⚠️ ECOSYSTEM CONTEXT (READ FIRST)

This repo (`windy-chat`) is the **comms hub** of the Windy ecosystem — Synapse (Matrix) homeserver + 4 Node.js microservices + push-gateway, deployed on EC2 instance `i-0f603361b88baa4c0` at chat.windychat.ai. Consumer brand is **Windy Chat** (1:1 with the dev-name). It is one of 13 canonical Windy platforms plus Eternitas + the Authenticator + various infrastructure pieces.

**Before working on this repo, load the ecosystem context:**

1. **`~/kit-army-config/docs/adr-010-vision-aligned-engineering-invariants-2026-05-08.md`** — the canonical alignment doc. 13 platforms permanent, dual-shell coexistence, mobile-first, voice-as-API, BYOM via Windy Mind, no-stopwatch ethos. **READ THIS FIRST.**
2. **`~/kit-army-config/docs/adr-011-eternitas-universal-agent-identity-registry.md`** — Eternitas is an independent Utah LLC; agents get a Matrix handle auto-provisioned at passport issuance.
3. **`~/kit-army-config/docs/adr-012-windy-mobile-mvno-os-hardware.md`** — long-term Windy Mobile vision (deferred until ecosystem maturity).
4. **`~/kit-army-config/docs/windy-search-bot-traffic-monetization.md`** — proto-Google-for-agents thesis (strategic context).
5. **`~/kit-army-config/ACCESS_LOCKBOX.md`** — credentials lockbox (private repo). Source of truth for all secrets, AWS keys, API tokens, deploy commands.
6. **`~/.claude/projects/-Users-thewindstorm/memory/MEMORY.md`** — auto-loaded persistent memory. Critical entries for this repo: `project_windy_chat_phase4_state` (EC2 i-0f603361b88baa4c0 NOT dormant; broken bits = custom modules + stale eternitas URL) + `feedback_windy_chat_compose_invocation` (compose needs both `-f docker-compose.yml -f docker-compose.prod.yml` and `--env-file .env.production`).

**Dev-name ↔ consumer-brand mapping (don't conflate):**
- `sneakyfree/windy-chat` = "Windy Chat" (this product, 1:1)
- `sneakyfree/windy-pro` = "Windy Word" (hub / account-server — also hosts the chat client)
- `sneakyfree/windy-agent` = "Windy Fly" (agent)

**Sister repos most relevant to this one:**
- `windy-pro` — account-server is the identity authority; this repo has NO user database. Matrix accounts are provisioned via Synapse admin API from windy-pro.
- `windy-pro-mobile` — chat *client* lives there (and in windy-pro desktop). This repo is backend-only.
- `eternitas` — passport-revoked webhooks land at onboarding:8101; bots are auto-provisioned a Matrix handle at hatch.
- `windy-agent` — every Windy Fly hatch auto-provisions a chat handle via this repo's onboarding service.
- `windy-mail` — escalate chat → email, shared contacts; mail-aligned localparts (`grant.whitmer` for Matrix matches `grant.whitmer@windymail.ai`).

When making cross-product engineering calls, default to **kit-army-config docs as canonical**. Repo-specific notes (architecture, API contracts, ports, terminology) follow below.

---

# Windy Chat — Developer Quick-Start

## What is this?

Windy Chat backend — the server infrastructure for the Windy ecosystem's messaging + social platform. This repo contains:
- 4 Node.js microservices (onboarding, directory, push-gateway, backup)
- Synapse (Matrix) homeserver deployment config
- Docker Compose for the full chat infrastructure stack

## What is NOT in this repo

- **Chat client code** — lives in windy-pro (desktop) and windy-pro-mobile (mobile)
- **Identity/auth** — managed by windy-pro's account-server
- **Translation engine** — managed by windy-pro's translate-api service
- **Matrix client SDK usage** — that's in the client repos (matrix-js-sdk)

## Architecture

The chat backend has no user database of its own. It delegates identity to windy-pro's account-server:
- Users register on Windy Pro → account-server provisions a Matrix account via Synapse admin API
- Chat services validate JWTs issued by the account-server
- The custom Synapse module (`windy_registration.py`) enforces this — direct Matrix registration is disabled

## Key API Contracts (calling back to windy-pro)

```
POST /api/v1/identity/chat/provision  → Creates Matrix account for user
GET  /api/v1/identity/chat/profile    → Returns chat profile (never exposes access token)
POST /api/v1/identity/eternitas/webhook → Bot passport events (provision/revoke chat)
```

## Push-side Webhooks (Wave 2)

Chat receives identity lifecycle events directly so it can provision eagerly
(no wait for the client to call /unified-login). HMAC-SHA256 verified.

```
POST /api/v1/webhooks/identity/created   (onboarding:8101, X-Windy-Signature)
POST /api/v1/webhooks/passport/revoked   (onboarding:8101, X-Eternitas-Signature)
```

Matrix localparts from identity/created are mail-aligned — `grant.whitmer`
for Matrix lines up with `grant.whitmer@windymail.ai`.

## Shared Notification Bus

```
POST /api/v1/push/notify                 (push-gateway:8103, X-Push-Bus-Token)
Body: { windy_identity_id, event_type, title, body, deep_link?, subscribers_only? }
```

Canonical publish endpoint for every Windy service — Mail, Chat homeserver,
Clone, Fly, and Code all publish here. The gateway fans out to every device
the user has registered (FCM/APNs/Web Push). Set `subscribers_only: true`
when the caller has already delivered device push via another path
(e.g. Synapse's native `/_matrix/push/v1/notify`) — the bus then only
dispatches to cross-service subscribers.

## Synapse Push-Bus Module (Wave 3)

`deploy/synapse/windy_push_bus.py` hooks Synapse's `on_new_event` callback
and republishes every `m.room.message` / `m.room.encrypted` event to the
shared bus with `subscribers_only: true`. Additive — does NOT replace the
native Matrix push gateway. Wired in `homeserver.yaml` alongside
`windy_registration`.

## Trust Gates (Wave 3)

Directory service enforces three gates on bot actions:

```
POST /api/v1/chat/directory/agents/gate/dm        (bot→bot DM)
POST /api/v1/chat/directory/agents/gate/broadcast (bot→public)
POST /api/v1/chat/directory/agents/gate/mention   (bot→disconnected human)
```

Humans (Pro JWT, no `passport_id` claim) bypass all three. Bots are checked
against their Eternitas trust profile via `services/shared/trust-client.js`
(5-min Redis cache, in-memory fallback). Full rules in
`services/directory/docs/trust-gates.md`.

The account-server base URL defaults to: `http://localhost:8098`
Set via env var: `WINDY_ACCOUNT_SERVER_URL`

## Running Locally

```bash
# 1. Start Synapse infrastructure
cd deploy/synapse && docker-compose up -d

# 2. Start services (each in its own terminal)
cd services/onboarding && npm install && npm run dev   # Port 8101
cd services/directory && npm install && npm run dev     # Port 8102
cd services/push-gateway && npm install && npm run dev  # Port 8103
cd services/backup && npm install && npm run dev        # Port 8104
```

## Service Ports

| Service | Port | Description |
|---------|------|-------------|
| Synapse | 8008 | Matrix homeserver |
| Onboarding | 8101 | Phone/email verification, QR pairing |
| Directory | 8102 | Contact discovery |
| Push Gateway | 8103 | FCM/APNs push notifications |
| Backup | 8104 | Encrypted cloud backup |

## Terminology

- "Strand K" = the DNA Strand master plan section for Windy Chat
- "K1" = Synapse homeserver, "K2" = onboarding, "K3" = directory, etc.
- Users never see "Matrix" — it's always "Windy Chat"
- Bots are called "agents" or "Windy Fly" — never "bots" in user-facing text

## Critical Invariants

1. Direct Matrix registration is DISABLED — all accounts go through windy-pro account-server
2. Federation is DISABLED — this is a Windy-users-only network (chat.windychat.ai)
3. Push notification bodies NEVER contain message text (privacy)
4. Backup encryption keys are client-derived (PBKDF2) — server is zero-knowledge
5. Chat client code stays in windy-pro/windy-pro-mobile — this repo is backend only

## Branching Policy Exception — wave-7-batch-only (2026-04-17)

One-time exception: Bucket A PRs from docs/MERGE_TRIAGE.md are
self-merged by the automation handling the Wave-7 audit batch
(`gh pr merge <num> --squash --delete-branch --admin`). This applies
ONLY to the five Bucket A PRs listed in that doc and ONLY for this
batch. Default Branching Policy (review required before merge) resumes
immediately after. Bucket B also self-merges but each runs the full
integration suite between merges and reverts on regression.
