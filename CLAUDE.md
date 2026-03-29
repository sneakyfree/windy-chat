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
2. Federation is DISABLED — this is a Windy-users-only network (chat.windypro.com)
3. Push notification bodies NEVER contain message text (privacy)
4. Backup encryption keys are client-derived (PBKDF2) — server is zero-knowledge
5. Chat client code stays in windy-pro/windy-pro-mobile — this repo is backend only
