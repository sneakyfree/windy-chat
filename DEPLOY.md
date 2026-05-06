# Windy Chat — Production Deploy

Wave 9 Launch Prep. Covers bringing the Windy Chat backend (Synapse +
4 Node services + Social + Coturn + Postgres + Redis) up on a VPS
against the public Windy Pro identity hub.

The chat client code does **not** live in this repo — it ships with
`windy-pro` (desktop) and `windy-pro-mobile` (React Native). What you
deploy here is the homeserver, auth webhooks, directory, shared push
bus, social layer, and a TURN server for VoIP NAT traversal.

---

## 1. Target host

### Option A — Hostinger VPS (default)

- Host: `72.60.118.54` (existing KVM box used for the other Windy
  services).
- OS: Ubuntu 22.04 LTS, 4 vCPU / 8 GB RAM / 160 GB NVMe.
- Outbound: standard Hostinger networking (no egress filtering).
- Inbound ports required:
  - 80, 443 — nginx (client API + HTTPS termination)
  - 8448/tcp — Matrix federation (optional; keep closed while
    federation stays disabled)
  - 3478/udp+tcp, 5349/udp+tcp — Coturn
  - 49152–49200/udp — Coturn relay range
- Storage: Synapse media + Postgres WAL grow unbounded. Mount an
  extra 200 GB volume at `/var/lib/windy-chat` and point the Docker
  volumes there (see §3).

### Option B — Equivalent VPS (Hetzner CX32 / DO 4vCPU / Linode 4GB)

Any Linux VPS with the same capabilities works — the stack is
container-only. Requirements:

- 4 vCPU / 8 GB RAM minimum (Synapse single-process; shard workers
  if you grow past ~500 concurrent clients).
- Public IPv4 + IPv6 (IPv6 is required for AAAA records below).
- Docker Engine ≥ 24 and Docker Compose v2.
- `certbot` or Cloudflare Origin Certificates for TLS.

---

## 2. DNS records

All records point at the VPS's public IPs. Federation records are
**included but commented out** — flip them on only when
`federation_domain_whitelist` is populated (see §6).

```
# Primary client hostname
chat.windychat.ai.              A     <VPS_IPv4>
chat.windychat.ai.              AAAA  <VPS_IPv6>

# TURN / STUN
turn.windychat.ai.              A     <VPS_IPv4>
turn.windychat.ai.              AAAA  <VPS_IPv6>

# Federation (enable when turning federation on)
# _matrix._tcp.chat.windychat.ai. SRV 10 0 8448 chat.windychat.ai.
# matrix.windychat.ai.            A     <VPS_IPv4>
# matrix.windychat.ai.            AAAA  <VPS_IPv6>

# Well-known delegation served by nginx at
#   https://windychat.ai/.well-known/matrix/server →
#   {"m.server": "chat.windychat.ai:8448"}
# No DNS entry needed beyond the apex A/AAAA.
windychat.ai.                   A     <VPS_IPv4>
windychat.ai.                   AAAA  <VPS_IPv6>
```

> The homeserver's `server_name` is `chat.windychat.ai` in
> production. It matches `SYNAPSE_SERVER_NAME` in
> `.env.production` and `server_name:` in
> `deploy/synapse/homeserver.yaml`. Changing it later rewrites every
> Matrix ID — do not change it after the first user registers.

---

## 3. Docker Compose stack

Single stack, brought up from repo root:

```bash
cp .env.production.example .env.production
# fill in every REPLACE_ME — see §5
docker compose --env-file .env.production up -d
```

Services brought up by `docker-compose.yml`:

| Service        | Image                         | Port (host)   | Purpose                                    |
|----------------|-------------------------------|---------------|--------------------------------------------|
| synapse-db     | postgres:16-alpine            | (internal)    | Synapse primary DB                         |
| synapse-redis  | redis:7-alpine                | (internal)    | Synapse worker stream + OTP cache          |
| coturn         | coturn/coturn:latest          | 3478, 5349, 49152-49200/udp | TURN/STUN for VoIP           |
| synapse        | matrixdotorg/synapse:latest   | 8008          | Matrix homeserver                          |
| nginx          | nginx:alpine                  | 80, 443       | TLS termination + client API gateway       |
| onboarding     | services/onboarding (Node 20) | 8101          | Phone/email verify, QR pair, provisioning  |
| directory      | services/directory            | 8102          | Agent directory + trust gates              |
| push-gateway   | services/push-gateway         | 8103          | FCM/APNs/WebPush fan-out + shared bus      |
| backup         | services/backup               | 8104          | Zero-knowledge encrypted backup            |
| social         | services/social               | 8105          | Posts, follows, verified badges, presence  |
| translation    | services/translation          | 8106          | Inline message translation                 |
| media          | services/media                | 8107          | Link previews + media proxy (SSRF-hardened)|
| call-history   | services/call-history         | 8108          | VoIP session metadata                      |
| web            | services/web                  | (bundled)     | Static Windy Chat web client               |

### Persistent volumes

Mount these onto the extra 200 GB volume:

```
/var/lib/windy-chat/synapse       → /data on synapse
/var/lib/windy-chat/postgres      → /var/lib/postgresql/data on synapse-db
/var/lib/windy-chat/redis         → /data on synapse-redis
/var/lib/windy-chat/coturn        → /var/lib/coturn on coturn
/var/lib/windy-chat/nginx-certs   → /etc/letsencrypt on nginx
/var/lib/windy-chat/<service>     → /app/data on each Node service
```

### Nginx terminations

nginx handles TLS and maps public paths onto internal services:

