#!/usr/bin/env python3
"""
Hub Mode — patch a freshly-generated mautrix bridgev2 config.yaml with
Windy Chat's values. Generic across networks (telegram/slack/whatsapp);
network-specific credentials are applied only where a network needs them
(telegram: api_id/api_hash — slack and whatsapp puppet with per-user
logins and need no app credentials). Run INSIDE a container that has
PyYAML (the synapse image does); enable-hub-bridge.sh drives it:

  patch-bridge-config.py <network> /bridge-data/config.yaml

Required env (all networks): HUB_BRIDGE_<NETWORK>_PROVISIONING_SECRET,
DOUBLEPUPPET_AS_TOKEN. Telegram additionally: TELEGRAM_API_ID/API_HASH.
"""

import os
import sys

import yaml


def require_env(name: str) -> str:
    v = os.environ.get(name, "")
    if not v or v.startswith("REPLACE_ME"):
        print(f"FATAL: env var {name} is not set", file=sys.stderr)
        sys.exit(1)
    return v


def set_path(cfg, dotted, value, missing):
    """Set cfg[a][b][c] = value; record in `missing` if the parent path
    doesn't exist (we never invent sections the bridge didn't generate)."""
    keys = dotted.split(".")
    node = cfg
    for k in keys[:-1]:
        if not isinstance(node, dict) or k not in node:
            missing.append(dotted)
            return
        node = node[k]
    if not isinstance(node, dict):
        missing.append(dotted)
        return
    node[keys[-1]] = value


def main():
    network = sys.argv[1] if len(sys.argv) > 1 else "telegram"
    path = sys.argv[2] if len(sys.argv) > 2 else "/bridge-data/config.yaml"
    with open(path) as f:
        cfg = yaml.safe_load(f)

    prov_secret = require_env(f"HUB_BRIDGE_{network.upper()}_PROVISIONING_SECRET")
    dp_token = require_env("DOUBLEPUPPET_AS_TOKEN")
    server_name = os.environ.get("SYNAPSE_SERVER_NAME", "chat.windychat.ai")
    admin_mxid = os.environ.get("HUB_ADMIN_MXID", "@grant.whitmer:" + server_name)

    missing = []

    set_path(cfg, "homeserver.address", "http://synapse:8008", missing)
    set_path(cfg, "homeserver.domain", server_name, missing)
    # The bridge's own HTTP listener — synapse + hub reach it by container DNS.
    set_path(cfg, "appservice.address", f"http://bridge-{network}:29317", missing)
    set_path(cfg, "appservice.hostname", "0.0.0.0", missing)
    set_path(cfg, "appservice.port", 29317, missing)
    if network == "telegram":
        set_path(cfg, "network.api_id", int(require_env("TELEGRAM_API_ID")), missing)
        set_path(cfg, "network.api_hash", require_env("TELEGRAM_API_HASH"), missing)
    set_path(cfg, "database.type", "sqlite3-fk-wal", missing)
    set_path(
        cfg,
        "database.uri",
        f"file:/data/mautrix-{network}.db?_txlock=immediate",
        missing,
    )
    set_path(cfg, "provisioning.shared_secret", prov_secret, missing)
    set_path(cfg, "provisioning.debug_endpoints", False, missing)
    # Double puppeting: one wildcard appservice registration lets the bridge
    # masquerade as any local user — zero per-user action.
    if isinstance(cfg.get("double_puppet"), dict):
        cfg["double_puppet"]["secrets"] = {server_name: f"as_token:{dp_token}"}
    else:
        missing.append("double_puppet.secrets")
    # e2be — encrypted portal rooms; Synapse never sees bridged plaintext.
    set_path(cfg, "encryption.allow", True, missing)
    set_path(cfg, "encryption.default", True, missing)
    # Only Windy Chat users may use the bridge; admin gets bridge admin cmds.
    if isinstance(cfg.get("bridge"), dict) and "permissions" in cfg["bridge"]:
        cfg["bridge"]["permissions"] = {
            server_name: "user",
            admin_mxid: "admin",
        }
    else:
        missing.append("bridge.permissions")
    # Backfill caps — mobile clients full-sync every room (exec guide §4.5);
    # bound what a fresh pairing pulls in until sliding-sync/persistent
    # stores land client-side.
    for base in ("backfill", "bridge.backfill"):
        node = cfg
        ok = True
        for k in base.split("."):
            if isinstance(node, dict) and k in node:
                node = node[k]
            else:
                ok = False
                break
        if ok and isinstance(node, dict):
            node["enabled"] = True
            if "max_initial_messages" in node:
                node["max_initial_messages"] = 50
            if "max_catchup_messages" in node:
                node["max_catchup_messages"] = 200
            if "unread_hours_threshold" in node:
                node["unread_hours_threshold"] = 720
            break
    else:
        missing.append("backfill")

    with open(path, "w") as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)

    print(f"patched {path}")
    if missing:
        print("\n⚠️  COULD NOT PATCH (finish by hand before starting the bridge):")
        for m in missing:
            print(f"   - {m}")
        sys.exit(2)


if __name__ == "__main__":
    main()
