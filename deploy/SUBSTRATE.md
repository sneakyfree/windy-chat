# SUBSTRATE — windy-chat production

**ADR:** [ADR-048](https://github.com/sneakyfree/kit-army-config/blob/main/docs/adr-048-operational-substrate-as-code-2026-05-15.md) Layer 1
**Generated:** 2026-05-17 via live SSH audit of EC2 `i-0f603361b88baa4c0`
**Maintenance policy:** edit on every change to compose, host directory layout, or env vars. T2.A drift detector verifies this nightly against the live host.

---

## Host

| Field | Value |
|---|---|
| EC2 instance ID | `i-0f603361b88baa4c0` |
| Public hostname | `chat.windychat.ai` |
| SSH user | `ubuntu` |
| Repo path | `/opt/windy-chat` |
| Compose dir | `/opt/windy-chat` (compose files at repo root) |
| Persistent data root | `/opt/windy-chat-data/` (NOT under the git tree) |

## Compose project

| Field | Value |
|---|---|
| Project name | TBD — verify next SSH session; per ADR-046 must be explicit `name:` in `docker-compose.yml`. If still directory-derived (`windy-chat`), file a follow-up to set it. |
| Compose files | `docker-compose.yml` + `docker-compose.prod.yml` (both required) |
| Env file | `/opt/windy-chat/.env.production` (hand-curated, not in git; per `feedback_windy_chat_compose_invocation`) |
| Deploy workflow | Manual `sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d --force-recreate` (auto-deploy pending; EC2 git remote auth currently broken — see "Anomalies" below) |

## Volumes — declared → on-host

| Compose name | On-host name | Critical data | Notes |
|---|---|---|---|
| (Synapse data) | bind: `/opt/windy-chat-data/synapse` | rendered homeserver.yaml + signing.key + sqlite/postgres data | Not a named volume; bind-mounted per `docker-compose.prod.yml`. |
| (Coturn certs) | bind: `/opt/windy-chat-data/coturn/certs` | LE fullchain + privkey owned by uid 65534 | Refreshed by `deploy/aws/phase4/setup-coturn-certs.sh`. Wire to certbot `--deploy-hook` (anomaly #5). |
| (Coturn logs) | bind: `/var/log/windy-chat/coturn` | turnserver logs | Rotate via host logrotate. |
| (per-service named volumes) | per `docker-compose.yml` for postgres/redis/sqlite | TBD | Pin actual names with `docker volume ls` after next deploy. |

## Bind mounts

| Host path | Container path | Service | Mode | Notes |
|---|---|---|---|---|
| `/opt/windy-chat/secrets` | `/secrets` | push-gateway | ro | APNs `.p8` + FCM service-account JSON. Added PR #59 (2026-05-17). Boot-guard enforced — `server.js` exits 1 in production if missing. |
| `/opt/windy-chat-data/synapse` | `/data` | synapse | rw | Inode-bound — edit with `tee`, never `cp` (see `feedback_caddy_inode_binding`). |
| `/opt/windy-chat/deploy/synapse/turnserver.conf` | `/etc/turnserver.conf.template` | coturn | ro | Rendered at container start by entrypoint. |
| `/opt/windy-chat/deploy/synapse/coturn-entrypoint.sh` | `/usr/local/bin/coturn-entrypoint.sh` | coturn | ro | |
| `/opt/windy-chat-data/coturn/certs` | `/etc/coturn-certs` | coturn | ro | |
| `/var/log/windy-chat/coturn` | `/var/log/turnserver` | coturn | rw | |

## Services (expected running)

| Compose service | Image | Port (host) | Healthy when |
|---|---|---|---|
| `synapse` | `matrixdotorg/synapse` | 127.0.0.1:8008 | `/_matrix/client/versions` 200 |
| `onboarding` | local node | 127.0.0.1:8101 | `/health` 200 + `/version` 200 |
| `directory` | local node | 127.0.0.1:8102 | `/health` 200 + `/version` 200 |
| `push-gateway` | local node | 127.0.0.1:8103 | `/health` 200 + `/version` 200; `dependencies.{apns,fcm,webPush}` all `active` |
| `backup` | local node | 127.0.0.1:8104 | `/health` 200 + `/version` 200 |
| `social` | local node | 127.0.0.1:8105 | `/health` 200 + `/version` 200 |
| `media` | local node | 127.0.0.1:8107 | `/health` 200 + `/version` 200 |
| `coturn` | `coturn/coturn` | host-network: 3478 udp+tcp, 5349 tcp, 49152–65535 udp+tcp | `turnutils_stunclient` reflexive OK |

## External ports (host-bound / SG ingress)

| Port | Proto | Purpose |
|---|---|---|
| 443 | tcp | HTTPS (Synapse client API + microservice REST) — terminated by host nginx |
| 80 | tcp | HTTP (ACME challenges only; redirects to 443) |
| 3478 | udp+tcp | STUN + plain TURN |
| 5349 | tcp | TURN-over-TLS |
| 49152–65535 | udp+tcp | TURN relay range |

## External dependencies

| Dependency | Endpoint | Used by | Failure mode |
|---|---|---|---|
| Pro account-server JWKS | `https://account.windyword.ai/.well-known/jwks.json` | every service `jwt-verify` middleware | All authed routes 401 |
| Eternitas API | `https://api.eternitas.ai` | directory (trust gates), social (webhooks) | Trust gates fail-closed → bot DMs blocked |
| FCM | `fcm.googleapis.com` | push-gateway | Android pushes silently stub (or hard-fail with boot guard) |
| APNs | `api.push.apple.com` | push-gateway | iOS pushes silently stub (or hard-fail with boot guard) |
| Resend | `api.resend.com` | onboarding (OTP email) | OTP email fails |
| Let's Encrypt | `acme-v02.api.letsencrypt.org` | host certbot (NOT in container) | TURN-over-TLS breaks at next renewal if `setup-coturn-certs.sh` not in `--deploy-hook` |

## Critical env vars (`/opt/windy-chat/.env.production`)

Lockbox section: `ACCESS_LOCKBOX.md → windy-chat`. Required values:

- `SYNAPSE_REGISTRATION_SECRET`, `PUSH_BUS_TOKEN`, `WINDY_IDENTITY_WEBHOOK_SECRET`, `ETERNITAS_WEBHOOK_SECRET`
- `WINDY_ACCOUNT_SERVER_URL=https://account.windyword.ai`
- `WINDY_JWKS_URL=https://account.windyword.ai/.well-known/jwks.json`
- `ETERNITAS_URL=https://api.eternitas.ai`
- `FIREBASE_SERVICE_ACCOUNT=/secrets/firebase-service-account.json`
- `APNS_KEY_PATH=/secrets/AuthKey_P5FBN93UWP.p8`, `APNS_KEY_ID=P5FBN93UWP`, `APNS_TEAM_ID=VXZ434QL89`, `APNS_BUNDLE_ID=uk.thewindstorm.windypro`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:admin@windychat.ai`
- `COTURN_SHARED_SECRET`, `COTURN_REALM=chat.windychat.ai`, `COTURN_EXTERNAL_IP=<EIP>`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — backup service
- `COMMIT_SHA`, `BUILD_TIMESTAMP`, `ENVIRONMENT=production` — set by deploy command per MF1

## Tolerated drift (allowlist)

Drift detector should NOT flag these:

| Item | Reason |
|---|---|
| `services/onboarding/data/avatars/*.{png,jpg}` on host | Test-seed leftovers; gitignored. |
| `*.bak.*` / `*.pre-*` on host | Hand-made operational backups; gitignored from this PR forward. Future ops changes should be logged in this file's "Audit history" instead. |
| ~50-commit `git log` gap between host HEAD and `origin/main` HEAD | EC2 git remote auth currently broken (anomaly #1); pulls fail. Will close when remote is switched to SSH or PAT installed. |

## Recovery — cold start from this manifest

1. Launch fresh EC2 (Ubuntu 22.04, t3.medium minimum), attach EIP, SG opens ports listed above.
2. Install Docker + Compose plugin + certbot.
3. `git clone https://github.com/sneakyfree/windy-chat /opt/windy-chat`
4. Restore `/opt/windy-chat/.env.production` from lockbox (`ACCESS_LOCKBOX.md → windy-chat`).
5. Restore `/opt/windy-chat/secrets/` (`AuthKey_P5FBN93UWP.p8` + `firebase-service-account.json`) from `~/kit-army-config/secrets/`.
6. `mkdir -p /opt/windy-chat-data/{synapse,coturn/certs} /var/log/windy-chat/coturn`
7. `sudo certbot certonly --standalone -d chat.windychat.ai`
8. `bash /opt/windy-chat/deploy/aws/phase4/setup-coturn-certs.sh`
9. `cd /opt/windy-chat && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d`
10. Verify each `/health` + `/version` on 127.0.0.1:8101..8107; verify `push-gateway` `/health` returns `dependencies.{apns,fcm,webPush}` all `active`.

## Anomalies / known gaps (2026-05-17 audit)

1. **EC2 git remote auth broken.** `git fetch` fails with `could not read Username for 'https://github.com'`. Auto-deploy via `git pull` is currently impossible on this host. Fix: switch remote to SSH (`git@github.com:sneakyfree/windy-chat.git`) and load deploy key, OR install a fine-grained PAT in the host's `~/.netrc`.
2. **EC2 working tree is ~50 commits stale** (`b6b753b` vs `origin/main` `48ee588` as of audit). Every legit hotfix is already in main; recovery = `git stash push -u -m "pre-pull-2026-05-17"` + `git pull --ff-only origin main` + drop the stash. Do NOT do this without first resolving anomaly #1.
3. **Compose project name not verified.** ADR-046 requires explicit `name:` in `docker-compose.yml`. If still directory-derived, this is in the same collision class as the windy-mail/eternitas outage of 2026-05-14.
4. **Coturn TLS renewal not wired to `--deploy-hook`.** `setup-coturn-certs.sh` is in the repo but unless certbot calls it on renewal (~monthly), TURN-over-TLS will silently break on cert rotation. Confirm with `cat /etc/letsencrypt/renewal/chat.windychat.ai.conf | grep deploy-hook` next SSH session.
5. **`.env.production` not automatically synced to lockbox.** If the EC2 is destroyed, recovery depends on lockbox having current values. Confirm out-of-band that lockbox `ACCESS_LOCKBOX.md → windy-chat` section matches the live `.env.production`.

## Audit history

| Date | Trigger | Result |
|---|---|---|
| 2026-05-17 | Initial authoring after substrate-drift audit (97 dirty files on EC2; all legitimate hotfixes already in source-of-truth at HEAD `48ee588`). Hot-patched volume mount + force-recreate to flip push-gateway from stub → live delivery; locked into source-of-truth via PR #59. SUBSTRATE.md + boot guard + gitignore added this PR. | Drift = stale EC2 HEAD `b6b753b` vs main `48ee588`; not lost-work. 5 anomalies surfaced. |

## Cross-references

- [ADR-048 — operational substrate as code](https://github.com/sneakyfree/kit-army-config/blob/main/docs/adr-048-operational-substrate-as-code-2026-05-15.md)
- [ADR-046 — explicit compose project name](https://github.com/sneakyfree/kit-army-config/blob/main/docs/adr-046-compose-naming-collision-2026-05-15.md)
- T2.A drift detection spec: `kit-army-config/docs/t2a-drift-detection-design-spec-2026-05-15.md`
- T2.B boot guards spec: `kit-army-config/docs/t2b-substrate-boot-guards-design-spec-2026-05-15.md`
- Reference SUBSTRATE impls: `sneakyfree/windy-mail/deploy/SUBSTRATE.md`, `sneakyfree/windy-clone/deploy/SUBSTRATE.md`
- Memory: `project_windy_chat_phase4_state`, `feedback_windy_chat_compose_invocation`, `project_adr048_operational_substrate`
- Marathon Foundations: MF1 (`/version`), MF4 (DB backups — TBD for this service's RDS), MF13 (deploy reliability)
