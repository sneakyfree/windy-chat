#!/usr/bin/env bash
# Wave 13 Phase 4 — Cloudflare DNS for chat.windychat.ai
#
# DO NOT SET CLOUDFLARE_DNS_TOKEN IN THIS FILE. Pass it in via env:
#
#   CLOUDFLARE_DNS_TOKEN=<token> EIP=3.x.x.x ./deploy/aws/phase4/cloudflare-dns.sh
#
# The token is ephemeral — this session's value, never committed, not
# logged. If you need to re-run this script, re-paste the token.

set -euo pipefail

: "${CLOUDFLARE_DNS_TOKEN:?set CLOUDFLARE_DNS_TOKEN from the deploy session env}"
: "${EIP:?set EIP to the Elastic IP allocated in Gate 4}"

ZONE_NAME="windychat.ai"
API="https://api.cloudflare.com/client/v4"

log() { printf "\033[1;34m[dns]\033[0m %s\n" "$*"; }

# Look up zone ID
ZONE_ID=$(curl -sS -H "Authorization: Bearer ${CLOUDFLARE_DNS_TOKEN}" \
  "${API}/zones?name=${ZONE_NAME}" | jq -r '.result[0].id')
[[ -z "${ZONE_ID}" || "${ZONE_ID}" == "null" ]] && {
  echo "FATAL: zone ${ZONE_NAME} not found or token lacks Zone:Read" >&2
  exit 1
}
log "zone ${ZONE_NAME} → ${ZONE_ID}"

# ── 1. A record ────────────────────────────────────────────────────
log "A chat.windychat.ai → ${EIP}"
curl -sS -X POST "${API}/zones/${ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CLOUDFLARE_DNS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$(jq -n --arg ip "$EIP" '{
    type: "A",
    name: "chat.windychat.ai",
    content: $ip,
    ttl: 300,
    proxied: false,
    comment: "Wave 13 Phase 4 — windy-chat production Matrix homeserver"
  }')" | jq '.result | {id, name, type, content, proxied}'

# ── 2. Matrix federation SRV ───────────────────────────────────────
# Per Grant's override: port 443 (not 8448). nginx on :443 serves
# /.well-known/matrix/server with {"m.server":"chat.windychat.ai:443"}
# so federation routes through the same TLS endpoint as the client API.
log "SRV _matrix._tcp.chat.windychat.ai → 10 0 443"
curl -sS -X POST "${API}/zones/${ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CLOUDFLARE_DNS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "SRV",
    "name": "_matrix._tcp.chat.windychat.ai",
    "data": {
      "service": "_matrix",
      "proto": "_tcp",
      "name": "chat.windychat.ai",
      "priority": 10,
      "weight": 0,
      "port": 443,
      "target": "chat.windychat.ai"
    },
    "ttl": 300,
    "comment": "Wave 13 Phase 4 — Matrix federation delegation"
  }' | jq '.result | {id, name, type, data}'

# ── 3. Matrix identity SRV ─────────────────────────────────────────
log "SRV _matrix-identity._tcp.chat.windychat.ai → 10 0 443"
curl -sS -X POST "${API}/zones/${ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CLOUDFLARE_DNS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "SRV",
    "name": "_matrix-identity._tcp.chat.windychat.ai",
    "data": {
      "service": "_matrix-identity",
      "proto": "_tcp",
      "name": "chat.windychat.ai",
      "priority": 10,
      "weight": 0,
      "port": 443,
      "target": "chat.windychat.ai"
    },
    "ttl": 300,
    "comment": "Wave 13 Phase 4 — Matrix identity service delegation"
  }' | jq '.result | {id, name, type, data}'

log "done — allow 60s for propagation, then:"
log "  dig +short chat.windychat.ai"
log "  dig +short SRV _matrix._tcp.chat.windychat.ai"
