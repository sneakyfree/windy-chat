# Windy Chat — AWS Production Deployment

Target topology for the v1 launch. Chat is the messaging + social backend
for the ecosystem — five services, one homeserver, one TURN relay, backed
by managed AWS data stores.

The existing `deploy/aws-setup.sh` script launches a single-EC2 stack for
dev/staging. **This doc covers the production topology** — multi-AZ ECS
Fargate for services, RDS for PostgreSQL, ElastiCache for Redis, and a
dedicated Coturn box for WebRTC.

## Topology

```
                    ┌──────────────────────────────────────┐
                    │   Route 53 — chat.windyword.ai       │
                    └──────────────────────┬───────────────┘
                                           ▼
              ┌────────────────────────────────────────────┐
              │  Application Load Balancer (TLS, WAF)      │
              │  :443 → target groups per service          │
              └──┬──────────┬──────────┬──────────┬────────┘
                 │          │          │          │
                 ▼          ▼          ▼          ▼
           ┌─────────┐┌──────────┐┌─────────┐┌──────────┐
           │ Synapse ││Onboarding││Directory││  Push    │
           │  (8008) ││  (8101)  ││  (8102) ││(8103)    │
           │  ECS    ││  ECS     ││  ECS    ││  ECS     │
           └────┬────┘└────┬─────┘└────┬────┘└────┬─────┘
                │          │            │          │
                └──────────┼────────────┼──────────┘
                           ▼            ▼
                 ┌──────────────────┐ ┌────────────────┐
                 │ RDS PostgreSQL   │ │ ElastiCache    │
                 │  Multi-AZ        │ │   Redis        │
                 │  db.r6g.large    │ │  cache.m6g.lg  │
                 └──────────────────┘ └────────────────┘

       ┌───────────────────────────────────────┐
       │  Coturn EC2 (c6i.large, static EIP)   │
       │  3478/udp, 3478/tcp, 5349/tls          │
       └───────────────────────────────────────┘
                           │
                      Clients (WebRTC)
```

## Service topology on ECS Fargate

One ECS cluster, one service per microservice. All services run in a VPC
with private subnets in three AZs; only the ALB holds public ENIs.

| Service | Port | Fargate size | Min/Max tasks | Notes |
|---|---|---|---|---|
| Synapse | 8008 | 2 vCPU / 4 GB | 2 / 8 | horizontal scale via Synapse workers (below) |
| onboarding | 8101 | 0.5 vCPU / 1 GB | 2 / 6 | stateless; scales on CPU |
| directory | 8102 | 0.5 vCPU / 1 GB | 2 / 6 | trust-client hits Eternitas; cold-start tolerant |
| push-gateway | 8103 | 1 vCPU / 2 GB | 3 / 12 | scales on queue depth (below) |
| backup | 8104 | 0.5 vCPU / 1 GB | 1 / 2 | write-mostly; cheap |

### ALB rules

```
chat.windyword.ai:443/_matrix/*         → synapse
chat.windyword.ai:443/_synapse/*        → synapse (admin; WAF rule restricts CIDR)
chat.windyword.ai:443/api/v1/webhooks/* → onboarding
chat.windyword.ai:443/api/v1/chat/*     → onboarding + directory + push-gateway (by sub-path)
chat.windyword.ai:443/api/v1/push/*     → push-gateway
chat.windyword.ai:443/health            → per-service (path-matched)
```

Health check path `/health` on every service; target-group deregistration
delay 30s. Synapse uses `/health` and `/_matrix/client/versions` as
liveness.

### Inter-service communication

Services discover each other via ECS Service Connect (Cloud Map DNS) on
`chat.internal`. **No traffic leaves the VPC** for service-to-service:

```
SYNAPSE_URL=http://synapse.chat.internal:8008
WINDY_ACCOUNT_SERVER_URL=https://windypro.thewindstorm.uk  (external, via NAT)
ETERNITAS_URL=https://api.eternitas.ai                     (external, via NAT)
PUSH_GATEWAY_URL=http://push-gateway.chat.internal:8103
```

