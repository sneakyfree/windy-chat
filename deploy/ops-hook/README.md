# windy-chat ops-hook — vendored from windy-contracts (ADR-060 §3.6)

`hook.py` is **vendored byte-identical** from the fleet-canonical ops-hook in
`sneakyfree/windy-contracts` (`ops-hook/hook.py`, v2.1+). Do not edit it here —
change the canon, re-run its tests, then re-vendor. `hook-drift.test.js` fails
if the two diverge.

## Why Chat's ops-hook is different

Chat is a **multi-service constellation** (~13 Node services + bridges over a
Synapse homeserver). Its aggregator (`GET /api/v1/ops/health`, the healing
read) shows which service is down; this hook is the matching **mutation**:
`POST /hook/restart-service {service}` restarts **one** allowlisted sibling
service (the per-service reconnect knob), gated on compose's own service state.
An agent sees `media: down`, restarts just media, leaves the other twelve
alone.

**The allowlist deliberately EXCLUDES `synapse`** (the P0 Matrix kernel — a
standing rule never to bounce it), its datastores (`synapse-db`,
`synapse-redis`), `coturn`, host-managed `nginx`, and the off-host `web` SPA.
See `deploy/ops-hook/ops-hook.env.example`.

Single-service `redeploy`/`config` are not Chat's use case (per-service
images); those knobs report disabled/verify-on-host. `restart-service` is the
value.

## Re-vendor

    cp ~/windy-contracts/ops-hook/hook.py deploy/ops-hook/hook.py
    node --test deploy/ops-hook/   # drift test green again

## Install (Grant-gated)

See the `.service` header. Mint `OPS_HOOK_TOKEN` to the unit env + lockbox,
add the nginx `/hook/*` → `127.0.0.1:8901` location (hand-managed live conf —
`nginx -t` + reload, never restart), smoke `/hook/health` (lists
`restartable_services`), then bind the namespaced per-service reconnect knob
in `contracts/ops.mcp.v1.json` and re-weave.
