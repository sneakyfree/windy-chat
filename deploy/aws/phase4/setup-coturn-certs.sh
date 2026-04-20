#!/usr/bin/env bash
# Wave 14 — refresh the coturn-readable copy of the Let's Encrypt cert.
#
# Coturn runs as nobody:nogroup and cannot traverse /etc/letsencrypt/archive
# (which certbot leaves mode 0700 root:root). This script copies the live
# fullchain + privkey into /opt/windy-chat-data/coturn/certs with a
# coturn-readable ownership, so the container can bind-mount the dir and
# read the PEMs at startup.
#
# Re-run after every certbot renewal — or wire it into a certbot
# --deploy-hook so renewals don't silently break TLS TURN:
#
#     sudo certbot renew --deploy-hook /opt/windy-chat/deploy/aws/phase4/setup-coturn-certs.sh
#
# Idempotent: running it N times produces the same state.

set -euo pipefail

DOMAIN="${DOMAIN:-chat.windychat.ai}"
SRC="/etc/letsencrypt/live/${DOMAIN}"
DST="/opt/windy-chat-data/coturn/certs"
# Coturn's Alpine image uses uid 65534 / gid 65534 for nobody:nogroup.
COTURN_UID="${COTURN_UID:-65534}"
COTURN_GID="${COTURN_GID:-65534}"

if [[ $EUID -ne 0 ]]; then
    echo "[setup-coturn-certs] must run as root (needs /etc/letsencrypt/archive read access)" >&2
    exit 1
fi

if [[ ! -d "$SRC" ]]; then
    echo "[setup-coturn-certs] FATAL: $SRC not found — has certbot run for ${DOMAIN}?" >&2
    exit 1
fi

install -d -m 0755 -o "${COTURN_UID}" -g "${COTURN_GID}" "$DST"

# Copy dereferenced symlinks — coturn reads the files directly, it
# doesn't care that the sources were symlinked.
install -m 0644 -o "${COTURN_UID}" -g "${COTURN_GID}" \
    "$(readlink -f "${SRC}/fullchain.pem")" "${DST}/fullchain.pem"
install -m 0640 -o "${COTURN_UID}" -g "${COTURN_GID}" \
    "$(readlink -f "${SRC}/privkey.pem")" "${DST}/privkey.pem"

# Optional dhparam — if present, ship it too; coturn.conf `dh-file`
# is commented by default so this is just forward-compatible.
if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    install -m 0644 -o "${COTURN_UID}" -g "${COTURN_GID}" \
        /etc/letsencrypt/ssl-dhparams.pem "${DST}/ssl-dhparams.pem"
fi

echo "[setup-coturn-certs] refreshed ${DST} for ${DOMAIN}"
ls -la "$DST"

# If coturn is running, trigger it to re-read the cert. SIGUSR2 asks
# coturn to reload TLS certs without dropping active sessions.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^windy-coturn$'; then
    docker kill --signal=SIGUSR2 windy-coturn 2>/dev/null \
        && echo "[setup-coturn-certs] sent SIGUSR2 to windy-coturn (cert reload, no restart)" \
        || echo "[setup-coturn-certs] coturn running but SIGUSR2 failed — restart manually if TLS handshake complains"
fi