## PostgreSQL via RDS

Synapse is the only heavy Postgres consumer (messages, rooms, events,
presence). Microservices use SQLite locally — that stays for v1 but will
move to RDS in a follow-up wave.

- **Engine**: PostgreSQL 16.x
- **Instance**: `db.r6g.large` (2 vCPU / 16 GB) as starting size
- **Storage**: 200 GB gp3, `iops=6000`, `throughput=250 MB/s`
- **Multi-AZ**: **ON** — automatic failover
- **Backups**: 7-day automated + daily snapshot retention of 30 days
- **Parameter group** (custom):
  - `max_connections = 300`
  - `shared_buffers = 4GB`
  - `work_mem = 64MB`
  - `maintenance_work_mem = 512MB`
  - `effective_cache_size = 12GB`
  - `wal_compression = on`
  - `log_min_duration_statement = 500ms`
- **Security**: SG allows ingress 5432 only from the ECS task SG; disable
  the default `rds-*` SG's public access. Enable IAM auth for the
  service-to-DB credential (rotation via Secrets Manager).
- **Connection pooling**: Synapse uses `txn_limit: 10000` in
  `homeserver.yaml`; set `cp_max: 20` to respect RDS `max_connections`.

## Redis via ElastiCache

Shared across services for rate limiting, OTP TTLs, trust-client cache,
Synapse worker coordination.

- **Engine**: Redis 7.x
- **Node type**: `cache.m6g.large` (2 vCPU / 6.38 GB)
- **Cluster mode**: OFF for v1 (single shard, 1 primary + 1 replica)
- **Automatic failover**: **ON**
- **TLS**: **ON** (`rediss://`)
- **AUTH token**: rotate via Secrets Manager; Synapse and services read at
  boot via an init container that materializes `REDIS_URL`.
- **Eviction policy**: `allkeys-lru`
- **Reserved cache nodes** once usage is stable — ~70% discount vs
  on-demand.

Key namespaces (so operators can grep prod state):

```
synapse:*             Synapse's own keys
windy:chat:trust:*    Trust-client cache (5-min TTL)
windy:chat:otp:*      Onboarding OTP codes (10-min TTL)
windy:chat:verified:* Phone/email verification sessions (24h TTL)
windy:chat:pairing:*  QR pairing sessions (10-min TTL)
```

## Coturn for WebRTC

One-to-one calling + group calls go through Synapse signaling, but the
media path is WebRTC — which usually can't cross NATs without a TURN relay.

- **Instance**: `c6i.large` (2 vCPU / 4 GB), network-optimized
- **Placement**: single AZ for v1 (add redundancy in wave 7), static
  **Elastic IP** — clients hardcode the address via the turn_uris in
  `homeserver.yaml`
- **Ports**:
  - 3478/udp, 3478/tcp (plain TURN/STUN)
  - 5349/udp, 5349/tcp (TURN over TLS)
  - 49152–65535/udp (media relay port range)
- **TLS cert**: issued via ACM, synced to the box with a systemd timer
  (`/etc/coturn/certs/`). Certbot fallback if ACM-sync fails.
- **Shared secret**: `TURN_SHARED_SECRET` from Secrets Manager. Same value
  Synapse uses in its `turn_shared_secret` config.
- **Security group**: allow the full UDP port range from `0.0.0.0/0`. This
  is the only part of the stack with wide-open UDP — scoped tightly to
  Coturn's ENI.
- **Monitoring**: CloudWatch + coturn's own `redis_statsdb` pointed at
  ElastiCache.

## Federation — OFF for v1

`homeserver.yaml` has:

```yaml
federation_domain_whitelist: []
allow_public_rooms_over_federation: false
allow_public_rooms_without_auth: false
restrict_public_rooms_to_local_users: true
```

