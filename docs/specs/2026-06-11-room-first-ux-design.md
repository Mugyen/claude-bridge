# Room-First UX Redesign — Design

Approved in brainstorm 2026-06-11. Branch: `feature/rooms` (continues phase 3/4 work), target v2.10.0.

## Goal

Make the **room** the single user-facing primitive. Replace bare `share`/`stop-share`,
hide hub/spoke/standalone vocabulary, default to password-protected rooms, and make
room on/off also manage the rendezvous code. Single user → **no back-compat** to keep
(legacy shared-token mode can be removed).

## Decisions (locked with the owner)

| Axis | Decision |
|---|---|
| "DNS record" on/off | = the **rendezvous code**. Room start auto-publishes its code to the rendezvous; stop/delete release it. No real subdomains; p2p stays the default transport. |
| Lifecycle verbs | `room create` / `room start` / `room stop` / `room delete`. |
| One room per machine | **Tier-0**: at most ONE room hosted per machine (today's constraint kept). `start`/`stop` take **no name** — there's only one. Data model keeps multiple *records* so a future "saved rooms switcher" (tier-1, `start <name>`) slots in without a rewrite. |
| Default room | `room start` with no existing room **auto-creates a default** (named after the machine/node) and opens it — mirrors old `share`. `create` is the alias you use to set name/password/flags up front. |
| Password default | Rooms are **password-protected by default** (generated + printed once). `--open` makes a no-password room. |
| Pause vs destroy | `stop` keeps everything (members, password, key, code released) — reopen with `start`. `delete <name>` destroys (typed-name confirm; all tokens die, code released). `stop` NEVER deletes. |
| Hidden vocab | hub/spoke/standalone never shown to users. Output says room / owner / member / "not in a room". Internally unchanged. |
| Removed verbs | `share`, `stop-share`, `unlink` → gone (or thin aliases mapping into room verbs; see Compatibility). |
| Ownership transfer | Out of scope (owner ≡ host machine today; phase-6 splits them). Keep `owner` an explicit field so transfer is possible later. |

## Command surface

### Owner lifecycle
```
room create [<name>] [--password <v> | --open] [--e2ee] [--host-only] [--ttl <dur>]
            [--stable <host> | --tailscale]      create + open + publish code. Active now.
                                                 Default: password-protected (generated, shown once),
                                                 p2p transport (hidden default).
room start  [<name>]    open the room (auto-creates a default if none exists). No name needed
                        in tier-0 (one room). === old `share`.
room stop               close connectivity, release the code, KEEP the room. === old `stop-share`.
room delete <name>      destroy: kill member tokens, release code, remove record. Typed-name confirm.
```

`room create` output ends with the **tip**:
> "To add people without sharing the password, run `claude-bridge room invite` for a one-time token."

### Membership (owner) — unchanged behavior, room-framed wording
```
room invite [--one-time] [--expires <dur>] [--code [name]]   mint a tokenized join link (no password needed to use it)
room members | room info                                     roster (online state) · room summary
room kick <node> | room rotate <node> | room rotate-password
```

### Joiner
```
join <name>                resolve code → prompt for room password → in
join <name> --password <v> non-interactive
join '<link>'              direct link (invite token / p2p ticket) — no rendezvous needed
room leave                 leave a room you joined   (replaces "unlink")
```

### Exposure / airlock (joiner-side; room-neutral words kept)
```
sessions                          zone overview (🌐 exposed / 🔒 hidden)
expose <name>[,<name>...] | --all  move sessions INTO the room (NEW: comma-separated list + --all)
hide   <name>[,<name>...] | --all  pull sessions OUT (airlock: exposed↔hidden sealed both ways)
join <name> --expose none|all     default exposure policy at join
```
Airlock semantics unchanged (built in phase 3): exposed and hidden sessions on one
machine cannot exchange anything; enforcement at delivery on the joiner's own bridge.

## Rendezvous code lifecycle (the "DNS record")

- `create`/`start`: publish `{code → join link}` to the rendezvous (default name = room name;
  machine node id for the auto-default room). Store the owner token (`.cc-bridge-codes`).
- `stop`: release the code (DELETE with owner token) so a paused room isn't discoverable.
- `delete`: release the code too. **(Fixes the earlier gap where delete left a stale code.)**
- All best-effort: rendezvous unreachable → warn, never block; long links always work.

## status / health / doctor — room-aware redesign

Lead with **"what room, is it working, who am I"**; never headline hub/spoke. Distinguish
**active vs paused** and (for joiners) **owner-offline vs kicked** — never ambiguous.

`status` shapes:
- Owner active: `Room "x"  ● ACTIVE — you're hosting` + join hint, security (password/E2EE/expiry), members w/ online dots, open invites.
- Owner paused: `Room "x"  ⏸ PAUSED — members can't reach it. Run: claude-bridge room start`.
- Member: `In room "x" as <node>` + owner reachable/offline + your exposed/hidden counts.
- Kicked: `Removed from "x" — access revoked.`
- None: `Not in a room. Host one: room create <name> · Join one: join <name>`.

`health` = live diagnostic (server up, transport, end-to-end reachability, message counts),
room block first, jargon-free. `doctor` = deep check (drift, ports, version, log) + room
section + owner-online/paused/kicked clarity; raw hub/spoke labels dropped from headlines.

## Compatibility (single user → free to break)

- Legacy shared-token federation mode: **removed** (rooms are the only model). `--join '<url>#<token>'`
  legacy links no longer special — links are invite/p2p only.
- `share`/`stop-share`/`unlink`: removed. Optionally keep as **deprecation-aliases** that print
  "use `room start`/`room stop`/`room leave`" and do the right thing, for one version. (Decide at impl;
  default: thin aliases for muscle memory, since the user used them.)

## Out of scope (this pass)

Tier-1 saved-rooms switcher (multiple records, `start <name>`) · tier-2 concurrent live rooms ·
guest passes (one-time-invite = durable member, confirmed) · ownership transfer · phase-6 hosting.

## Testing

Extend `test-room-cli.sh` / add `test-room-ux.sh`: default-room auto-create on `start`, `stop`
keeps record + releases code, `start` re-opens + republishes, `delete` releases code, password
default + `--open`, comma-list expose/hide + `--all`, status shapes (owner active/paused, member,
kicked, none). Worker/CLI rendezvous tests already cover publish/release. All existing suites stay green.
