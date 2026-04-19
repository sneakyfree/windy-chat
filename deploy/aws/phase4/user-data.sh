#!/usr/bin/env bash
# Wave 13 Phase 4 — windy-chat EC2 bootstrap (user-data)
#
# Renders on the instance once, at first boot. Stops at the compose-up
# step — Grant SSHes in to run certbot + populate .env.production (see
# deploy/aws/phase4/README.md §6). Keeps all secrets OUT of user-data so
# the file (retained in /var/lib/cloud/instance/user-data.txt forever)
# doesn't become a long-lived secret leak.
#
# Substituted placeholders (via envsubst or sed at EC2 launch time):
#   ${GITHUB_CLONE_TOKEN}   — ephemeral PAT; scrubbed post-clone
#                             (residual copy stays in user-data.txt —
#                              rotate after deploy)
#
# Phase-2 bug patterns applied:
#   #3 — `docker compose` is NEVER invoked without --env-file
#   #4 — nginx site enabled BEFORE certbot (certbot runs out-of-band
#        after Grant pastes the production .env, but the wiring is set)
#   #5 — private repo clone scrubs the PAT from .git/config

set -euo pipefail
exec > >(tee -a /var/log/windy-chat-bootstrap.log) 2>&1

echo "=== windy-chat phase 4 bootstrap — $(date -u +%FT%TZ) ==="

# ── 1. OS packages ────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release git jq \
  nginx certbot python3-certbot-nginx \
  postgresql-client-16 \
  awscli

# ── 2. Docker Engine + Compose v2 ─────────────────────────────────
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# ── 3. Repo clone (Phase-2 pattern #5) ────────────────────────────
mkdir -p /opt/windy-chat
chown ubuntu:ubuntu /opt/windy-chat

# Clone with PAT in the URL, then immediately scrub.
su - ubuntu -c "
  set -euo pipefail
  cd /opt
  git clone https://x-access-token:\${GITHUB_CLONE_TOKEN}@github.com/sneakyfree/windy-chat.git
  cd windy-chat
  git remote set-url origin https://github.com/sneakyfree/windy-chat.git
  # Verify the scrub actually landed.
  grep -q 'x-access-token' .git/config && { echo 'FATAL: PAT still in .git/config'; exit 1; } || true
"

# ── 4. Writable data dirs ─────────────────────────────────────────
install -d -m 0750 -o 991 -g 991 /opt/windy-chat-data/synapse
install -d -m 0755 -o ubuntu -g ubuntu /opt/windy-chat-data/services
install -d -m 0750 -o ubuntu -g ubuntu /opt/windy-chat-data/nginx-certs
install -d -m 0755 -o ubuntu -g ubuntu /opt/windy-chat-data/coturn

# ── 5. Nginx site (Phase-2 pattern #4) ────────────────────────────
# Written BEFORE certbot runs so certbot --nginx attaches the cert to
# the right site. Certbot runs out-of-band in Gate 6 — but the site
# config must already be enabled when it does.
cat >/etc/nginx/sites-available/chat.windychat.ai <<'NGINX'
# Windy Chat — chat.windychat.ai
#
# HTTP → HTTPS redirect lands here first; certbot later upgrades this
# to a full HTTPS vhost. The Matrix well-known delegation served from
# /.well-known/matrix/* must stay HTTPS on port 443 — the SRV records
# point at chat.windychat.ai:443 (see Cloudflare DNS step).

server {
    listen 80;
    listen [::]:80;
    server_name chat.windychat.ai;

    # Needed for certbot HTTP-01 challenge before the cert is live.
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# Placeholder HTTPS block — certbot --nginx adds TLS directives here.
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name chat.windychat.ai;

    # ── Matrix well-known delegation ────────────────────────────
    # The SRV records point at port 443 and we delegate federation
    # routing via this static JSON so peers don't need to reach 8448.
    location = /.well-known/matrix/server {
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        return 200 '{"m.server":"chat.windychat.ai:443"}';
    }
    location = /.well-known/matrix/client {
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
        return 200 '{"m.homeserver":{"base_url":"https://chat.windychat.ai"}}';
    }

    client_max_body_size 100M;

    # ── Matrix client + federation to Synapse ───────────────────
    location /_matrix/ {
        proxy_pass http://127.0.0.1:8008;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    location /_synapse/client/ {
        proxy_pass http://127.0.0.1:8008;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # ── Windy Chat services (ports 8101–8108) ───────────────────
    location /api/v1/onboarding/       { proxy_pass http://127.0.0.1:8101; }
    location /api/v1/webhooks/         { proxy_pass http://127.0.0.1:8101; }
    location /api/v1/chat/profile      { proxy_pass http://127.0.0.1:8101; }
    location /api/v1/chat/provision    { proxy_pass http://127.0.0.1:8101; }
    location /api/v1/chat/verify       { proxy_pass http://127.0.0.1:8101; }
    location /api/v1/chat/pair         { proxy_pass http://127.0.0.1:8101; }
    location /api/v1/chat/agent-room   { proxy_pass http://127.0.0.1:8101; }
    location /api/v1/chat/directory/   { proxy_pass http://127.0.0.1:8102; }
    location /api/v1/push/             { proxy_pass http://127.0.0.1:8103; }
    location /api/v1/chat/push/        { proxy_pass http://127.0.0.1:8103; }
    location /api/v1/backup/           { proxy_pass http://127.0.0.1:8104; }
    location /api/v1/social/           { proxy_pass http://127.0.0.1:8105; }
    location /api/v1/translate/        { proxy_pass http://127.0.0.1:8106; }
    location /api/v1/media/            { proxy_pass http://127.0.0.1:8107; }
    location /api/v1/calls/            { proxy_pass http://127.0.0.1:8108; }

    # Common proxy headers for all /api/ locations
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}
NGINX

ln -sf /etc/nginx/sites-available/chat.windychat.ai /etc/nginx/sites-enabled/chat.windychat.ai
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ── 6. Placeholder .env so the box starts cleanly ─────────────────
# Real values land in Gate 6 when Grant pastes them in. This placeholder
# makes it obvious that compose up was NOT fired by user-data.
if [[ ! -f /opt/windy-chat/.env.production ]]; then
  cat >/opt/windy-chat/.env.production <<'EOF'
# PLACEHOLDER — populated in Gate 6 of the Phase 4 runbook.
# DO NOT start docker compose against this file as-is.
NODE_ENV=production
BOOTSTRAP_PLACEHOLDER=1
EOF
  chmod 600 /opt/windy-chat/.env.production
  chown ubuntu:ubuntu /opt/windy-chat/.env.production
fi

# ── 7. Done — DO NOT auto-start the stack ─────────────────────────
echo "=== bootstrap complete, awaiting Gate 6 (Grant-driven compose up) ==="
echo "Next:"
echo "  1. ssh ubuntu@<EIP>  (key: ~/windy-prod-key.pem)"
echo "  2. edit /opt/windy-chat/.env.production with production values"
echo "  3. cd /opt/windy-chat && docker compose -f docker-compose.yml \\"
echo "       -f docker-compose.prod.yml --env-file /opt/windy-chat/.env.production up -d"
echo "  4. certbot --nginx -d chat.windychat.ai --email grantwhitmer3@gmail.com --agree-tos --non-interactive"
echo "  5. scripts/smoke-test.sh https://chat.windychat.ai"