| Path                                    | Upstream           |
|-----------------------------------------|--------------------|
| `/_matrix/*`, `/_synapse/client/*`      | synapse:8008       |
| `/.well-known/matrix/*`                 | static JSON        |
| `/api/v1/onboarding/*`                  | onboarding:8101    |
| `/api/v1/chat/directory/*`              | directory:8102     |
| `/api/v1/push/*`, `/api/v1/chat/push/*` | push-gateway:8103  |
| `/api/v1/backup/*`                      | backup:8104        |
| `/api/v1/social/*`                      | social:8105        |
| `/api/v1/translate/*`                   | translation:8106   |
| `/api/v1/media/*`                       | media:8107         |
| `/api/v1/calls/*`                       | call-history:8108  |
| everything else                         | web (static)       |

Obtain certs via certbot:

```bash
docker compose exec nginx certbot --nginx \
  -d chat.windychat.ai -d turn.windychat.ai -d windychat.ai \
  --non-interactive --agree-tos -m ops@windychat.ai
```

Renewal is handled by the certbot container's timer; nginx reloads
on success via the post-renewal hook baked into the image.

---

## 4. TURN / STUN (Coturn)

Synapse forwards TURN credentials to clients via the `m.login.password`
flow; Coturn must accept them. We use the shared-secret mode so
credentials are ephemeral.

`/var/lib/windy-chat/coturn/turnserver.conf`:

```
use-auth-secret
static-auth-secret=${COTURN_SHARED_SECRET}
realm=windychat.ai

listening-port=3478
tls-listening-port=5349
listening-ip=<VPS_IPv4>
relay-ip=<VPS_IPv4>
external-ip=<VPS_IPv4>

min-port=49152
max-port=49200

# TLS — point at the nginx-managed cert
cert=/etc/letsencrypt/live/turn.windychat.ai/fullchain.pem
pkey=/etc/letsencrypt/live/turn.windychat.ai/privkey.pem

# Hardening
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
fingerprint
lt-cred-mech
```

Synapse side of the wire — in `homeserver.yaml`:

```yaml
turn_uris:
  - "turn:turn.windychat.ai:3478?transport=udp"
  - "turn:turn.windychat.ai:3478?transport=tcp"
  - "turns:turn.windychat.ai:5349?transport=tcp"
turn_shared_secret: "${COTURN_SHARED_SECRET}"
turn_user_lifetime: 86400000
turn_allow_guests: false
```

Verify with `turnutils_uclient -u user -w pass turn.windychat.ai`
after the stack is up.

---

## 5. Matrix homeserver config

Secrets are read from `.env.production` into Synapse via
`homeserver.yaml` (`${VAR}` interpolation). Never check any of these
into git.

Required Synapse secrets:

- `SYNAPSE_REGISTRATION_SECRET` — used by account-server to provision
  Matrix accounts via the admin register API. Must match
  `registration_shared_secret` in the `windy_registration` module.
  Generate: `openssl rand -hex 32`.
- `SYNAPSE_MACAROON_SECRET_KEY` — signs macaroons used for login
  tokens. Rotating invalidates every active session. Generate:
  `openssl rand -hex 32`.
- `SYNAPSE_FORM_SECRET` — signs registration/reset forms rendered
  by Synapse. Generate: `openssl rand -hex 32`.
- `SYNAPSE_SIGNING_KEY` — Ed25519 server key. Generate once on the
  host and commit to `/var/lib/windy-chat/synapse/signing.key`;
  **do not rotate** after federation goes live (other servers pin
  it).

In `homeserver.yaml`:

```yaml
registration_shared_secret: "${SYNAPSE_REGISTRATION_SECRET}"
macaroon_secret_key: "${SYNAPSE_MACAROON_SECRET_KEY}"
form_secret: "${SYNAPSE_FORM_SECRET}"
signing_key_path: "/data/signing.key"
```

The existing `windy_registration.py` module enforces the rule that
no user can register without going through the Windy Pro
account-server — keep that in place.

---

## 6. Federation allow/deny list

Federation starts **off**. Turn it on only when there's a
concrete peer to federate with and legal sign-off on data sharing.

`homeserver.yaml` (switch from closed → allow-list):

```yaml
# Closed — default until further notice
federation_domain_whitelist: []

# Allow-list mode — flip by populating this list
# federation_domain_whitelist:
#   - "matrix.org"
#   - "chat.windychat.ai"   # peer Windy tenant

# Deny list — takes effect regardless of the whitelist
federation_ip_range_blacklist:
  - "127.0.0.0/8"
  - "10.0.0.0/8"
  - "172.16.0.0/12"
  - "192.168.0.0/16"
  - "100.64.0.0/10"
  - "169.254.0.0/16"
  - "::1/128"
  - "fe80::/10"
  - "fc00::/7"
```

When flipping on:

1. Uncomment the federation DNS SRV record in §2.
2. Open port 8448/tcp at the host firewall.
3. Add domains to `federation_domain_whitelist`.
4. Add `server_notices` / legal posts to inform existing users.
5. `docker compose restart synapse`.
6. Verify with [federationtester.matrix.org](https://federationtester.matrix.org/).

---

## 7. Post-deploy

Run the smoke test from the host once the stack is healthy:

```bash
./scripts/smoke-test.sh https://chat.windychat.ai
```

It verifies:
- Synapse `/_matrix/client/versions` responds
- federation self-test on the `/_matrix/federation/v1/version` path
  (passes whether federation is on or off — the endpoint is always
  served; it just returns 403 when federation is whitelisted
  against empty and we treat that as "alive, closed")
- `/api/v1/onboarding/unified-login` accepts a signed test JWT
- push-gateway accepts an `agent.hatched` event with the shared
  bus token

Full playbook in `docs/DNA_STRAND_MASTER_PLAN.md` §K8.
