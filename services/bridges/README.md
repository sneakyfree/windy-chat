# Hub Mode bridges

Matrix appservice bridges (mautrix, bridgev2 generation) that put each
user's external chat accounts — Telegram first; Slack/WhatsApp/Discord
later — into their Windy Chat room list as ordinary Matrix rooms.
Strategy, risk ladder, and build phases:
`~/kit-army-config/docs/exec-guide-hub-mode-2026-07-06.md`.

## How a bridge plugs in

1. Bridge daemon runs as a compose service behind the `hub` profile
   (never started by the deploy workflow — bridge state is precious and
   lives in `/opt/windy-chat-data/bridges/<network>` in prod).
2. Its appservice registration (bridge-generated) plus the shared
   `doublepuppet-registration.yaml` are installed into Synapse's
   `appservices/` dir and listed in `app_service_config_files`.
3. Synapse restart activates it (operator-gated in prod — P0 kernel).
4. The **hub service** (`services/hub/`, :8109) exposes the bridge's
   provisioning API to clients as `/api/v1/hub/<network>/provision/*` —
   one generic connect flow for every network (typed login steps:
   text input / cookies / QR-and-wait).

Everything is config-only on upstream images (AGPL compliance: run
unmodified, talk over HTTP). Never fork a bridge; contribute upstream.

## Enable (per network)

```bash
# env prereqs documented in .env.production.example (Hub Mode section)
sudo -E ./scripts/enable-hub-bridge.sh telegram
```

The script is idempotent: generate config → patch
(`scripts/hub/patch-telegram-config.py`) → generate registration →
install registrations → wire homeserver.yaml → start bridge → print the
(gated) Synapse restart command.

## Conventions every bridge must keep

- **Backfill caps ON** (`max_initial_messages` ~50): mobile clients
  full-sync every room today; an uncapped WhatsApp/Discord backfill
  would blow up initial sync (exec guide §4.5).
- **e2be ON** (`encryption.allow/default: true`): portal plaintext never
  rests in Synapse events.
- **Permissions**: `<server_name>: user`, admin = `HUB_ADMIN_MXID` only.
- **Puppet namespaces** feed two consumers: client provenance badges
  (`@telegram_…`) and `windy_push_bus.py`'s `ignore_sender_patterns`
  (keep both lists in sync when adding a network).
- **provisioning shared_secret** goes in `.env.production` +
  lockbox `ACCESS_LOCKBOX.md` §HUB-MODE; it must never reach a client —
  only the hub service holds it.
