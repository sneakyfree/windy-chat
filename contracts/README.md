# contracts/ — Windy Chat's agent-OPS manifest

`ops.mcp.v1.json` is the **canonical source of truth** for Windy Chat's remote
agent-ops surface, governed by the Agent Control Doctrine (**ADR-060** in
`sneakyfree/windy-contracts`).

**Chat is a multi-service constellation** (~13 services over Synapse). The
retrofit's headline finding: there is no fleet-health aggregator and per-
service `/health` isn't externally routed. The **#1 build item** is that
aggregator — see `windy-contracts/docs/MULTI-SERVICE-OPS.md`
(`GET /api/v1/ops/health`, fan-out, nginx-routed, EPT-gated). Once it exists,
point `get_health`/`get_status`/`get_capabilities` at it and re-weave.

Until then this manifest honestly binds only Synapse core liveness. Product
paths (`/_matrix/*`, `/api/v1/{service}/*`) stay out of ops per §2. Privacy
hard line: never expose message bodies/subjects. Change control: additive →
`v1.1` via PR; breaking → new `v2` + tell Grant.
