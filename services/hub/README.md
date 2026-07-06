# Hub service (:8109)

Hub Mode's server half: an authenticated thin proxy onto the mautrix
bridgev2 provisioning API plus the `connected_platforms` store. Clients
never talk to a bridge directly — the provisioning shared secret and the
acting `user_id` are injected server-side, pinned to the caller's own
JWT-resolved Matrix account.

## Endpoints (all JWT-authed under /api/v1/hub)

| Method/path | Purpose |
|---|---|
| `GET /platforms` | Configured platforms + caller's connections |
| `ALL /:platform/provision/v3/*` | Generic bridgev2 provisioning proxy (login flows, logout, contacts). `user_id` is always overwritten with the caller's MXID. |
| `GET /:platform/whoami` | Connection state passthrough; syncs `connected_platforms` from the bridge's authoritative login list (surfaces `BAD_CREDENTIALS` → "re-pair" UX) |

## Identity resolution

`windy_identity_id` (JWT) → Matrix user id via onboarding's SQLite,
mounted read-only at `/onboarding-data` (same pattern as agent-roster).
No chat account yet → `409 no_chat_account`.

## Connect flow (what a client renders)

1. `POST /:platform/provision/v3/login/start/<flowID>` → typed step
2. `user_input` steps (phone, code, 2FA) → `POST .../step/...`
3. `display_and_wait` steps (QR) → render payload, poll the wait
   endpoint (proxy allows ~125s long-poll; nginx location gives 150s)
4. Step `complete` → row upserted in `connected_platforms`; portal rooms
   start appearing in the user's normal Matrix sync.

See `services/bridges/README.md` for the bridge side and
`~/kit-army-config/docs/exec-guide-hub-mode-2026-07-06.md` for the full
architecture.
