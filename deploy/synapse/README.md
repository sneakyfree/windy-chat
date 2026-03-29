# Windy Chat — Synapse Homeserver Deployment

**DNA Strand K1**: Our Own Matrix Homeserver

This directory contains everything needed to deploy the Windy Chat Matrix homeserver — a self-hosted Synapse instance that provides the messaging backbone for Windy Chat.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Windy App  │────▶│    Nginx     │────▶│   Synapse    │
│  (Desktop /  │     │  (SSL/Proxy) │     │ (Homeserver) │
│   Mobile)    │     └──────────────┘     └──────┬───────┘
└──────────────┘                                 │
                                    ┌────────────┼────────────┐
                                    ▼            ▼            ▼
                              ┌──────────┐ ┌─────────┐ ┌──────────┐
                              │ Postgres │ │  Redis  │ │  Coturn  │
                              │   (DB)   │ │ (Cache) │ │  (TURN)  │
                              └──────────┘ └─────────┘ └──────────┘
```

## Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `synapse` | `matrixdotorg/synapse:latest` | 8008 | Matrix homeserver |
| `synapse-db` | `postgres:16-alpine` | 5432 | Synapse database |
| `synapse-redis` | `redis:7-alpine` | 6379 | Worker coordination |
| `coturn` | `coturn/coturn:latest` | 3478, 5349 | TURN server (VoIP NAT traversal) |
| `synapse-nginx` | `nginx:1.25-alpine` | 443, 8448 | Reverse proxy + SSL |

## Prerequisites

- Docker Engine 24+ and Docker Compose V2
- A server with:
  - 2+ CPU cores, 4GB+ RAM
  - 50GB+ disk for media storage
  - Ports 80, 443, 3478, 5349, 8448 open
- DNS records configured:
  - `A` record: `chat.windypro.com` → server IP
  - `SRV` record: `_matrix._tcp.windypro.com` (optional, for federation)
- Let's Encrypt SSL certificate (or Cloudflare Origin cert)

## Quick Start

### 1. Clone and navigate

```bash
cd deploy/synapse/
```

### 2. Configure environment

```bash
cp .env.example .env   # or let setup.sh create it
# Edit .env with real secrets:
#   SYNAPSE_DB_PASSWORD      — PostgreSQL password
#   SYNAPSE_REGISTRATION_SECRET — shared secret for account provisioning
#   TURN_SHARED_SECRET       — Coturn ↔ Synapse shared secret
#
# Generate secrets with: openssl rand -hex 32
```

### 3. Place SSL certificates

```bash
# Option A: Let's Encrypt (recommended)
certbot certonly --standalone -d chat.windypro.com
# Copy certs to the synapse_certs volume

# Option B: Self-signed (development only)
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout privkey.pem \
  -out fullchain.pem \
  -subj "/CN=chat.windypro.com"
```

### 4. Run setup

```bash
chmod +x setup.sh
./setup.sh
```

The script will:
1. Check prerequisites (Docker, Compose)
2. Generate Synapse signing keys
3. Create Coturn configuration
4. Start PostgreSQL and wait for readiness
5. Copy generated files to Docker volumes
6. Start all services

### 5. Verify

```bash
# Check Synapse health
curl http://localhost:8008/health

# Check well-known endpoints
curl https://chat.windypro.com/.well-known/matrix/client
curl https://chat.windypro.com/.well-known/matrix/server

# View logs
docker compose logs -f synapse
```

## Custom Registration (windy_registration.py)

Direct Matrix registration is **disabled**. Users register through the Windy Pro account server:

```
User → Windy App → POST /api/v1/auth/chat-register → Account Server (H1)
                                                         │
                                                         ▼
                                               Synapse Admin API
                                               (with shared secret)
                                                         │
                                                         ▼
                                              Matrix account created
                                              Display name set from
                                              Windy Pro profile
```

The `windy_registration.py` module:
- Validates login credentials against H1 (`localhost:8098`)
- Maps Windy display names to Matrix user IDs
- Hides raw `@windy_xyz:chat.windypro.com` identifiers from the UI
- Auto-provisions Matrix accounts on first login

## Configuration Reference

### homeserver.yaml

| Setting | Value | Rationale |
|---------|-------|-----------|
| `server_name` | `chat.windypro.com` | Our domain |
| `enable_registration` | `false` | Custom registration only (K2) |
| `max_upload_size` | `100M` | Media sharing support (K4) |
| `federation` | Disabled | Windy-users-only network (initially) |
| `database` | PostgreSQL | Production-grade backend |
| `redis` | Enabled | Worker coordination |
| `media_store_path` | `/data/media_store` | Persistent storage |
| `retention` | 365 days | Default message retention |

## Operations

### Logs
```bash
docker compose logs -f synapse       # Synapse logs
docker compose logs -f synapse-db    # PostgreSQL logs
docker compose logs -f coturn        # TURN server logs
```

### Stop / Start
```bash
docker compose down                  # Stop all services
docker compose up -d                 # Start all services
docker compose restart synapse       # Restart Synapse only
```

### Backup
```bash
# Database backup
docker compose exec synapse-db pg_dump -U synapse synapse > backup.sql

# Media store backup (consider R2 sync — K8)
docker compose cp synapse:/data/media_store ./media_backup/
```

### Update Synapse
```bash
docker compose pull synapse
docker compose up -d synapse
```

## Monitoring

Synapse exposes Prometheus metrics at `/_synapse/metrics` (internal only). Key metrics:
- `synapse_http_server_response_time` — API response times
- `synapse_storage_events` — events stored per second
- `synapse_federation_send_events` — federation activity (should be 0)
- `synapse_util_caches_cache_hits` — cache hit ratio

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Service definitions |
| `homeserver.yaml` | Synapse configuration |
| `windy_registration.py` | Custom auth module |
| `nginx.conf` | Reverse proxy config |
| `setup.sh` | Initialization script |
| `README.md` | This file |

## DNA Reference

- **Strand K1**: Our Own Matrix Homeserver
- **K1.1.1**: Docker Compose Configuration
- **K1.1.2**: Homeserver Configuration
- **K1.1.3**: Custom Registration Module
- **K1.1.4**: DNS & SSL
- **K1.2**: Custom User Identity (display name mapping)
