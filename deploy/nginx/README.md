# Windy Chat — Production nginx config

The host nginx on the chat EC2 (`i-0f603361b88baa4c0`) terminates TLS at chat.windychat.ai:443 and reverse-proxies to the 4 Node microservices + Synapse on the loopback Docker network.

## Files

| File | Source | Purpose |
|------|--------|---------|
| `chat.windychat.ai.conf` | mirrors `/etc/nginx/sites-available/chat.windychat.ai` on prod | Server block (port 80 redirect + port 443 TLS + per-path proxy_pass to each microservice) |

## Apply to a fresh box

```bash
sudo cp deploy/nginx/chat.windychat.ai.conf /etc/nginx/sites-available/chat.windychat.ai
sudo ln -sf /etc/nginx/sites-available/chat.windychat.ai /etc/nginx/sites-enabled/chat.windychat.ai
sudo nginx -t && sudo systemctl reload nginx
```

## Route map

| Path | Backend |
|------|---------|
| `/.well-known/matrix/*` | Returns static JSON delegation |
| `/_matrix/*` `/_synapse/client/*` | Synapse (`:8008`) |
| `/version` | onboarding (`:8101`) — MF1 deployment-identity |
| `/api/v1/onboarding/*` `/api/v1/webhooks/*` `/api/v1/chat/{provision,profile,verify,pair,agent-room}` | onboarding (`:8101`) |
| `/api/v1/chat/directory/*` | directory (`:8102`) |
| `/api/v1/push/*` `/api/v1/chat/push/*` | push-gateway (`:8103`) |
| `/api/v1/backup/*` | backup (`:8104`) |
| Fallback | Returns 404 `{"error":"not found"}` |
