# Rooms (Phase 3a) — Design

Approved in brainstorm 2026-06-11. Implementation: `feature/rooms`, target v2.9.0.

## Decisions (locked with the owner)

| Axis | Decision |
|---|---|
| Member unit | A **bridge/machine (node)** — matches hub↔spoke; kick severs the whole machine. Sessions stay local/anonymous. |
| Persistence | **JSON file, atomic writes** — `~/.claude/.cc-bridge-rooms.json` (0600, temp+rename, env-overridable `CC_BRIDGE_ROOMS_FILE`). Zero deps, node 18 OK. |
| Join paths | **Both** from day one: invite codes (primary) + optional password gate. |
| E2EE | **Design now, build as 3b** — message envelope reserves `enc`; libsodium/Argon2id arrives in 3b only. |
| Back-compat | **Legacy until first room**: single-shared-token mode is bit-identical until `room create`; then room-auth only (old tokens → clear 401). |
| Hosting/owner | Room lives on the creator's bridge; owner = creator (pubkey from `--reuse` key recorded when present). Persistent-until-deleted default; `--ttl` for ephemeral. Schema rooms-plural, ONE active room enforced in 3a. Orphaned-room risk accepted until phase 6. |
| Auth integration | **Approach 1**: member tokens ride the existing `X-Bridge-Token` header; `tokenOk()` → `roomAuth()` (hash lookup). Wire protocol otherwise untouched (lesson #24 additive principle). |

## Data model (`.cc-bridge-rooms.json`)

```json
{ "version": 1,
  "rooms": { "r_<8hex>": {
      "name": "mugyen-team",
      "created_at": 0, "expires_at": null,
      "owner": { "node": "<node>", "pubkey": "<hex|null>" },
      "password": { "salt": "<hex>", "hash": "<scrypt-hex>" },
      "members": { "<node>": { "token_hash": "<sha256>", "pubkey": null,
          "role": "owner|member", "joined_at": 0, "invited_by": "<node>" } },
      "invites": { "i_<4hex>": { "code_hash": "<sha256>", "expires_at": 0,
          "max_uses": null, "uses": 0 } } } } }
```

- Tokens + invite codes stored **hashed** (sha256); plaintext shown once at mint.
- Password gate: **scrypt** (`node:crypto`, zero-dep; Argon2id is 3b's E2EE KDF only).
- `pubkey` captured at join when the spoke has a `--reuse` key (future signed handshakes; unused in 3a).
- Kick = delete member entry. TTL: `expires_at` checked lazily on auth + GC sweep; expiry deletes the room.

## Wire protocol

- `roomAuth(req)`: no rooms → legacy `FED.token` compare. Rooms exist → sha256(header) → member lookup in the active room; attach `{node, role}`. `/health/ping` stays ungated.
- `POST /link/join` `{node, invite_code | password, pubkey?}` → mints 32-byte member token (plaintext returned once). Existing member re-joining with valid credentials → token **rotated** (lost-token recovery). Strict global rate bucket (~10/min) — the password brute-force surface.
- Join-link fragments: `…#invite:<code>` (exchanged via /link/join) and legacy `…#<token>` (legacy mode only). Password joins: `join '<url>' --password` interactive prompt — never in links.
- Kick/admin: **loopback-only endpoints on the MAIN listener** (`/room/*`, same defense as `/link/reload`: loopback + token-gate when token set). Local caller = owner; no owner-token plumbing in 3a. Kick deletes member, closes their `/link/stream`, prunes `pendingRelay`.

## CLI

`room create <name> [--ttl <dur>] [--password [gen]]` · `room invite [--one-time] [--expires <dur>]` (prints full join link from current share URL; warns if not sharing; default 7d/unlimited) · `room members` · `room kick <node>` · `room rotate <node>` · `room rotate-password` · `room info` · `room delete` (confirm) · `join '<link>' [--password]`. `doctor`/`health`/`status` gain a room line. `share` unchanged.

## E2EE-ready envelope (3a reserves, 3b builds)

Optional `enc: {alg, nonce, ct}` on message objects; when present `question`/`content` absent and all hub paths treat the message as opaque (`injectRemote` passes through; ask-dedup skips; logs already length-only). 3b: room key = Argon2id(password) via libsodium-wrappers (CLI-side), encrypt at origin bridge / decrypt at destination bridge; sessions never handle crypto. Accepted degradations: no scratchpad reading through a blind hub, no dedup for encrypted asks.

## Testing

`tests/test-rooms.mjs` (TestBridge + `CC_BRIDGE_ROOMS_FILE` scratch): create→invite→join→message→kick→401; **restart → kicked stays kicked**; invite expiry/one-time; password join/wrong/rate-limit; legacy fallback; TTL sweep; token rotation. `tests/test-room-cli.sh`: verb parsing + link fragments. Existing suites stay green (they run legacy mode = back-compat proof).

## Out of scope (3a)

E2EE build (3b) · multiple active rooms · remote admin (owner from another machine) · signed handshakes · ownership transfer · message persistence.
