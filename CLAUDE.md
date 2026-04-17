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
2. Federation is DISABLED — this is a Windy-users-only network (chat.windyword.ai)
3. Push notification bodies NEVER contain message text (privacy)
4. Backup encryption keys are client-derived (PBKDF2) — server is zero-knowledge
5. Chat client code stays in windy-pro/windy-pro-mobile — this repo is backend only