An empty `federation_domain_whitelist` disables all outbound federation.
Inbound federation is blocked at the ALB — port `8448` is **not** opened,
so no foreign server can even reach Synapse. v1 is a Windy-users-only
network on the `chat.windyword.ai` domain.

To turn federation on in a future wave, three things change:
1. Add ALB listener for 8448 (federation port).
2. Populate `federation_domain_whitelist` with the allowed server list.
3. Publish `/.well-known/matrix/server` via CloudFront.

No reason to wire any of that for v1 — it's a security surface we don't
need yet.

## Signing-key generation and rotation

Synapse signs every federated event with an ed25519 key (`signing_key`).
Even though v1 has federation off, the key still signs device lists,
presence, and push notifications — so it must exist and must be kept.

### Generation (one-time, at first deploy)

```bash
docker run --rm \
    -v /data/synapse:/data \
    matrixdotorg/synapse:latest \
    generate-keys \
    --server-name chat.windyword.ai
# Emits: /data/chat.windyword.ai.signing.key
```

Store the key file in **AWS Secrets Manager** (not plain S3 or a file
share). Synapse tasks mount the secret to `/data/chat.windyword.ai.signing.key`
via the ECS task definition's `secrets:` field.

### Rotation procedure

ed25519 signing keys are **not routinely rotated** — Synapse uses
`old_signing_keys` to express trust for previously-valid keys. Rotate only
in response to a suspected compromise.

1. Generate a new key:
   ```bash
   docker run --rm matrixdotorg/synapse:latest \
     generate-keys --server-name chat.windyword.ai --output-directory /tmp
   ```
2. Add an `old_signing_keys:` block to `homeserver.yaml` listing the
   current (soon-to-be-old) key + its `expired_ts` (now + 7 days) and
   `verify_key`.
3. Rotate the secret in Secrets Manager; point ECS task def at the new
   secret version.
4. Rolling-restart Synapse tasks (ECS `forceNewDeployment`). The `old_signing_keys` block keeps any in-flight signed content verifiable
   during the 7-day overlap.
5. After 7 days, drop the old key from `homeserver.yaml` and remove the
   prior Secrets Manager version.

### Registration shared-secret

Separate from the signing key — `SYNAPSE_REGISTRATION_SECRET` is what
windy-pro's account-server uses to mint Matrix accounts. This one
**should** be rotated quarterly. Procedure:

1. Generate a new random string (`openssl rand -hex 32`).
2. Update Secrets Manager version.
3. Update the same secret in windy-pro's account-server (via its own
   deployment pipeline).
4. Rolling-restart Synapse. No downtime — the secret is only consulted at
   the moment of registration, never during normal message flow.

## Push-gateway worker scaling

`push-gateway` handles two workloads on one service:

1. **Synchronous Matrix push** — Synapse → `/_matrix/push/v1/notify` →
   FCM/APNs/WebPush. p99 latency target: **< 500ms**.
2. **Cross-service bus** — `POST /api/v1/push/notify` from Mail, Chat's
   own Synapse module, Clone, Fly, Code. Bursty; amenable to queueing.

### Horizontal scaling

ECS service auto-scaling policy:

- **CPU target**: 50%
- **Memory target**: 60%
- **Custom metric**: `NotifyQueueDepth` (published to CloudWatch from
  push-gateway every 15 s). Target: < 100 messages.
- **Scale-out**: + 2 tasks when any target is breached, 1-min cooldown.
- **Scale-in**: − 1 task when all targets 20% below for 10 min.

### Vertical — FCM/APNs throughput

FCM and APNs are rate-limited per app_id by the vendor. Today we issue
sequential HTTP calls; under load (> 2000 notifications/min) we'd hit a
ceiling.

**Wave-7 upgrade path**: batch FCM sends (up to 500/request) and keep APN
connections warm in a connection pool (`apn.Provider` reuses HTTP/2). For
v1, keep the simple path and scale horizontally.

