# Wave 13 Phase 4 — Windy Chat on AWS (runbook)

Target: **chat.windychat.ai** — single-EC2 production deploy for the v1
launch. Synapse + 4 Node services + Coturn + nginx + certbot, all in one
`docker compose` stack on a t3.medium; Postgres on RDS db.t3.small;
EIP + Cloudflare DNS.

This runbook is **gated** — every mutating step pauses for Grant's "OK"
before firing. Read-only probes run first.

---

## Assumed state before firing

- Phase 1 live: `https://api.windyword.ai/.well-known/jwks.json` (kid
  `37e8955762d43189`).
- Phase 2 live: `https://eternitas.windyword.ai`. `HMAC_WINDY_CHAT` is in
  `~/.eternitas-phase2-state` (ephemeral — never committed).
- AWS account `819439781125`, region `us-east-1`, VPC
  `vpc-011cc35a43403f9ef`, windy-prod-private subnet group.
- SSH key `windy-prod-key` (pem at `~/windy-prod-key.pem`).
- `awscli` installed and configured (this PR's Gate 0).

## Pre-flight — 7 bug patterns inherited from Phase 2

| # | Pattern | Where applied |
|---|---------|---------------|
| 1 | Dockerfile builder stage copy order | N/A — Windy Chat is Node, not Python/uv. No builder-stage gotcha. |
| 2 | `ports: !override` in prod overlay | `docker-compose.prod.yml` ports lists use `!override` — see §4. |
| 3 | `${VAR:-default}` resolves at shell time | User-data runs `docker compose … --env-file /opt/windy-chat/.env.production up -d` everywhere. Never `docker compose up` bare. |
| 4 | Nginx site enabled BEFORE certbot | User-data writes `/etc/nginx/sites-available/chat.windychat.ai` → `ln -sf` → `systemctl reload nginx` → `certbot --nginx -d chat.windychat.ai`. Order pinned. |
| 5 | Private `sneakyfree/*` clone needs PAT + scrub | User-data receives `GITHUB_CLONE_TOKEN` via envsubst, clones, then `git remote set-url origin https://github.com/sneakyfree/windy-chat.git`. Flag for PAT rotation post-deploy (residual copy in `/var/lib/cloud/instance/user-data.txt`). |
| 6 | `depends_on: service_healthy` vs scaled-to-zero | Prod overlay leaves `synapse-db` running idle (~50 MB RAM) so Synapse's `depends_on: synapse-db: service_healthy` satisfies. Real data store is RDS via `DATABASE_URL` in `homeserver.yaml`. Explicit override is §4.4. |
| 7 | Synapse admin creation | Post-deploy SSH: `docker compose exec synapse register_new_matrix_user -u admin -a -c /data/homeserver.yaml http://127.0.0.1:8008`. The `-a` flag promotes via the shared secret path — no SQL promote dance needed. Logged for the PR body. |

---

## Fire sequence

### Gate 1 — read-only probes

```bash
aws sts get-caller-identity                  # → Account 819439781125, user windy-ecosystem-admin
aws ec2 describe-security-groups --group-ids sg-05024168bf3105182 \
  --query 'SecurityGroups[0].IpPermissions[?IpProtocol==`udp`]'
aws ec2 describe-db-subnet-groups --db-subnet-group-name windy-prod-private \
  --query 'DBSubnetGroups[0].Subnets[].SubnetIdentifier'
dig +short chat.windychat.ai                 # must be empty / NXDOMAIN
aws ec2 describe-availability-zones --region us-east-1 \
  --query 'AvailabilityZones[?State==`available`].ZoneName'
```

Report existing UDP rules vs. what Coturn wants. Wait for OK.

### Gate 2 — Security Group deltas

Coturn needs the following ingress on `windy-web-sg`
(`sg-05024168bf3105182`), additive to whatever's already there:

```bash
aws ec2 authorize-security-group-ingress --group-id sg-05024168bf3105182 \
  --ip-permissions '[
    {"IpProtocol":"udp","FromPort":3478,"ToPort":3478,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"Coturn STUN/TURN (UDP)"}]},
    {"IpProtocol":"tcp","FromPort":3478,"ToPort":3478,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"Coturn TURN (TCP fallback)"}]},
    {"IpProtocol":"udp","FromPort":5349,"ToPort":5349,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"Coturn TURN-DTLS"}]},
    {"IpProtocol":"tcp","FromPort":5349,"ToPort":5349,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"Coturn TURN-TLS (turns: URI)"}]},
    {"IpProtocol":"udp","FromPort":49152,"ToPort":65535,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"Coturn RTP relay range"}]}
  ]'
```

**Wave 14 additions (both TCP rows):** the original Gate 2 only opened
the UDP variants, but Synapse's `turnServer` endpoint advertises
`turn:chat.windychat.ai:3478?transport=tcp` and
`turns:chat.windychat.ai:5349?transport=tcp`. Without the TCP/3478 and
TCP/5349 SG rules, clients behind UDP-blocking firewalls (many
corporate + some hotel networks) cannot reach coturn even though the
server-side listener is correctly bound.

If Gate 1 shows any of these already present, we diff and only add the
missing ones. Wait for OK.

> **Note on blast radius:** opening 49152–65535/udp to 0.0.0.0/0 is the
> standard Coturn posture but broadens the external surface. Rate limits
> + TURN credential auth (shared-secret mode) mitigate abuse. Document
> the IP range in the PR body for post-launch review.

### Gate 3 — RDS Postgres (async, ~15 min)

```bash
aws rds create-db-instance \
  --db-instance-identifier windy-chat-synapse \
  --db-instance-class db.t3.small \
  --engine postgres --engine-version 16 \
  --master-username synapse \
  --master-user-password "$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)" \
  --allocated-storage 20 --storage-type gp3 \
  --vpc-security-group-ids sg-07b8a5a208aa32951 \
  --db-subnet-group-name windy-prod-private \
  --backup-retention-period 7 \
  --deletion-protection \
  --no-multi-az \
  --tags Key=Project,Value=Windy Key=Product,Value=windy-chat Key=Environment,Value=production
```

Captures the generated password to `/opt/windy-chat/.env.production` in
Gate 5. Fires in background — takes ~15 min. RDS endpoint surfaces via
`aws rds describe-db-instances --db-instance-identifier windy-chat-synapse`
once `DBInstanceStatus=available`.

### Gate 4 — EC2 + EIP

```bash
# Latest Ubuntu 24.04 LTS (Canonical)
AMI=$(aws ec2 describe-images --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
  --query 'sort_by(Images,&CreationDate)|[-1].ImageId' --output text)

aws ec2 run-instances \
  --image-id "$AMI" \
  --instance-type t3.medium \
  --subnet-id subnet-0da5d289ccead1b2d \
  --security-group-ids sg-05024168bf3105182 sg-0f70b0451e92558a2 \
  --key-name windy-prod-key \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=40,VolumeType=gp3,DeleteOnTermination=true}' \
  --user-data file://deploy/aws/phase4/user-data.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Project,Value=Windy},{Key=Product,Value=windy-chat},{Key=Environment,Value=production}]'

# Wait for 'running', then allocate + associate EIP
aws ec2 allocate-address --domain vpc \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Product,Value=windy-chat}]'
aws ec2 associate-address --instance-id i-… --allocation-id eipalloc-…
```

### Gate 5 — DNS at Cloudflare

Paste-ready API calls in `deploy/aws/phase4/cloudflare-dns.sh`. Token is
passed in via `CLOUDFLARE_DNS_TOKEN` env var; never logged, never
committed.

Records:
- `A  chat.windychat.ai → <EIP>` (proxied=false — Matrix federation
  breaks behind Cloudflare's proxy without Spectrum/Argo).
- `_matrix._tcp.chat.windychat.ai SRV 10 0 443 chat.windychat.ai`
- `_matrix-identity._tcp.chat.windychat.ai SRV 10 0 443 chat.windychat.ai`

Port 443 (not 8448) lands on nginx and we delegate federation via
`/.well-known/matrix/server` returning
`{"m.server":"chat.windychat.ai:443"}`.

### Gate 6 — bootstrap + certbot + compose up

SSH to EC2, render `/opt/windy-chat/.env.production` (values pulled from
this session's ephemeral env — `HMAC_WINDY_CHAT`, the generated Synapse
secrets, the RDS endpoint+password from Gate 3). Start the stack:

```bash
cd /opt/windy-chat
# Always --env-file (pattern 3)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file /opt/windy-chat/.env.production \
  up -d
```

Nginx site is written and linked before certbot runs (pattern 4), then:

```bash
certbot --nginx -d chat.windychat.ai \
  --email grantwhitmer3@gmail.com --agree-tos --non-interactive
```

### Gate 7 — smoke

```bash
./scripts/smoke-test.sh https://chat.windychat.ai
# Expected: Synapse versions ✓, federation endpoint ✓, unified-login ✓,
# agent.hatched push ✓ (Wave 12 M-2 routes to the `agent_hatched` channel)
```

Plus: `register_new_matrix_user -u admin -a -c /data/homeserver.yaml
http://127.0.0.1:8008` (pattern 7). Record the admin Matrix ID in the PR
body.

---

## Post-deploy cleanup

- Rotate `GITHUB_CLONE_TOKEN` (residual in `/var/lib/cloud/instance/user-data.txt`).
- Register Chat as an Eternitas subscriber (Phase 2 supplied HMAC):

```bash
curl -X POST https://eternitas.windyword.ai/api/v1/platforms/subscribe \
  -H "Authorization: Bearer $ETERNITAS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "platform": "windychat",
    "webhook_url": "https://chat.windychat.ai/api/v1/webhooks/passport/revoked",
    "hmac_secret": "'"$HMAC_WINDY_CHAT"'"
  }'
```

(Eternitas side already has the subscriber row per Phase 2 bootstrap;
this re-posts with the live URL.)

---

## PR contents (no secrets)

- Elastic IP, RDS endpoint hostname, SG rule additions (UDP 3478 / 5349
  / 49152–65535), DNS record set.
- Smoke test output.
- `admin` Matrix ID.
- Coturn port-range rationale + post-launch review ticket.
- Wave 12 M-2 (FCM channel routing) included as commit 1 — exercised
  by the smoke push for `agent.hatched` + spot checks for
  `mail.inbound` / `cloud.quota_warn`.
