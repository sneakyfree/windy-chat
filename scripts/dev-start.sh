#!/bin/bash
# Windy Chat — Start all microservices locally for development
# Usage: ./scripts/dev-start.sh
#
# Prerequisites:
#   - Node.js 18+
#   - npm install:all has been run (or each service has node_modules/)
#   - Synapse running on :8008 (optional, run scripts/setup-synapse-dev.sh first)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Windy Chat development stack...${NC}"
echo ""

# Track PIDs for cleanup
PIDS=()

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down services...${NC}"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  echo -e "${GREEN}All services stopped.${NC}"
  exit 0
}

trap cleanup SIGINT SIGTERM

# Start each service
start_service() {
  local name="$1"
  local dir="$2"
  local port="$3"

  if [ ! -d "$ROOT_DIR/services/$dir/node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies for $name...${NC}"
    (cd "$ROOT_DIR/services/$dir" && npm install --silent)
  fi

  echo -e "${BLUE}Starting $name on :${port}...${NC}"
  (cd "$ROOT_DIR/services/$dir" && PORT=$port node server.js) &
  PIDS+=($!)
}

start_service "Onboarding (K2)"    "onboarding"    8101
start_service "Directory (K3)"     "directory"     8102
start_service "Push Gateway (K6)"  "push-gateway"  8103
start_service "Backup (K8)"        "backup"        8104
start_service "Social (K10)"       "social"        8105
start_service "Translation (K9)"   "translation"   8106
start_service "Media (K4)"         "media"         8107
start_service "Call History (K5)"  "call-history"  8108

# Wait for services to start
sleep 2

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Windy Chat Development Stack Running${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  Services:"
echo "    Onboarding:    http://localhost:8101"
echo "    Directory:     http://localhost:8102"
echo "    Push Gateway:  http://localhost:8103"
echo "    Backup:        http://localhost:8104"
echo "    Social:        http://localhost:8105"
echo "    Translation:   http://localhost:8106"
echo "    Media:         http://localhost:8107"
echo "    Call History:  http://localhost:8108"
echo ""
echo "  Health checks:"
echo "    curl http://localhost:8101/health"
echo "    curl http://localhost:8105/health"
echo ""
echo -e "${YELLOW}  Press Ctrl+C to stop all services${NC}"
echo ""

wait