### Device token storage

`push_tokens` table lives in SQLite on each push-gateway task's local
disk today. That breaks under horizontal scale — task 2 can't deliver to a
token registered on task 1. **v1 mitigation**: add an ALB sticky-session
cookie on the `/register` path so the same task handles registration +
subsequent deliveries for a user. **v1.1**: migrate `push_tokens` to RDS
(small table, low write rate — fits the Synapse cluster fine).

## Secrets matrix

All of the following come from AWS Secrets Manager, mounted as ECS task
secrets. Never baked into container images.

| Secret | Consumed by | Rotation |
|---|---|---|
| `SYNAPSE_DB_PASSWORD` | synapse | quarterly |
| `SYNAPSE_REGISTRATION_SECRET` | synapse + windy-pro account-server | quarterly |
| `chat.windyword.ai.signing.key` | synapse | on compromise only |
| `TURN_SHARED_SECRET` | synapse + coturn | quarterly |
| `REDIS_AUTH_TOKEN` | synapse + all services | quarterly |
| `WINDY_JWT_SECRET` | all services (HS256 fallback) | quarterly; JWKS is primary |
| `CHAT_API_TOKEN` | legacy service-to-service auth | retire once all callers use JWT |
| `WINDY_IDENTITY_WEBHOOK_SECRET` | onboarding | annually |
| `ETERNITAS_WEBHOOK_SECRET` | onboarding | annually (rotate via Eternitas dashboard) |
| `PUSH_BUS_TOKEN` | push-gateway + Synapse push-bus module | annually |
| `FIREBASE_SERVICE_ACCOUNT` | push-gateway | rotate when Firebase project rotates |
| `APNS_KEY_PATH` (p8) | push-gateway | annually (Apple cert renewal) |
| `VAPID_PRIVATE_KEY` | push-gateway | never (keep forever) |

## DNS + certificates

- **chat.windyword.ai** — A record → ALB
- **turn.windyword.ai** — A record → Coturn EIP (used in `turn_uris`)
- **Certificate**: ACM-issued wildcard `*.windyword.ai`, attached to both
  the ALB and the Coturn EC2 via the sync timer
- **CAA record** on `windyword.ai` restricting issuance to Amazon + Let's
  Encrypt

## Observability

- **CloudWatch Logs** — every service ships stdout via the
  `awslogs` log driver. Retention 30 days; archive to S3 Glacier on
  expiry.
- **Prometheus + Grafana** — already configured in `deploy/monitoring/`.
  Run those as an ECS service in the same VPC, scrape on `:9000` (Synapse
  metrics) and `:9090` (service `/metrics` where present).
- **Sentry** — DSN provided via `SENTRY_DSN` env var, already wired in
  `services/shared/sentry.js`.
- **Synthetic monitoring** — CloudWatch Synthetics canary hitting
  `/health` every 1 min on every service from three regions.

## Deployment runbook (TL;DR)

```bash
# 1. Provision infra via Terraform (module lives in infra/ at repo root)
cd infra && terraform apply

# 2. Seed signing key once
./deploy/aws/generate-signing-key.sh  # writes to Secrets Manager

# 3. Build + push ECR images
./deploy/aws/build-and-push.sh synapse onboarding directory push-gateway backup

# 4. Deploy ECS task def updates
aws ecs update-service --cluster windy-chat-prod \
    --service synapse --force-new-deployment

# 5. Smoke-test
./deploy/aws/smoke-test.sh chat.windyword.ai
```

Rollback: `aws ecs update-service --task-definition <prev>` —
ECS keeps the last N task definitions automatically.

---

Contract this deployment must uphold (see `SECURITY_REVIEW.md` for the
audit): trust gates enforced, HMAC verified on all webhook paths,
federation explicitly off, rate limits live, signing key in Secrets
Manager, no plaintext secrets in task definitions.
