#!/usr/bin/env bash
# setup-tls.sh — Generate TLS certificates for chat.windyword.ai (Synapse/nginx)
#
# Modes:
#   ./setup-tls.sh letsencrypt   — Use certbot (production)
#   ./setup-tls.sh selfsigned    — Generate self-signed cert (local dev)
#
# Idempotent: safe to re-run. Existing certs are checked before regenerating.

set -euo pipefail

DOMAIN="chat.windyword.ai"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
SELF_SIGNED_DIR="./certs"
NGINX_CERT_DIR="./certs"  # where docker volume or nginx expects them

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[TLS]${NC} $*"; }
warn() { echo -e "${YELLOW}[TLS]${NC} $*"; }
err()  { echo -e "${RED}[TLS]${NC} $*" >&2; }

usage() {
    echo "Usage: $0 {letsencrypt|selfsigned}"
    echo ""
    echo "  letsencrypt  — Obtain real TLS cert via Let's Encrypt (requires root, public DNS)"
    echo "  selfsigned   — Generate self-signed cert for local development"
    exit 1
}

# ── Let's Encrypt mode ──────────────────────────────────────────────
setup_letsencrypt() {
    log "Setting up Let's Encrypt TLS for ${DOMAIN}"

    # Check certbot is installed
    if ! command -v certbot &>/dev/null; then
        err "certbot not found. Install it first:"
        echo "  Ubuntu/Debian: sudo apt install certbot"
        echo "  macOS:         brew install certbot"
        exit 1
    fi

    # Check running as root (certbot needs it for port 80 standalone)
    if [[ $EUID -ne 0 ]]; then
        err "Let's Encrypt mode requires root. Run with sudo."
        exit 1
    fi

    # Check if valid cert already exists and is not expiring within 30 days
    if [[ -f "${CERT_DIR}/fullchain.pem" && -f "${CERT_DIR}/privkey.pem" ]]; then
        EXPIRY=$(openssl x509 -enddate -noout -in "${CERT_DIR}/fullchain.pem" 2>/dev/null | cut -d= -f2)
        EXPIRY_EPOCH=$(date -d "${EXPIRY}" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "${EXPIRY}" +%s 2>/dev/null || echo 0)
        NOW_EPOCH=$(date +%s)
        DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

        if [[ ${DAYS_LEFT} -gt 30 ]]; then
            log "Valid certificate found (expires in ${DAYS_LEFT} days). Skipping renewal."
            copy_certs_from_letsencrypt
            return 0
        else
            warn "Certificate expires in ${DAYS_LEFT} days. Renewing..."
        fi
    fi

    # Obtain or renew certificate (standalone HTTP-01 challenge on port 80)
    log "Requesting certificate via certbot standalone..."
    certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "admin@windypro.com" \
        --domain "${DOMAIN}" \
        --keep-until-expiring \
        --rsa-key-size 4096

    if [[ $? -ne 0 ]]; then
        err "certbot failed. Make sure port 80 is open and DNS points to this server."
        exit 1
    fi

    copy_certs_from_letsencrypt
    log "Let's Encrypt setup complete."
}

copy_certs_from_letsencrypt() {
    mkdir -p "${NGINX_CERT_DIR}"

    cp "${CERT_DIR}/fullchain.pem" "${NGINX_CERT_DIR}/fullchain.pem"
    cp "${CERT_DIR}/privkey.pem"   "${NGINX_CERT_DIR}/privkey.pem"

    chmod 644 "${NGINX_CERT_DIR}/fullchain.pem"
    chmod 600 "${NGINX_CERT_DIR}/privkey.pem"

    log "Certs copied to ${NGINX_CERT_DIR}/"
    log "  fullchain.pem  (644)"
    log "  privkey.pem    (600)"
}

# ── Self-signed mode ────────────────────────────────────────────────
setup_selfsigned() {
    log "Setting up self-signed TLS for local development"

    if ! command -v openssl &>/dev/null; then
        err "openssl not found. Install it first."
        exit 1
    fi

    mkdir -p "${SELF_SIGNED_DIR}"

    CERT_FILE="${SELF_SIGNED_DIR}/fullchain.pem"
    KEY_FILE="${SELF_SIGNED_DIR}/privkey.pem"

    # Skip if cert exists and is not expired
    if [[ -f "${CERT_FILE}" && -f "${KEY_FILE}" ]]; then
        if openssl x509 -checkend 0 -noout -in "${CERT_FILE}" &>/dev/null; then
            log "Existing self-signed cert is still valid. Skipping regeneration."
            log "  Delete ${SELF_SIGNED_DIR}/ to force regeneration."
            return 0
        else
            warn "Existing self-signed cert is expired. Regenerating..."
        fi
    fi

    log "Generating 4096-bit RSA key + self-signed certificate (365 days)..."

    openssl req -x509 -nodes \
        -newkey rsa:4096 \
        -keyout "${KEY_FILE}" \
        -out "${CERT_FILE}" \
        -days 365 \
        -subj "/C=US/ST=Local/L=Dev/O=Windy/CN=${DOMAIN}" \
        -addext "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1"

    chmod 644 "${CERT_FILE}"
    chmod 600 "${KEY_FILE}"

    log "Self-signed cert generated:"
    log "  ${CERT_FILE}  (644)"
    log "  ${KEY_FILE}   (600)"
}

# ── Print next steps ────────────────────────────────────────────────
print_next_steps() {
    local MODE="$1"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Next steps"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if [[ "${MODE}" == "letsencrypt" ]]; then
        echo ""
        echo "  1. Ensure nginx.conf points to the cert files:"
        echo "       ssl_certificate     /etc/nginx/certs/fullchain.pem;"
        echo "       ssl_certificate_key /etc/nginx/certs/privkey.pem;"
        echo ""
        echo "  2. Mount the certs into the nginx container. In docker-compose.yml"
        echo "     replace the synapse_certs volume with a bind mount:"
        echo "       volumes:"
        echo "         - ./certs:/etc/nginx/certs:ro"
        echo ""
        echo "  3. Set up auto-renewal (runs twice daily, no-op if not due):"
        echo "       sudo crontab -e"
        echo "       0 2,14 * * * certbot renew --quiet --deploy-hook \"cp /etc/letsencrypt/live/${DOMAIN}/*.pem $(pwd)/certs/ && docker restart windy-synapse-nginx\""
        echo ""
        echo "  4. Restart the stack:"
        echo "       docker-compose up -d"
        echo ""
    else
        echo ""
        echo "  1. Mount the self-signed certs into nginx. In docker-compose.yml"
        echo "     replace the synapse_certs volume with a bind mount:"
        echo "       volumes:"
        echo "         - ./certs:/etc/nginx/certs:ro"
        echo ""
        echo "  2. Restart the stack:"
        echo "       docker-compose up -d"
        echo ""
        echo "  3. Browsers will show a security warning for self-signed certs."
        echo "     For local dev with curl, use: curl -k https://localhost:8443/..."
        echo ""
    fi
}

# ── Main ────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
    usage
fi

case "$1" in
    letsencrypt)
        setup_letsencrypt
        print_next_steps "letsencrypt"
        ;;
    selfsigned)
        setup_selfsigned
        print_next_steps "selfsigned"
        ;;
    *)
        usage
        ;;
esac
