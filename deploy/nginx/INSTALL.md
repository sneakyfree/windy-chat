# windy-chat nginx — install / update runbook

The host nginx on EC2 i-0f603361b88baa4c0 terminates TLS for `chat.windychat.ai` and reverse-proxies to the 4 Node services + Synapse on the compose network.

## Wave C — Synapse admin gateway

Lets the windy-connect orchestrator Worker reach `/_synapse/admin/v1/users/.../login` + `/_synapse/admin/v2/users/...` over the public hostname. Until this rolls out, those endpoints 404 at the edge even though they work from inside the EC2 (verified via `curl http://127.0.0.1:8008/_synapse/admin/v1/server_version`).

### One-time install

```bash
ssh ubuntu@chat.windychat.ai

# 1. Generate or fetch the gateway token (independent of the Synapse
#    access token — this is the gateway-level "are you in the allow-
#    list" check). Save to the lockbox under
#    "Synapse admin gateway token (windy-connect → chat.windychat.ai)".
NEW_TOKEN="$(openssl rand -base64 32 | tr -d '=+/' | head -c 44)"
echo "Token: $NEW_TOKEN"

# 2. Instantiate the gate template with the real token. Lives at
#    /etc/nginx/windy-synapse-admin-gate.conf (referenced from
#    /etc/nginx/nginx.conf's http{} via an include).
sudo tee /etc/nginx/windy-synapse-admin-gate.conf > /dev/null <<EOF
map \$arg_unused \$synapse_admin_gateway_token {
    default "$NEW_TOKEN";
}
EOF
sudo chmod 0640 /etc/nginx/windy-synapse-admin-gate.conf
sudo chown root:www-data /etc/nginx/windy-synapse-admin-gate.conf

# 3. Ensure /etc/nginx/nginx.conf includes the gate file inside the
#    http{} block. Idempotent — won't add a duplicate.
if ! grep -q "windy-synapse-admin-gate.conf" /etc/nginx/nginx.conf; then
    sudo sed -i '/^http {$/a\    include /etc/nginx/windy-synapse-admin-gate.conf;' /etc/nginx/nginx.conf
fi

# 4. Update the per-site config (chat.windychat.ai.conf) with the new
#    /_synapse/admin/ location block. Pull from this repo:
sudo curl -fsS https://raw.githubusercontent.com/sneakyfree/windy-chat/main/deploy/nginx/chat.windychat.ai.conf \
    -o /etc/nginx/sites-enabled/chat.windychat.ai.conf

# 5. Verify + reload (NEVER restart — see feedback_caddy_inode_binding_v2,
#    same principle applies to nginx full restarts dropping listening sockets).
sudo nginx -t
sudo systemctl reload nginx
```

### Smoke test

From any machine with internet:

```bash
# Missing header → 403
curl -sS -o /dev/null -w '%{http_code}\n' \
    https://chat.windychat.ai/_synapse/admin/v1/server_version
# Expect: 403

# Wrong header → 403
curl -sS -o /dev/null -w '%{http_code}\n' \
    -H "X-Windy-Connect-Admin-Token: wrong" \
    https://chat.windychat.ai/_synapse/admin/v1/server_version
# Expect: 403

# Correct gateway token but no Synapse access token → 401 from Synapse
curl -sS -o /dev/null -w '%{http_code}\n' \
    -H "X-Windy-Connect-Admin-Token: $NEW_TOKEN" \
    https://chat.windychat.ai/_synapse/admin/v1/server_version
# Expect: 401  (nginx passed; Synapse rejected unauth)

# Correct gateway token + correct Synapse access token → 200
curl -sS \
    -H "X-Windy-Connect-Admin-Token: $NEW_TOKEN" \
    -H "Authorization: Bearer $SYNAPSE_ADMIN_TOKEN" \
    https://chat.windychat.ai/_synapse/admin/v1/server_version
# Expect: {"server_version":"1.x.x","python_version":"3.x.x"}
```

### Worker-side update

Add the gateway token to the windy-connect Worker's secrets:

```bash
cd ~/windy-connect/backend
echo -n "$NEW_TOKEN" | npx wrangler secret put SYNAPSE_ADMIN_GATEWAY_TOKEN
```

The Worker's `provisionChat` function in `src/provision.ts` reads this and sends both headers when calling Synapse admin.

### Rollback

If anything goes wrong:

```bash
# Empty the gate file → location block returns 503 → Worker degrades
# to sandbox Chat (same as before Wave C).
sudo tee /etc/nginx/windy-synapse-admin-gate.conf > /dev/null <<'EOF'
map $arg_unused $synapse_admin_gateway_token {
    default "";
}
EOF
sudo nginx -t && sudo systemctl reload nginx
```

The per-site config block itself is safe to leave in place — without a token it returns 503 not 5xx, and existing routes (`/_matrix/`, `/_synapse/client/`) are unaffected.
