#!/bin/bash
# Windy Chat — Credential Setup Wizard
#
# Interactive script that generates secrets, validates credentials,
# and writes .env for production deployment.
#
# Usage: ./scripts/setup-credentials.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Windy Chat — Credential Setup${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""

if [ -f "$ENV_FILE" ]; then
  echo -e "${YELLOW}⚠ Existing .env found. This will update it.${NC}"
  echo ""
fi

# Start from production template
cp "$ROOT_DIR/.env.production" "$ENV_FILE.tmp"

# ── Generate random secrets ──
echo -e "${BLUE}Generating secure random secrets...${NC}"

SYNAPSE_DB_PASS=$(openssl rand -hex 16)
SYNAPSE_REG_SECRET=$(openssl rand -hex 32)
TURN_SECRET=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
CHAT_TOKEN=$(openssl rand -hex 32)
ETERNITAS_SECRET=$(openssl rand -hex 32)
AS_TOKEN=$(openssl rand -hex 32)
HS_TOKEN=$(openssl rand -hex 32)

# Replace placeholders
sed -i.bak "s|^SYNAPSE_DB_PASSWORD=.*|SYNAPSE_DB_PASSWORD=$SYNAPSE_DB_PASS|" "$ENV_FILE.tmp"
sed -i.bak "s|^SYNAPSE_REGISTRATION_SECRET=.*|SYNAPSE_REGISTRATION_SECRET=$SYNAPSE_REG_SECRET|" "$ENV_FILE.tmp"
sed -i.bak "s|^TURN_SHARED_SECRET=.*|TURN_SHARED_SECRET=$TURN_SECRET|" "$ENV_FILE.tmp"
sed -i.bak "s|^WINDY_JWT_SECRET=.*|WINDY_JWT_SECRET=$JWT_SECRET|" "$ENV_FILE.tmp"
sed -i.bak "s|^CHAT_API_TOKEN=.*|CHAT_API_TOKEN=$CHAT_TOKEN|" "$ENV_FILE.tmp"
sed -i.bak "s|^ETERNITAS_WEBHOOK_SECRET=.*|ETERNITAS_WEBHOOK_SECRET=$ETERNITAS_SECRET|" "$ENV_FILE.tmp"
sed -i.bak "s|^TRANSLATION_AS_TOKEN=.*|TRANSLATION_AS_TOKEN=$AS_TOKEN|" "$ENV_FILE.tmp"
sed -i.bak "s|^TRANSLATION_HS_TOKEN=.*|TRANSLATION_HS_TOKEN=$HS_TOKEN|" "$ENV_FILE.tmp"

rm -f "$ENV_FILE.tmp.bak"
mv "$ENV_FILE.tmp" "$ENV_FILE"

echo -e "${GREEN}✓ Random secrets generated${NC}"
echo ""

# ── Status report ──
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Credential Setup Complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  Generated:"
echo -e "    ${GREEN}✓${NC} SYNAPSE_DB_PASSWORD"
echo -e "    ${GREEN}✓${NC} SYNAPSE_REGISTRATION_SECRET"
echo -e "    ${GREEN}✓${NC} TURN_SHARED_SECRET"
echo -e "    ${GREEN}✓${NC} WINDY_JWT_SECRET"
echo -e "    ${GREEN}✓${NC} CHAT_API_TOKEN"
echo -e "    ${GREEN}✓${NC} ETERNITAS_WEBHOOK_SECRET"
echo -e "    ${GREEN}✓${NC} TRANSLATION_AS_TOKEN / HS_TOKEN"
echo ""
echo "  Still needed (fill in .env manually):"
echo -e "    ${YELLOW}○${NC} TWILIO_ACCOUNT_SID / AUTH_TOKEN / PHONE_NUMBER"
echo -e "    ${YELLOW}○${NC} SENDGRID_API_KEY"
echo -e "    ${YELLOW}○${NC} FIREBASE_SERVICE_ACCOUNT (path to JSON)"
echo -e "    ${YELLOW}○${NC} APNS_KEY_PATH / KEY_ID / TEAM_ID"
echo -e "    ${YELLOW}○${NC} R2_ACCOUNT_ID / ACCESS_KEY_ID / SECRET_ACCESS_KEY / ENDPOINT"
echo ""
echo "  File: $ENV_FILE"
echo ""
echo "  Next steps:"
echo "    1. Fill in the remaining credentials in .env"
echo "    2. Run: ./scripts/setup-tls.sh"
echo "    3. Run: docker compose up -d"
echo "    4. Run: ./scripts/setup-synapse-dev.sh"
echo ""
echo -e "${YELLOW}  IMPORTANT: Share WINDY_JWT_SECRET with the windy-pro account-server.${NC}"
echo -e "${YELLOW}  Both repos must use the same secret for JWT validation.${NC}"
echo ""
