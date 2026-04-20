#!/bin/sh
# Windy Chat — Coturn entrypoint (prod)
#
# Renders /etc/turnserver.conf.template (bind-mounted read-only from
# deploy/synapse/turnserver.conf) to /tmp/turnserver.conf, replacing
# the __COTURN_*__ placeholders with the container's environment.
#
# We render at start rather than baking values into the image because:
#   - COTURN_SHARED_SECRET lives in the lockbox + .env.production and
#     must never be committed.
#   - COTURN_EXTERNAL_IP is instance-specific (auto-assigned EIP today,
#     allocated EIP once Grant's quota request lands).
#
# sed (not envsubst) because envsubst lives in gettext which isn't in
# the coturn/coturn Alpine image — sed ships everywhere.
#
# History: introduced in Wave 14 to fix Wave 13 Phase 4 P1-2 — coturn
# had been running with compiled-in defaults because the intended
# turnserver.conf didn't exist in the repo.

set -eu

TEMPLATE=/etc/turnserver.conf.template
RENDERED=/tmp/turnserver.conf

: "${COTURN_SHARED_SECRET:?required}"
: "${COTURN_REALM:?required}"
: "${COTURN_EXTERNAL_IP:?required}"

if [ ! -f "$TEMPLATE" ]; then
    echo "[coturn-entrypoint] FATAL: $TEMPLATE not bind-mounted" >&2
    exit 1
fi

# Use `|` as delimiter since secrets can contain / but not |.
sed \
    -e "s|__COTURN_SHARED_SECRET__|${COTURN_SHARED_SECRET}|g" \
    -e "s|__COTURN_REALM__|${COTURN_REALM}|g" \
    -e "s|__COTURN_EXTERNAL_IP__|${COTURN_EXTERNAL_IP}|g" \
    "$TEMPLATE" >"$RENDERED"

# Quick sanity check: the rendered config must not contain any
# unsubstituted __COTURN_*__ tokens.
if grep -q '__COTURN_' "$RENDERED"; then
    echo "[coturn-entrypoint] FATAL: unsubstituted placeholders in $RENDERED" >&2
    grep -n '__COTURN_' "$RENDERED" >&2
    exit 1
fi

# Cert readability check — cert paths render literally (they are inside
# the container) so we can verify before calling turnserver, which
# otherwise fails with a less-specific "cannot load cert" message.
for f in /etc/coturn-certs/fullchain.pem /etc/coturn-certs/privkey.pem; do
    if [ ! -r "$f" ]; then
        echo "[coturn-entrypoint] FATAL: cannot read $f — run scripts/setup-coturn-certs.sh on the host and restart coturn" >&2
        exit 1
    fi
done

echo "[coturn-entrypoint] rendered config, starting turnserver..."
exec turnserver -c "$RENDERED"
