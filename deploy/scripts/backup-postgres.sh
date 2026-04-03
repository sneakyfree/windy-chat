#!/usr/bin/env bash
# backup-postgres.sh — Dump the Synapse PostgreSQL database, compress, and prune old backups.
#
# Usage:
#   ./backup-postgres.sh                    # uses defaults
#   BACKUP_DIR=/mnt/backups ./backup-postgres.sh   # custom backup dir
#
# Add to crontab for daily execution at 03:00:
#   # 0 3 * * * /path/to/deploy/scripts/backup-postgres.sh >> /var/log/windy-chat-backup.log 2>&1

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────
DB_CONTAINER="${DB_CONTAINER:-windy-synapse-db}"
DB_NAME="${DB_NAME:-synapse}"
DB_USER="${DB_USER:-synapse}"
BACKUP_DIR="${BACKUP_DIR:-/Users/thewindstorm/windy-chat/deploy/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-7}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/synapse-${TIMESTAMP}.sql"
GZIP_FILE="${DUMP_FILE}.gz"

# ── Logging ──────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ── Pre-flight checks ───────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    log "ERROR: docker not found in PATH."
    exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    log "ERROR: Container '${DB_CONTAINER}' is not running."
    exit 1
fi

mkdir -p "${BACKUP_DIR}"

# ── Dump ─────────────────────────────────────────────────────────────
log "Starting pg_dump of '${DB_NAME}' from container '${DB_CONTAINER}'..."

docker exec "${DB_CONTAINER}" \
    pg_dump -U "${DB_USER}" --format=plain --no-owner --no-acl "${DB_NAME}" \
    > "${DUMP_FILE}"

DUMP_SIZE=$(du -h "${DUMP_FILE}" | cut -f1)
log "Dump complete: ${DUMP_FILE} (${DUMP_SIZE})"

# ── Compress ─────────────────────────────────────────────────────────
log "Compressing with gzip..."
gzip "${DUMP_FILE}"

GZIP_SIZE=$(du -h "${GZIP_FILE}" | cut -f1)
log "Compressed: ${GZIP_FILE} (${GZIP_SIZE})"

# ── Prune old backups ───────────────────────────────────────────────
log "Pruning backups older than ${RETAIN_DAYS} days..."

PRUNED=0
while IFS= read -r -d '' OLD_FILE; do
    log "  Removing: $(basename "${OLD_FILE}")"
    rm -f "${OLD_FILE}"
    PRUNED=$((PRUNED + 1))
done < <(find "${BACKUP_DIR}" -name "synapse-*.sql.gz" -type f -mtime +${RETAIN_DAYS} -print0 2>/dev/null)

if [[ ${PRUNED} -eq 0 ]]; then
    log "No backups older than ${RETAIN_DAYS} days to prune."
else
    log "Pruned ${PRUNED} old backup(s)."
fi

# ── Summary ──────────────────────────────────────────────────────────
REMAINING=$(find "${BACKUP_DIR}" -name "synapse-*.sql.gz" -type f 2>/dev/null | wc -l | tr -d ' ')
log "Done. ${REMAINING} backup(s) in ${BACKUP_DIR}."
