#!/bin/bash
# Windy Chat — Enable K9 Translation Application Service
#
# Copies the appservice registration to Synapse's data dir and restarts Synapse.
#
# Prerequisites:
#   - Synapse running via docker compose
#   - TRANSLATION_AS_TOKEN and TRANSLATION_HS_TOKEN set in .env
#
# Usage: ./scripts/enable-k9-appservice.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  K9 Translation AppService — Enable${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""

# Check required env vars
if [ -z "${TRANSLATION_AS_TOKEN:-}" ] || [ -z "${TRANSLATION_HS_TOKEN:-}" ]; then
  if [ -f "$ROOT_DIR/.env" ]; then
    source "$ROOT_DIR/.env"
  fi
fi

if [ -z "${TRANSLATION_AS_TOKEN:-}" ]; then
  echo -e "${YELLOW}Generating TRANSLATION_AS_TOKEN...${NC}"
  TRANSLATION_AS_TOKEN=$(openssl rand -hex 32)
  echo "TRANSLATION_AS_TOKEN=$TRANSLATION_AS_TOKEN" >> "$ROOT_DIR/.env"
fi

if [ -z "${TRANSLATION_HS_TOKEN:-}" ]; then
  echo -e "${YELLOW}Generating TRANSLATION_HS_TOKEN...${NC}"
  TRANSLATION_HS_TOKEN=$(openssl rand -hex 32)
  echo "TRANSLATION_HS_TOKEN=$TRANSLATION_HS_TOKEN" >> "$ROOT_DIR/.env"
fi

# Create appservices directory in Synapse data
SYNAPSE_DATA="${ROOT_DIR}/deploy/synapse/data"
mkdir -p "${SYNAPSE_DATA}/appservices"

# Copy and render the registration file
REG_SRC="${ROOT_DIR}/services/translation/appservice/registration.yaml"
REG_DST="${SYNAPSE_DATA}/appservices/translation-registration.yaml"

echo -e "${GREEN}Copying registration to Synapse data...${NC}"
sed \
  -e "s|\${TRANSLATION_AS_TOKEN}|${TRANSLATION_AS_TOKEN}|g" \
  -e "s|\${TRANSLATION_HS_TOKEN}|${TRANSLATION_HS_TOKEN}|g" \
  "$REG_SRC" > "$REG_DST"

echo -e "${GREEN}✓ Registration file written to:${NC}"
echo "  $REG_DST"
echo ""

# Restart Synapse if running via Docker
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q windy-synapse; then
  echo -e "${GREEN}Restarting Synapse to pick up appservice...${NC}"
  (cd "$ROOT_DIR" && docker compose restart synapse)
  echo -e "${GREEN}✓ Synapse restarted${NC}"
else
  echo -e "${YELLOW}Synapse not running via Docker.${NC}"
  echo "  Start it with: docker compose up -d synapse"
  echo "  Or restart manually to load the appservice."
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  K9 AppService Enabled${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  AppService ID:     windy-translation"
echo "  AppService URL:    http://translation:8106"
echo "  Sender localpart:  @windy_translator:chat.windyword.ai"
echo ""
echo "  AS Token: ${TRANSLATION_AS_TOKEN:0:8}..."
echo "  HS Token: ${TRANSLATION_HS_TOKEN:0:8}..."
echo ""
echo "  To test: send a message in a room and check translation service logs."
echo ""
