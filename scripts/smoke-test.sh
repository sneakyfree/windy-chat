#!/usr/bin/env bash
# Windy Chat — production smoke test
#
# Usage:
#   ./scripts/smoke-test.sh [BASE_URL]
#
# BASE_URL defaults to https://chat.windychat.com. Pass a different host
# to smoke-test a staging deploy:
#   ./scripts/smoke-test.sh https://chat.staging.windychat.com
#
# Requires:
#   - curl, jq, node (for the JWT signing step), openssl
#   - Environment variables from .env.production (PUSH_BUS_TOKEN at
#     minimum; WINDY_JWT_SECRET for the unified-login check). If the
#     script is run from the repo root and .env.production exists, it
#     is sourced automatically.
#
# Exits non-zero on the first failed probe so CI / the deploy runbook
# can gate on it.

set -euo pipefail

BASE_URL="${1:-https://chat.windychat.com}"
BASE_URL="${BASE_URL%/}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/.env.production" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO_ROOT/.env.production"; set +a
fi

log()   { printf "\033[1;34m[smoke]\033[0m %s\n" "$*"; }
pass()  { printf "\033[1;32m  ✓\033[0m %s\n" "$*"; }
fail()  { printf "\033[1;31m  ✗\033[0m %s\n" "$*" >&2; exit 1; }

need()  { command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"; }
need curl
need jq
need node
need openssl

log "target: $BASE_URL"

# ──────────────────────────────────────────────────────────────────────
# 1. Synapse alive (client API)
# ──────────────────────────────────────────────────────────────────────
log "1/4 Synapse client versions"
resp=$(curl -fsS -m 10 "$BASE_URL/_matrix/client/versions") \
  || fail "Synapse /_matrix/client/versions did not respond"
echo "$resp" | jq -e '.versions | length > 0' >/dev/null \
  || fail "client versions response missing 'versions[]'"
pass "client API live ($(echo "$resp" | jq -r '.versions[-1]'))"

# ──────────────────────────────────────────────────────────────────────
# 2. Federation endpoint reachable
# ──────────────────────────────────────────────────────────────────────
# Always served, even when federation is disabled — the closed homeserver
# still announces its Synapse version on this path. A connect/TLS failure
# is the only real failure mode here.
log "2/4 Synapse federation endpoint"
fed_http=$(curl -fsS -m 10 -o /tmp/smoke-fed.json -w '%{http_code}' \
  "$BASE_URL/_matrix/federation/v1/version" || true)
case "$fed_http" in
  200)
    name=$(jq -r '.server.name' < /tmp/smoke-fed.json)
    pass "federation endpoint live (server=$name)"
    ;;
  403)
    pass "federation endpoint live (closed to external peers — 403)"
    ;;
  *)
    fail "federation endpoint returned HTTP $fed_http"
    ;;
esac

# ──────────────────────────────────────────────────────────────────────
# 3. /api/v1/onboarding/unified-login accepts a signed test JWT
# ──────────────────────────────────────────────────────────────────────
log "3/4 unified-login accepts signed JWT"
: "${WINDY_JWT_SECRET:?set WINDY_JWT_SECRET (from .env.production) to run this probe}"
: "${SMOKE_TEST_WINDY_IDENTITY_ID:=smoke_test_id_windy_chat}"

token=$(node -e '
  const crypto = require("crypto");
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: process.env.SMOKE_TEST_WINDY_IDENTITY_ID,
    windy_identity_id: process.env.SMOKE_TEST_WINDY_IDENTITY_ID,
    display_name: "Smoke Test",
    email: "smoke@windychat.com",
    iat: now,
    exp: now + 300,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o))
    .toString("base64").replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac("sha256", process.env.WINDY_JWT_SECRET)
    .update(signingInput).digest("base64")
    .replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
  process.stdout.write(`${signingInput}.${sig}`);
')

login_http=$(curl -sS -m 15 -o /tmp/smoke-login.json -w '%{http_code}' \
  -X POST "$BASE_URL/api/v1/onboarding/unified-login" \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  -d '{}')
case "$login_http" in
  200|201)
    matrix=$(jq -r '.matrix_user_id // empty' < /tmp/smoke-login.json)
    [[ -n "$matrix" ]] || fail "unified-login response missing matrix_user_id"
    pass "unified-login accepted JWT → $matrix"
    ;;
  *)
    body=$(cat /tmp/smoke-login.json 2>/dev/null || echo '')
    fail "unified-login returned HTTP $login_http — $body"
    ;;
esac

# ──────────────────────────────────────────────────────────────────────
# 4. push-gateway accepts an agent.hatched event
# ──────────────────────────────────────────────────────────────────────
log "4/4 push-gateway accepts agent.hatched"
: "${PUSH_BUS_TOKEN:?set PUSH_BUS_TOKEN (from .env.production) to run this probe}"

push_http=$(curl -sS -m 10 -o /tmp/smoke-push.json -w '%{http_code}' \
  -X POST "$BASE_URL/api/v1/push/notify" \
  -H "X-Push-Bus-Token: $PUSH_BUS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(cat <<JSON
{
  "windy_identity_id": "$SMOKE_TEST_WINDY_IDENTITY_ID",
  "event_type": "agent.hatched",
  "room_id": "!smoke:chat.windychat.com",
  "agent_name": "Smoke Bot",
  "agent_avatar_url": "https://cdn.windy.ai/smoke.png",
  "passport_number": "ET-SMOKE-0001"
}
JSON
)")

if [[ "$push_http" != "200" ]]; then
  body=$(cat /tmp/smoke-push.json 2>/dev/null || echo '')
  fail "push-gateway returned HTTP $push_http — $body"
fi
event=$(jq -r '.event_type // empty' < /tmp/smoke-push.json)
[[ "$event" == "agent.hatched" ]] || fail "push-gateway echoed unexpected event_type: $event"
pass "push-gateway accepted agent.hatched (delivered=$(jq -r '.delivered' < /tmp/smoke-push.json))"

log "all probes green"
