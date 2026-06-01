# Spec: Cross-Network Federation (hub-and-spoke bridge linking)

**Status:** Designed, not yet implemented. Shelved as future work (2026-05-29).
**Author conversation:** brainstormed with the owner; this doc is the implementation record for "later."
**Supersedes:** the earlier, simpler "one shared bridge over a tunnel" sketch (see *Rejected alternatives*).

---

## 1. Goal

Let Claude sessions on **different machines / networks** talk to each other through the bridge, while:

- **Setup stays trivial** — one command to host, one command to join.
- **Local-survival on drop** — when the cross-network link breaks, each machine's sessions keep coordinating locally, uninterrupted. Cross-network resumes automatically on reconnect, with **no messages lost**.
- **No new infra for users** — everyone already runs a local bridge; only the hub-owner runs a tunnel.
- **Honest security** — TLS in transit + a shared token; suitable for a *trusted* group.

The non-negotiable that shapes everything: **a Claude session connects to exactly one MCP server, fixed at session start — the harness gives no way to hot-swap a running session's bridge.** Therefore sessions must *always* point at their own **local** bridge, and all cross-network logic lives at the **bridge** layer.

---

## 2. Chosen design: hub-and-spoke federation ("sessions always local")

This is the IRC/Matrix/email pattern: clients talk to their own local server; servers link and relay. We use the simplest topology — **one central hub, every other bridge is a spoke** ("one person runs the central thing").

```
 Your sessions ─▶ YOUR bridge ◀═══ link (tunnel) ═══▶ HUB bridge ◀─ hub-owner's sessions
                  (localhost)          token-gated         (localhost)
        local-to-local never leaves the machine; only cross-network rides the link
```

### Core principle — the link injects remote messages into the LOCAL store

The link layer's only jobs are:

1. **Roster sync** — each spoke advertises its local sessions (name + description) to the hub; the hub broadcasts a merged **global roster** to all spokes. `list_sessions` then returns local + remote.
2. **Message relay** — a message addressed to a **remote** target is forwarded hub-ward and **injected into the destination bridge's local `messages` store as if it had arrived locally.** Replies relay back the same way.

Because remote messages land in the local store, **every existing delivery path works unchanged**: the PostToolUse `/pending` injection, the Stop hook, the idle-listener (peek + Monitor), `check_inbox`, blocking `ask`, one-way `notify`, `get_thread`. We are adding a routing/relay layer, **not** rewriting each tool handler.

### What this buys us on the drop question

