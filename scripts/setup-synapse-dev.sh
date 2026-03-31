#!/bin/bash
# Windy Chat — Synapse Development Mode Setup
#
# Checks if Synapse is running, starts it if not, then:
#   - Registers a test admin user
#   - Creates 2 test rooms
#   - Prints credentials
#
# Usage: ./scripts/setup-synapse-dev.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNAPSE_DIR="$ROOT_DIR/deploy/synapse"

SYNAPSE_URL="${SYNAPSE_URL:-http://localhost:8008}"
REG_SECRET="${SYNAPSE_REGISTRATION_SECRET:-windy_dev_reg_secret}"
ADMIN_USER="windy_admin"
ADMIN_PASS="windy_dev_admin_pass_$(date +%s | tail -c 6)"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Windy Chat — Synapse Dev Setup${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""

# ── Step 1: Check if Synapse is running ──
echo -e "${BLUE}Checking Synapse at ${SYNAPSE_URL}...${NC}"

if curl -sf "${SYNAPSE_URL}/_matrix/client/versions" > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Synapse is running${NC}"
else
  echo -e "${YELLOW}Synapse not detected. Starting from docker-compose...${NC}"

  if [ ! -f "$SYNAPSE_DIR/docker-compose.yml" ]; then
    echo -e "${RED}✗ No docker-compose.yml found at $SYNAPSE_DIR${NC}"
    echo "  Run deploy/synapse/setup.sh first for initial Synapse setup."
    exit 1
  fi

  (cd "$SYNAPSE_DIR" && docker compose up -d)

  echo -e "${YELLOW}Waiting for Synapse to be ready...${NC}"
  for i in $(seq 1 30); do
    if curl -sf "${SYNAPSE_URL}/_matrix/client/versions" > /dev/null 2>&1; then
      echo -e "${GREEN}✓ Synapse is ready (took ${i}s)${NC}"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo -e "${RED}✗ Synapse failed to start within 30 seconds${NC}"
      echo "  Check: cd deploy/synapse && docker compose logs synapse"
      exit 1
    fi
    sleep 1
  done
fi

echo ""

# ── Step 2: Register test admin user ──
echo -e "${BLUE}Registering test admin user: @${ADMIN_USER}:chat.windypro.com${NC}"

# Get a nonce from Synapse
NONCE=$(curl -sf "${SYNAPSE_URL}/_synapse/admin/v1/register" | python3 -c "import sys,json; print(json.load(sys.stdin)['nonce'])" 2>/dev/null || true)

if [ -z "$NONCE" ]; then
  echo -e "${YELLOW}⚠ Could not get registration nonce from Synapse admin API.${NC}"
  echo "  This may mean:"
  echo "    - registration_shared_secret is not set in homeserver.yaml"
  echo "    - Synapse admin API is not accessible"
  echo ""
  echo "  Skipping user registration. You can register manually:"
  echo "    register_new_matrix_user -c /data/homeserver.yaml ${SYNAPSE_URL}"
  echo ""
else
  # Compute HMAC
  MAC=$(printf '%s\0%s\0%s\0%s' "$NONCE" "$ADMIN_USER" "$ADMIN_PASS" "admin" | openssl dgst -sha1 -hmac "$REG_SECRET" | awk '{print $NF}')

  REG_RESULT=$(curl -sf -X POST "${SYNAPSE_URL}/_synapse/admin/v1/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"nonce\": \"$NONCE\",
      \"username\": \"$ADMIN_USER\",
      \"password\": \"$ADMIN_PASS\",
      \"admin\": true,
      \"mac\": \"$MAC\"
    }" 2>&1 || true)

  if echo "$REG_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user_id',''))" 2>/dev/null | grep -q "$ADMIN_USER"; then
    echo -e "${GREEN}✓ Admin user registered${NC}"
    ACCESS_TOKEN=$(echo "$REG_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)
  elif echo "$REG_RESULT" | grep -qi "User ID already taken"; then
    echo -e "${YELLOW}⚠ Admin user already exists — logging in...${NC}"
    LOGIN_RESULT=$(curl -sf -X POST "${SYNAPSE_URL}/_matrix/client/r0/login" \
      -H "Content-Type: application/json" \
      -d "{
        \"type\": \"m.login.password\",
        \"user\": \"$ADMIN_USER\",
        \"password\": \"$ADMIN_PASS\"
      }" 2>&1 || true)

    ACCESS_TOKEN=$(echo "$LOGIN_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)
    if [ -z "$ACCESS_TOKEN" ]; then
      echo -e "${YELLOW}⚠ Could not log in with the generated password.${NC}"
      echo "  The admin user exists but we don't know the password."
      echo "  Reset it or use an existing access token."
    fi
  else
    echo -e "${YELLOW}⚠ Registration returned unexpected result:${NC}"
    echo "  $REG_RESULT"
  fi
fi

echo ""

# ── Step 3: Create test rooms ──
if [ -n "${ACCESS_TOKEN:-}" ]; then
  echo -e "${BLUE}Creating test rooms...${NC}"

  # Room 1: General chat
  ROOM1=$(curl -sf -X POST "${SYNAPSE_URL}/_matrix/client/r0/createRoom" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "Windy Dev — General",
      "topic": "Development test room",
      "visibility": "private",
      "preset": "private_chat"
    }' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('room_id',''))" 2>/dev/null || true)

  if [ -n "$ROOM1" ]; then
    echo -e "${GREEN}✓ Room 1: $ROOM1 (General)${NC}"
  else
    echo -e "${YELLOW}⚠ Could not create Room 1${NC}"
  fi

  # Room 2: Testing room
  ROOM2=$(curl -sf -X POST "${SYNAPSE_URL}/_matrix/client/r0/createRoom" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "Windy Dev — Testing",
      "topic": "Automated testing room",
      "visibility": "private",
      "preset": "private_chat"
    }' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('room_id',''))" 2>/dev/null || true)

  if [ -n "$ROOM2" ]; then
    echo -e "${GREEN}✓ Room 2: $ROOM2 (Testing)${NC}"
  else
    echo -e "${YELLOW}⚠ Could not create Room 2${NC}"
  fi
else
  echo -e "${YELLOW}Skipping room creation (no access token).${NC}"
fi

echo ""

# ── Print summary ──
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Synapse Dev Environment Ready${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  Synapse:       ${SYNAPSE_URL}"
echo "  Server name:   chat.windypro.com"
echo "  Admin user:    @${ADMIN_USER}:chat.windypro.com"
if [ -n "${ACCESS_TOKEN:-}" ]; then
  echo "  Admin pass:    ${ADMIN_PASS}"
  echo "  Access token:  ${ACCESS_TOKEN}"
fi
if [ -n "${ROOM1:-}" ]; then
  echo "  Room 1:        ${ROOM1}"
fi
if [ -n "${ROOM2:-}" ]; then
  echo "  Room 2:        ${ROOM2}"
fi
echo ""
echo "  Test endpoints:"
echo "    curl ${SYNAPSE_URL}/_matrix/client/versions"
echo "    curl ${SYNAPSE_URL}/health"
echo ""
