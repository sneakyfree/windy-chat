#!/bin/bash
# Windy Chat — Enable a Hub Mode bridge (telegram | slack | whatsapp).
#
# Mirrors scripts/enable-k9-appservice.sh (the proven appservice flow) for
# mautrix bridgev2 bridges. Run ON THE PROD HOST from /opt/windy-chat
# (or repo root in dev). Idempotent — safe to re-run.
#
#   sudo bash scripts/enable-hub-bridge.sh telegram
#   sudo bash scripts/enable-hub-bridge.sh slack
#   sudo bash scripts/enable-hub-bridge.sh whatsapp
#
# Prereqs in the env file (.env.production on prod, .env in dev):
#   HUB_BRIDGE_<NETWORK>_PROVISIONING_SECRET   (openssl rand -hex 32)
#   DOUBLEPUPPET_AS_TOKEN / DOUBLEPUPPET_HS_TOKEN (shared by ALL bridges)
#   telegram only: TELEGRAM_API_ID / TELEGRAM_API_HASH (my.telegram.org)
#
# What it does:
#   1. run the bridge container once → generates /data/config.yaml
#   2. patch the config (scripts/hub/patch-bridge-config.py — homeserver,
#      provisioning secret, double puppet, e2be, backfill caps, permissions)
#   3. run the bridge again → generates registration.yaml
#   4. install the bridge registration (+ the shared doublepuppet
#      registration, once) into Synapse's appservices dir
#   5. append them to homeserver.yaml app_service_config_files (idempotent)
#   6. start the bridge (compose profile `hub`)
#   7. STOP — prints the Synapse restart command but does NOT run it in
#      prod. Synapse is the P0 kernel; its restart is operator-gated.
#      Enabling several bridges? Run this for each, restart Synapse ONCE.

set -euo pipefail

NETWORK="${1:-}"
case "$NETWORK" in
  telegram|slack|whatsapp) ;;
  *) echo "usage: $0 telegram|slack|whatsapp" >&2; exit 1 ;;
esac
NETWORK_UPPER=$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Environment: prod layout vs dev layout ──────────────────────────
if [ -f "$ROOT_DIR/.env.production" ] && [ -d /opt/windy-chat-data ]; then
  MODE=prod
  ENV_FILE="$ROOT_DIR/.env.production"
  COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file "$ENV_FILE")
  BRIDGE_DATA=/opt/windy-chat-data/bridges/$NETWORK
  SYNAPSE_DATA=/opt/windy-chat-data/synapse
else
  MODE=dev
  ENV_FILE="$ROOT_DIR/.env"
  COMPOSE=(docker compose)
  BRIDGE_DATA="$ROOT_DIR/deploy/synapse/data/bridges/$NETWORK"
  SYNAPSE_DATA="$ROOT_DIR/deploy/synapse/data"
fi
echo "Mode: $MODE  network: $NETWORK  bridge-data: $BRIDGE_DATA"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

REQUIRED=("HUB_BRIDGE_${NETWORK_UPPER}_PROVISIONING_SECRET" DOUBLEPUPPET_AS_TOKEN DOUBLEPUPPET_HS_TOKEN)
[ "$NETWORK" = telegram ] && REQUIRED+=(TELEGRAM_API_ID TELEGRAM_API_HASH)
for var in "${REQUIRED[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "FATAL: $var missing from $ENV_FILE" >&2
    exit 1
  fi
done

mkdir -p "$BRIDGE_DATA" "$SYNAPSE_DATA/appservices"

# ── 1+2+3: generate config → patch → generate registration ─────────
if [ ! -f "$BRIDGE_DATA/config.yaml" ]; then
  echo "→ generating bridge config (first container run)…"
  "${COMPOSE[@]}" --profile hub run --rm "bridge-$NETWORK" || true
  [ -f "$BRIDGE_DATA/config.yaml" ] || { echo "FATAL: config.yaml was not generated" >&2; exit 1; }
fi