Sessions never left local, so a link drop means only: "the local bridge can't currently reach the hub." Local coordination is **completely unaffected**. The link reconnects in the background; queued cross-network messages (already persisted in each bridge's `messages` map, 30-day TTL) **flush on resume**. Lossless, by reusing machinery we already ship.

---

## 3. Transport & security

- **Default transport:** Cloudflare **Quick Tunnel** (`cloudflared tunnel --url …`) — no account, no config, automatic HTTPS, ephemeral URL. Best-effort; great for a working session, not 24/7. **Upgrade paths for always-on:** a *named* Cloudflare tunnel (free account + domain) or self-host + Caddy auto-TLS (you hold the cert).
- **Honest encryption note:** a tunnel gives **TLS in transit** (no on-wire eavesdropping) but the provider terminates TLS — it is *not* strict end-to-end. True E2E needs a VPN (Tailscale/WireGuard), which the owner explicitly does not want to set up. For a trusted group + token, TLS-in-transit is the accepted bar. Self-host + own cert is the closest no-VPN path to "no third party sees plaintext."
- **What the tunnel exposes:** only the **federation link endpoint** (bridge-to-bridge), token-gated. **Local session SSE (`localhost:7400`) is never tunneled** — a cleaner security boundary than exposing the raw bridge.
- **Token auth:**
  - A shared secret per hub. Sent as an `X-Bridge-Token` **header** (not in the URL — keeps it out of logs / `claude mcp list`).
  - Stored in a **token file** (`~/.claude/.cc-bridge-token`) the bridge reads; `--join` writes the hub's token there on the spoke. Local session traffic on loopback needs no token; **the link endpoint always requires it.**
  - **`/health` and the federation endpoint are gated** when a token is set, so the public endpoint can't leak session names/descriptions.
  - Guardrail: refuse to expose the federation endpoint (run as hub) without a token set.
- **Accepted limitation:** within a trusted group, session names are self-asserted — a member could claim another member's name. Documented, not engineered against (trusted-group assumption). Cross-machine name clashes are handled by qualification (§5).

---

## 4. The link protocol (zero new deps — reuse SSE + HTTP)

Bridge-to-bridge link mirrors the existing MCP-over-SSE shape, so no new transport tech:

- **Spoke → hub (HTTP POST, token header):** `link/register` (advertise local sessions), `link/forward` (relay a message/reply to a remote target), `link/heartbeat`.
- **Hub → spoke (SSE stream):** merged-roster updates, and forwarded messages destined for that spoke's local sessions.
- The hub maintains: connected spokes, each spoke's advertised sessions, and the merged global roster. It routes a forwarded message to the owning spoke's SSE stream.
- **Heartbeat / liveness:** same lesson as local SSE (TCP keepalive + prune-on-write-error) applies to the link, so a dead spoke de-registers from the global roster within tens of seconds. (This builds on the local liveness tweak — see *Prerequisites*.)

---

## 5. Name resolution & routing

- **Global roster key:** qualify remote names by node, e.g. `frontend@alice`. Local names stay bare locally; the merged roster shows remote entries qualified. `ask(to="frontend@alice")` routes to alice's spoke.
- **Target resolution in tool handlers becomes:** is `to` a **local** session (existing `nameToSSE`) → deliver locally (current code path); else is it in the **global roster** (remote) → hand to the relay (forward hub-ward); else → "not connected" error listing the merged roster.
- **Phase 1** may require unique bare names across the group (simple) and add `@node` qualification; **Phase 2** polishes auto-suffixing / collision UX.

---

## 6. UX

| Action | Command | Sessions reconfigure? |
|---|---|---|
| Be the hub | `./claude-bridge --share` → starts bridge, generates token, opens tunnel, prints a join link | **No** |
| Join a hub | `./claude-bridge --join '<join-link>'` → links *your local bridge* upstream | **No** — sessions stay on localhost |
| Drop happens | (nothing) | Local keeps working; cross-network auto-resumes |
| Leave / stop | `./claude-bridge --unlink` (spoke) · `--stop-share` or Ctrl-C (hub) | No |

Sample host output:

```
$ ./claude-bridge --share
  ✓ Bridge running   ✓ Generated access token   ✓ Secure tunnel open (Cloudflare)
  Share this ONE command:
    ./claude-bridge --join 'https://calm-river-1234.trycloudflare.com#<token>'
  Keep this terminal open (or run as a service). Ctrl-C to close the channel.
```

Join link format: `https://<tunnel-host>#<token>` (token in the URL **fragment**, which is not sent to servers / not logged by the tunnel; `--join` parses it locally into the header + token file).

**Prerequisites (one-time, plain):** both sides install claude-bridge once (the existing `curl … | bash`); the hub-owner installs `cloudflared` once (`brew install cloudflared`, no account). The bridge stays **zero-dependency**; `cloudflared` is an external runtime tool the `--share` helper detects and instructs on.

---

## 7. Code impact (what gets touched)

Additive routing/relay layer + roster federation. Touch points:

- **`bridge-server.mjs`:**
  - New: federation link endpoints (`/link/*` over HTTP+SSE), spoke/hub state, merged-roster maintenance, relay/forward logic, the "inject remote message into local `messages` store" path, link liveness.
  - Modified (small): `activeSessions()` / `list_sessions` to include the global roster; target resolution in `ask`/`reply`/`notify`/`get_thread` to branch local-vs-remote; token gate on link + `/health`.
  - Unchanged: the entire local delivery machinery (`/pending`, `getPendingFor`, `check_inbox`, the kind/notice logic, migration) — remote messages flow through it untouched.
- **`hooks/*.sh`:** **unchanged** — sessions and hooks stay on `localhost`. (This is the big simplification vs. the rejected "URL-aware hooks" sketch.)
- **`claude-bridge`:** `--share`, `--join`, `--unlink`, `--stop-share`; token file management; `cloudflared` detection/launch; print/parse the join link.
- **Docs:** USAGE (the cross-network section + the security/honesty notes), README ("what this is" — cross-network), SKILL/BRIDGE (qualified names `name@node`, that remote talk is transparent), DEVELOPER (new lessons on federation + token file + link liveness), CHANGELOG.
- **Tests:** a two-bridge link harness in `tests/` — spoke registers, roster merges, a cross-link `ask`/`reply` round-trips, a `notify` relays, link drop pauses cross-network but local still works, link reconnect flushes queued messages, token rejected/accepted on the link endpoint.

---

## 8. Phasing

- **Phase 1 (core magic):** link establishment + token; roster sync (merged `list_sessions`); relay of `ask`/`reply`/`notify` into the remote local store; `--share`/`--join`; quick-tunnel recipe; link liveness + lossless reconnect. Unique bare names assumed.
- **Phase 2 (polish):** `name@node` qualification + collision UX; named-tunnel / self-host recipes for always-on; `--unlink`/`--stop-share` niceties; `get_thread` across the link; richer hub status (`--check` shows spokes).

---

## 9. Prerequisites / foundational pieces (could land independently, before federation)

These were designed alongside and are smaller; some are useful on their own and de-risk Phase 1:

1. **Token-auth layer** (header + token file + `/health` gate) — needed by the link; usable on its own to lock down a LAN-exposed bridge.
2. **Link/SSE liveness tweak** (TCP keepalive + prune-on-write-error) — tightens *local* ghost de-merge from minutes to ~30–60s too; broadly useful.

The earlier "URL-aware hooks" idea is **dropped** — it's unnecessary under this design (sessions stay local).

---

## 10. Rejected alternatives

- **Single shared bridge, remote clients point at it (design "A").** Simplest, but a link drop cuts a joiner's sessions off from *everyone, including each other* (they were never on a local bridge) — fails the local-survival requirement. Also exposes the raw bridge over the tunnel.
- **Live session re-pointing on drop.** Not possible — the harness can't hot-swap a running session's MCP endpoint. The "sessions always local" framing achieves the intent without it.
- **Standby/duplicate bridge + separate cross-log instance.** Over-built; the local bridge already holds local state and the link relays — no standby needed.
- **Full mesh federation (every bridge peers with every other).** Unnecessary complexity; hub-and-spoke matches "one person runs the central thing."
- **Tailscale / WireGuard mesh.** Gives true E2E and robust transport, but the owner explicitly wants no VPN/infra setup.

---

## 11. Open questions (resolve at implementation time)

- Exact join-link format and whether the token rides the URL fragment vs. a separate paste.
- Name-collision policy for Phase 1 (reject duplicate bare names vs. auto-qualify immediately).
- Whether `broadcast`/`read_scratchpad` (scratchpads) federate, or stay local-only in Phase 1.
- Hub discovery of spoke disconnect vs. graceful `--unlink` — both must converge the global roster.
- Quick-tunnel URL rotation on `cloudflared` restart — `--share` should detect and reprint the join link.
