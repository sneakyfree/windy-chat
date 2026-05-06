#!/bin/bash
# Windy Chat — TLS Certificate Setup via Let's Encrypt
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - Domain DNS pointing to this server
#   - Port 80 accessible from the internet
#
# Usage: ./scripts/setup-tls.sh [domain] [email]

set -e

DOMAIN="${1:-chat.windychat.ai}"
EMAIL="${2:-admin@windyword.ai}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$ROOT_DIR/deploy/certs"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Windy Chat — TLS Certificate Setup${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  Domain: $DOMAIN"
echo "  Email:  $EMAIL"
echo ""

# ── Step 1: Check if certbot is available ──
if command -v certbot &> /dev/null; then
  CERTBOT="certbot"
elif docker image inspect certbot/certbot &> /dev/null 2>&1 || true; then
  CERTBOT="docker"
else
  echo -e "${YELLOW}Installing certbot via Docker...${NC}"
  docker pull certbot/certbot
  CERTBOT="docker"
fi

mkdir -p "$CERT_DIR"
mkdir -p "$ROOT_DIR/deploy/acme-challenge"

# ── Step 2: Check existing certificates ──
if [ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ]; then
  echo -e "${YELLOW}Existing certificates found. Checking expiry...${NC}"
  EXPIRY=$(openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" 2>/dev/null | cut -d= -f2)
  echo "  Expires: $EXPIRY"

  # Check if cert expires in less than 30 days
  if openssl x509 -checkend 2592000 -noout -in "$CERT_DIR/fullchain.pem" 2>/dev/null; then
    echo -e "${GREEN}Certificate is still valid for 30+ days.${NC}"
    echo "  To force renewal: rm deploy/certs/*.pem && re-run this script"
    exit 0
  else
    echo -e "${YELLOW}Certificate expires soon. Renewing...${NC}"
  fi
fi

# ── Step 3: Obtain certificate ──
echo -e "${GREEN}Obtaining certificate for $DOMAIN...${NC}"

if [ "$CERTBOT" = "docker" ]; then
  docker run --rm \
    -v "$CERT_DIR:/etc/letsencrypt/live/$DOMAIN" \
    -v "$ROOT_DIR/deploy/acme-challenge:/var/www/certbot" \
    -p 80:80 \
    certbot/certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"
else
  certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN" \
    --cert-path "$CERT_DIR/fullchain.pem" \
    --key-path "$CERT_DIR/privkey.pem"
fi

# ── Step 4: Verify ──
if [ -f "$CERT_DIR/fullchain.pem" ]; then
  echo ""
  echo -e "${GREEN}✓ TLS certificate obtained successfully${NC}"
  echo ""
  echo "  Certificate: $CERT_DIR/fullchain.pem"
  echo "  Private key: $CERT_DIR/privkey.pem"
  echo ""
  echo "  Nginx will use these automatically."
  echo "  Restart nginx: docker compose restart nginx"
  echo ""
  echo "  Auto-renewal: Add to crontab:"
  echo "    0 3 * * * $0 $DOMAIN $EMAIL"
else
  echo -e "${RED}✗ Certificate generation failed${NC}"
  echo "  Check that:"
  echo "    - DNS for $DOMAIN points to this server"
  echo "    - Port 80 is open and reachable"
  echo "    - No other service is using port 80"
  exit 1
fi