echo "→ patching config.yaml…"
docker run --rm \
  -v "$BRIDGE_DATA":/bridge-data \
  -v "$ROOT_DIR/scripts/hub":/scripts:ro \
  -e "HUB_BRIDGE_${NETWORK_UPPER}_PROVISIONING_SECRET" \
  -e TELEGRAM_API_ID -e TELEGRAM_API_HASH \
  -e DOUBLEPUPPET_AS_TOKEN \
  -e SYNAPSE_SERVER_NAME="${SYNAPSE_SERVER_NAME:-chat.windychat.ai}" \
  -e HUB_ADMIN_MXID="${HUB_ADMIN_MXID:-}" \
  --entrypoint python matrixdotorg/synapse:latest \
  /scripts/patch-bridge-config.py "$NETWORK" /bridge-data/config.yaml

if [ ! -f "$BRIDGE_DATA/registration.yaml" ]; then
  echo "→ generating appservice registration (second container run)…"
  "${COMPOSE[@]}" --profile hub run --rm "bridge-$NETWORK" || true
  [ -f "$BRIDGE_DATA/registration.yaml" ] || { echo "FATAL: registration.yaml was not generated" >&2; exit 1; }
fi

# ── 4: install registrations into Synapse's appservices dir ─────────
echo "→ installing registrations…"
install -m 0644 "$BRIDGE_DATA/registration.yaml" "$SYNAPSE_DATA/appservices/$NETWORK-registration.yaml"
if [ ! -f "$SYNAPSE_DATA/appservices/doublepuppet-registration.yaml" ]; then
  sed \
    -e "s|\${DOUBLEPUPPET_AS_TOKEN}|${DOUBLEPUPPET_AS_TOKEN}|g" \
    -e "s|\${DOUBLEPUPPET_HS_TOKEN}|${DOUBLEPUPPET_HS_TOKEN}|g" \
    "$ROOT_DIR/services/bridges/telegram/doublepuppet-registration.yaml.template" \
    > "$SYNAPSE_DATA/appservices/doublepuppet-registration.yaml"
fi

# ── 5: wire into homeserver.yaml (idempotent append) ────────────────
HS_YAML="$SYNAPSE_DATA/homeserver.yaml"
[ "$MODE" = dev ] && HS_YAML="$ROOT_DIR/deploy/synapse/homeserver.yaml"
for reg in "$NETWORK-registration.yaml" doublepuppet-registration.yaml; do
  if ! grep -q "appservices/$reg" "$HS_YAML"; then
    if grep -q '^app_service_config_files:' "$HS_YAML"; then
      sed -i.hubbak "/^app_service_config_files:/a\\  - /data/appservices/$reg" "$HS_YAML"
    else
      printf '\napp_service_config_files:\n  - /data/appservices/%s\n' "$reg" >> "$HS_YAML"
    fi
    echo "  + $reg wired into $(basename "$HS_YAML")"
  else
    echo "  = $reg already wired"
  fi
done
rm -f "${HS_YAML}.hubbak"

# ── 6: start the bridge ──────────────────────────────────────────────
echo "→ starting bridge-$NETWORK…"
"${COMPOSE[@]}" --profile hub up -d "bridge-$NETWORK"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Bridge staged. FINAL STEP (activates the appservice):"
if [ "$MODE" = prod ]; then
  echo "   ⚠️  Synapse restart is OPERATOR-GATED (P0 kernel):"
  echo "   sudo ${COMPOSE[*]} restart synapse"
  echo "   (enabling several bridges? finish them all, restart ONCE)"
else
  "${COMPOSE[@]}" restart synapse
  echo "   ✓ dev Synapse restarted"
fi
echo ""
echo " Then verify: docker logs windy-bridge-$NETWORK --tail 20"
echo " and set HUB_BRIDGE_${NETWORK_UPPER}_URL=http://bridge-$NETWORK:29317"
echo " in the env file + recreate hub to expose it to clients."
echo "═══════════════════════════════════════════════════════════"
