#!/bin/bash
# Windy Chat — PostgreSQL (Synapse) Database Backup
#
# Creates timestamped pg_dump backups of the Synapse database.
# Keeps the last 7 daily backups and rotates old ones.
#
# Usage:
#   ./scripts/backup-db.sh                    # One-off backup
#   ./scripts/backup-db.sh --install-cron     # Install daily cron job
#
# Cron (runs daily at 3 AM):
#   0 3 * * * /path/to/windy-chat/scripts/backup-db.sh >> /var/log/windy-backup.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups/synapse-db}"
RETENTION_DAYS=7

# Database connection (from .env or defaults)
if [ -f "$ROOT_DIR/.env" ]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

DB_HOST="${SYNAPSE_DB_HOST:-synapse-db}"
DB_PORT="${SYNAPSE_DB_PORT:-5432}"
DB_NAME="${SYNAPSE_DB_NAME:-synapse}"
DB_USER="${SYNAPSE_DB_USER:-synapse}"
DB_PASS="${SYNAPSE_DB_PASSWORD:-}"
CONTAINER_NAME="${SYNAPSE_DB_CONTAINER:-windy-synapse-db}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="synapse_${TIMESTAMP}.sql.gz"

# ── Install cron mode ──
if [ "${1:-}" = "--install-cron" ]; then
  CRON_CMD="0 3 * * * $SCRIPT_DIR/backup-db.sh >> /var/log/windy-backup.log 2>&1"
  (crontab -l 2>/dev/null | grep -v "backup-db.sh"; echo "$CRON_CMD") | crontab -
  echo -e "${GREEN}Cron job installed: daily at 3 AM${NC}"
  echo "  $CRON_CMD"
  exit 0
fi

mkdir -p "$BACKUP_DIR"

echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] Starting Synapse database backup..."

# ── Determine backup method ──
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  # Running in Docker — use docker exec
  echo "  Method: docker exec (container: $CONTAINER_NAME)"
  docker exec "$CONTAINER_NAME" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --compress=9 \
    > "$BACKUP_DIR/$BACKUP_FILE"
elif command -v pg_dump &>/dev/null; then
  # Local pg_dump
  echo "  Method: local pg_dump"
  PGPASSWORD="$DB_PASS" pg_dump \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --format=custom --compress=9 \
    -f "$BACKUP_DIR/$BACKUP_FILE"
else
  echo -e "${RED}ERROR: Neither Docker container '$CONTAINER_NAME' nor local pg_dump found${NC}"
  exit 1
fi

# ── Verify backup ──
BACKUP_SIZE=$(stat -f%z "$BACKUP_DIR/$BACKUP_FILE" 2>/dev/null || stat --printf="%s" "$BACKUP_DIR/$BACKUP_FILE" 2>/dev/null)

if [ "$BACKUP_SIZE" -lt 100 ]; then
  echo -e "${RED}ERROR: Backup file is suspiciously small (${BACKUP_SIZE} bytes)${NC}"
  rm -f "$BACKUP_DIR/$BACKUP_FILE"
  exit 1
fi

echo -e "  ${GREEN}Backup created: $BACKUP_FILE ($(numfmt --to=iec "$BACKUP_SIZE" 2>/dev/null || echo "${BACKUP_SIZE} bytes"))${NC}"

# ── SQLite backups (all 8 services) ──
SQLITE_BACKUP_DIR="$BACKUP_DIR/sqlite_${TIMESTAMP}"
mkdir -p "$SQLITE_BACKUP_DIR"

for svc in onboarding directory push-gateway backup social translation media call-history; do
  DB_FILE="$ROOT_DIR/services/$svc/data/*.db"
  for f in $DB_FILE; do
    if [ -f "$f" ]; then
      cp "$f" "$SQLITE_BACKUP_DIR/$(basename "$f")"
    fi
  done
done

SQLITE_COUNT=$(find "$SQLITE_BACKUP_DIR" -name "*.db" 2>/dev/null | wc -l | tr -d ' ')
echo "  SQLite databases backed up: $SQLITE_COUNT"

# ── Rotate old backups ──
DELETED=0
find "$BACKUP_DIR" -maxdepth 1 -name "synapse_*.sql.gz" -mtime +"$RETENTION_DAYS" -print -delete | while read -r f; do
  DELETED=$((DELETED + 1))
done
find "$BACKUP_DIR" -maxdepth 1 -name "sqlite_*" -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} \; 2>/dev/null || true

REMAINING=$(find "$BACKUP_DIR" -maxdepth 1 -name "synapse_*.sql.gz" | wc -l | tr -d ' ')
echo "  Retention: keeping last $RETENTION_DAYS days ($REMAINING backups on disk)"

echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] Done."
