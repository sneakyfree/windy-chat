#!/usr/bin/env bash
# Windy Chat — Synapse Homeserver Setup Script
# K1: Our Own Matrix Homeserver (DNA Strand K)
#
# This script initializes the Synapse homeserver:
#   1. Generates Synapse config and signing keys
#   2. Creates the PostgreSQL database
#   3. Overlays our custom homeserver.yaml
#   4. Starts all services
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - .env file with required secrets (see README.md)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()   { echo -e "${GREEN}[SETUP]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }

# ── Check prerequisites ──
check_prerequisites() {
    log "Checking prerequisites..."

    if ! command -v docker &>/dev/null; then
        error "Docker is not installed. Install it from https://docs.docker.com/get-docker/"
        exit 1
    fi

    if ! docker compose version &>/dev/null; then
        error "Docker Compose V2 is not installed."
        exit 1
    fi

    if [[ ! -f ".env" ]]; then
        warn ".env file not found. Creating from template..."
        create_env_file
    fi

    log "Prerequisites OK ✓"
}

# ── Create .env file ──
create_env_file() {
    cat > .env << 'ENV_TEMPLATE'
# Windy Chat Synapse — Environment Variables
# Generate secrets with: openssl rand -hex 32

# PostgreSQL password for Synapse database
SYNAPSE_DB_PASSWORD=CHANGE_ME_generate_with_openssl_rand_hex_32

# Synapse registration shared secret (used by Windy account server)
SYNAPSE_REGISTRATION_SECRET=CHANGE_ME_generate_with_openssl_rand_hex_32

# TURN server shared secret (Coturn ↔ Synapse)
TURN_SHARED_SECRET=CHANGE_ME_generate_with_openssl_rand_hex_32

# Synapse server name
SYNAPSE_SERVER_NAME=chat.windypro.com
ENV_TEMPLATE

    warn "Created .env with placeholder values."
    warn ">>> EDIT .env AND SET REAL SECRETS BEFORE PROCEEDING <<<"
    warn "Generate secrets with: openssl rand -hex 32"
    echo ""
    read -rp "Press Enter after editing .env, or Ctrl+C to abort..."
}

# ── Generate Synapse config and signing keys ──
generate_synapse_config() {
    log "Generating Synapse configuration and signing keys..."

    # Source the .env file
    set -a
    source .env
    set +a

    SERVER_NAME="${SYNAPSE_SERVER_NAME:-chat.windypro.com}"

    # Generate initial config (we'll overlay our own homeserver.yaml)
    docker run --rm \
        -v "${SCRIPT_DIR}/generated:/data" \
        -e "SYNAPSE_SERVER_NAME=${SERVER_NAME}" \
        -e "SYNAPSE_REPORT_STATS=no" \
        matrixdotorg/synapse:latest generate

    # Copy generated signing key to our data volume
    # (homeserver.yaml is our own — we don't use the generated one)
    if [[ -f "generated/${SERVER_NAME}.signing.key" ]]; then
        log "Signing key generated ✓"
    else
        error "Failed to generate signing key"
        exit 1
    fi

    # Copy log config if generated
    if [[ -f "generated/${SERVER_NAME}.log.config" ]]; then
        log "Log config generated ✓"
    fi

    log "Synapse config generation complete ✓"
}

# ── Create Coturn config ──
create_turnserver_config() {
    log "Creating Coturn TURN server configuration..."

    set -a
    source .env
    set +a

    cat > turnserver.conf << TURNCONF
# Coturn TURN server for Windy Chat VoIP (K5)
listening-port=3478
tls-listening-port=5349

# Use long-term credentials with shared secret (Synapse integration)
use-auth-secret
static-auth-secret=${TURN_SHARED_SECRET}

# Realm
realm=chat.windypro.com

# Relay port range
min-port=49152
max-port=49200

# Logging
log-file=stdout
verbose

# Security
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=::1
TURNCONF

    log "Coturn config created ✓"
}

# ── Start PostgreSQL and create database ──
start_database() {
    log "Starting PostgreSQL..."

    docker compose up -d synapse-db
    info "Waiting for PostgreSQL to be ready..."

    local retries=30
    while ! docker compose exec synapse-db pg_isready -U synapse &>/dev/null; do
        retries=$((retries - 1))
        if [[ $retries -le 0 ]]; then
            error "PostgreSQL failed to start within 30 seconds"
            exit 1
        fi
        sleep 1
    done

    log "PostgreSQL is ready ✓"
}

# ── Copy generated files to Synapse data volume ──
copy_generated_files() {
    log "Preparing Synapse data volume..."

    # Start synapse container briefly to create the volume, then copy files
    docker compose up -d synapse || true
    sleep 3
    docker compose stop synapse || true

    # Copy signing key into the volume
    set -a
    source .env
    set +a
    SERVER_NAME="${SYNAPSE_SERVER_NAME:-chat.windypro.com}"

    if [[ -f "generated/${SERVER_NAME}.signing.key" ]]; then
        docker compose cp \
            "generated/${SERVER_NAME}.signing.key" \
            "synapse:/data/${SERVER_NAME}.signing.key"
        log "Signing key copied to Synapse data volume ✓"
    fi

    if [[ -f "generated/${SERVER_NAME}.log.config" ]]; then
        docker compose cp \
            "generated/${SERVER_NAME}.log.config" \
            "synapse:/data/${SERVER_NAME}.log.config"
        log "Log config copied to Synapse data volume ✓"
    fi

    # Create media_store directory
    docker compose exec synapse mkdir -p /data/media_store /data/modules || true
    log "Media store directory created ✓"
}

# ── Start all services ──
start_services() {
    log "Starting all Windy Chat services..."

    docker compose up -d

    info "Waiting for Synapse to be ready..."
    local retries=60
    while ! docker compose exec synapse curl -sf http://localhost:8008/health &>/dev/null; do
        retries=$((retries - 1))
        if [[ $retries -le 0 ]]; then
            error "Synapse failed to start within 60 seconds"
            error "Check logs: docker compose -f deploy/synapse/docker-compose.yml logs synapse"
            exit 1
        fi
        sleep 1
    done

    log "All services started ✓"
}

# ── Print status ──
print_status() {
    echo ""
    echo "════════════════════════════════════════════════════════"
    echo "  🌪️  Windy Chat Synapse Homeserver — RUNNING"
    echo "════════════════════════════════════════════════════════"
    echo ""
    echo "  Synapse:     http://localhost:8008"
    echo "  Nginx:       https://localhost:8443"
    echo "  PostgreSQL:  localhost:5432 (internal)"
    echo "  Redis:       localhost:6379 (internal)"
    echo "  Coturn:      localhost:3478 (STUN/TURN)"
    echo ""
    echo "  Federation API:   https://chat.windypro.com:8448"
    echo "  Client API:       https://chat.windypro.com/_matrix/client"
    echo "  Well-known:       https://chat.windypro.com/.well-known/matrix/client"
    echo ""
    echo "  Logs:   docker compose -f deploy/synapse/docker-compose.yml logs -f"
    echo "  Stop:   docker compose -f deploy/synapse/docker-compose.yml down"
    echo ""
    echo "════════════════════════════════════════════════════════"
}

# ── Main ──
main() {
    echo ""
    log "🌪️  Windy Chat — Synapse Homeserver Setup"
    echo ""

    check_prerequisites
    generate_synapse_config
    create_turnserver_config
    start_database
    copy_generated_files
    start_services
    print_status
}

main "$@"
