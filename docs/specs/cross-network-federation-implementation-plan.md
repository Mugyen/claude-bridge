# Implementation Plan: Cross-Network Federation (hub-and-spoke bridge linking)

**Status:** Planning only. No code written. Reviewed against `bridge-server.mjs`, all five hooks, `claude-bridge`, `bridge-stdio.mjs`, the test suite, and DEVELOPER.md lessons #1–#23.
**Source of truth for the design:** `docs/specs/cross-network-federation.md`. This document does NOT redesign it — it specifies *how* to build it. Genuine concerns with the spec are flagged in §13 "Issues with the spec," not silently changed.
**Target baseline:** v2.6.2 (single file `bridge-server.mjs`, zero deps, in-memory + 30d TTL).

The cardinal rule of this feature (from the spec and the locked decisions): **federation is an additive routing/relay layer.** Remote messages get *injected into the destination bridge's local `messages` Map* so that every existing delivery path (`/pending`, Stop hook, idle-listener peek, `check_inbox`, blocking `ask`, one-way `notify`, `get_thread`) runs UNCHANGED. We are not rewriting tool handlers; we are adding a branch in target resolution + a new `/link/*` surface + a token gate. **The hooks do not change.** **Zero new npm deps.**

---

## 1. Current-architecture map (what the feature touches)

### 1.1 Data model (`bridge-server.mjs:25–43`)

| Map | Key → Value | Notes |
|---|---|---|
| `sessions` | `sseId` → `{name, description, connectedAt}` | one entry per live SSE/MCP client |
| `nameToSSE` | `name` → `sseId` | name resolution; **the routing pivot** |
| `messages` | `id` → message object | **the store federation injects into** |
| `threads` | `tkey(a,b)` → `[msgId,…]` | `tkey = [a,b].sort().join("↔")` (`:97`) |
| `scratchpad` | `name` → string | `broadcast`/`read_scratchpad` |
| `claudeIdToName` | `claudeSessionId` → `name` | hook name resolution (`/whoami`) |
| `sseClients` | `sseId` → `http.ServerResponse` | the live SSE responses (`:436`) |

**Message object shape** (`:33`, and as constructed in handlers):
- Question: `{id, from, to, question, answer:null, ts, answeredAt:null}` (`ask` at `:322`).
- Notice: `{id, from, to, kind:"notice", content, delivered:false, ts}` (`notify` at `:366`). **Carries NO `answer` field** — lesson #19.

**Invariants the relay MUST preserve:**
- **Pending == `answer === null` AND `kind !== "notice"`** — `getPendingFor` (`:130`), `/pending` (`:535`), Stop hook. (Lesson #19.)
- **A notice has no `answer`, only `delivered:boolean`.** Giving it `answer:null` makes it re-inject forever. (Lesson #19.)
- **Consume-once semantics:** notices are marked `delivered` by `/pending` (non-peek, `:581`) and by `check_inbox` (`:387`). `?peek=1` must NOT consume (lesson #21). Questions are never consumed (they persist until answered).
- **`/pending` output format is coupled to the idle-listener grep** — the grep matches `Question from|NEW QUESTION|NOTICE from|id:` and dedupes on `id: <id>` (lesson #20). Any new banner type needs an `id:` line + a grep keyword. (For Phase 1 we surface *no new banner types* — remote messages render through the existing question/notice formatters because they land in the local store with the same shape. This is a deliberate win.)

### 1.2 Message lifecycle (today)

- **`ask`** (`:302–338`): validate target is in `nameToSSE` AND live in `sseClients`; dedup against answered thread; queue message with `answer:null`; **poll the same `msg` object every 2s up to 5min**; return when `msg.answer !== null`. Resolution is *in-process polling of a shared object* — important for federation (see §5.4).
- **`reply`** (`:340–357`): find msg by id (or sole pending); set `msg.answer` + `msg.answeredAt`. The asker's poll loop sees it.
- **`notify`** (`:359–379`): queue `kind:"notice"`, never blocks.
- **`check_inbox`** (`:381–404`): returns pending questions + undelivered notices (marks them delivered).
- **`/pending`** (`:526–590`): hook-facing text render; consumes notices unless `peek`.
- **Migration** (`register`, `:247–280`): on reconnect/rename, pending asks + undelivered notices are reassigned `m.to = newName`.

### 1.3 SSE lifecycle (`:455–475`)

`GET /sse` → mint `sid`, write `event: endpoint`, register in `sseClients`, 25s keepalive ping, `req.on("close")` cleans up. **Only one SSE connection per logical client receives JSON-RPC responses** (lesson #2). The blocking `ask` returns HTTP 202 and pushes its result over SSE later (`:501–508`).

### 1.4 Error boundaries & lifecycle (`:618–663`)

`uncaughtException`/`unhandledRejection` keep the server alive (lesson #7). `server.on("error")` exits on `EADDRINUSE` (lesson #23b). Graceful shutdown sends `event: close` to all SSE clients (lesson #8). **The federation link SSE (hub→spoke) must participate in all three:** be wrapped against throws, be closed on shutdown, and reconnect cleanly (see §11).

### 1.5 Exact functions/regions the feature will touch

| Region | Change |
|---|---|
| `:25–43` state maps | **NEW** federation state maps (see §2.3) |
| `:101–109` `activeSessions()` | **MODIFIED** — fold in the global roster (§4) |
| `:130–134` `getPendingFor` | unchanged (relay injects local) |
| `:234` `executeTool` | **MODIFIED** — pass token context not needed; add remote-branch in `ask`/`reply`/`notify` |
| `:302` `ask` | **MODIFIED** — local-vs-remote target resolution + relay round-trip |
| `:340` `reply` | **MODIFIED** — if the message originated remotely, relay the answer back |
| `:359` `notify` | **MODIFIED** — local-vs-remote target resolution + relay |
| `:299` `list_sessions` | **MODIFIED** — return merged roster |
| `:446` `http.createServer` | **MODIFIED** — add `/link/*` routes + token gate on `/health` and `/link/*` |
| `:603` `/health` | **MODIFIED** — token gate when sharing is on |
| `:633` `shutdown` | **MODIFIED** — also close link SSE streams / stop link client |
| `:656` `server.on("error")` | unchanged |
| `claude-bridge` | **NEW** flags `--share`/`--join`/`--unlink`/`--stop-share` |

---

## 2. The federation link, fully specified

### 2.1 Roles

A bridge is in exactly one of three federation states:
- **standalone** (default, today's behaviour) — no token, no link.
- **hub** — `--share` set a token, the federation endpoints are live, a tunnel exposes them, accepts inbound spoke connections.
- **spoke** — `--join` wrote a token + hub URL; the bridge opens an *outbound* SSE to the hub and POSTs to it.

A bridge can be a hub OR a spoke in Phase 1, **not both** (no chaining; hub-and-spoke only, per the locked decision). The hub itself is also a node whose local sessions are part of the roster.

### 2.2 Endpoints (all on the same HTTP server, port 7400; only these are tunneled)

All `/link/*` endpoints require the `X-Bridge-Token` header (§3). All are JSON over HTTP except the SSE stream.

**Spoke → hub (HTTP POST):**

| Path | Body | Response | Purpose |
|---|---|---|---|
| `POST /link/register` | `{node, sessions:[{name,description}]}` | `{ok, node, roster:[…]}` | Spoke advertises its node id + local roster. Hub records the spoke, replies with current merged roster. Idempotent — re-POST to refresh the spoke's advertised sessions. |
| `POST /link/forward` | `{kind:"question"\|"notice"\|"answer", id, from, to, ...}` | `{ok}` or `{error}` | Relay one message toward its destination node. (Payloads §2.4.) |
| `POST /link/heartbeat` | `{node}` | `{ok, roster:[…]}` | Liveness + roster refresh fallback (SSE is primary; heartbeat is the floor). |
| `POST /link/unregister` | `{node}` | `{ok}` | Graceful `--unlink`: hub drops the spoke + its sessions immediately. |

**Hub → spoke (SSE):**

| Path | Purpose |
|---|---|
| `GET /link/stream` (header: token + `X-Bridge-Node: <node>`) | Long-lived SSE. Hub pushes: `roster` events (merged global roster) and `forward` events (messages destined for this spoke's local sessions). 25s keepalive ping, same pattern as `/sse`. |

**SSE event types on `/link/stream`:**
- `event: roster` / `data: {nodes:{<node>:[{name,description}]}}` — full merged roster snapshot (simplest; send on any change). Spoke replaces its cached remote roster.
- `event: forward` / `data: {kind, id, from, to, ...}` — a message to inject into the spoke's local store (§5.2).
- `event: close` — graceful shutdown (reuse the `event: close` convention from `:637`).
- `: ping` keepalive comment.

**Direction asymmetry to internalize:** the spoke's outbound POSTs and the hub's SSE push are *two halves of one logical link*. A spoke's `ask` to a hub-side target rides POST `/link/forward` → hub injects locally → hub's normal delivery wakes the target → target's `reply` is detected by the hub as "answering a remote-origin message" → hub pushes `forward{kind:"answer"}` over the spoke's `/link/stream` → spoke sets `msg.answer` → the spoke's blocking `ask` poll loop returns. (Full trace §5.4.)

### 2.3 New server state

```
// federation config (read once at startup + on SIGHUP-style refresh; see §6)
let FED = {
  role: "standalone",          // "hub" | "spoke" | "standalone"
  token: null,                 // from ~/.claude/.cc-bridge-token
  node: "<this node id>",      // see §4.3 for derivation
  hubUrl: null,                // spoke only: https://host (from ~/.claude/.cc-bridge-hub)
};

// HUB side:
const spokes = new Map();      // node → { res:SSEResponse|null, sessions:[{name,description}], lastSeen:number }
// roster: union of (this hub's activeSessions) + every spoke's advertised sessions.

// SPOKE side:
let hubStream = null;          // the outbound SSE client handle (for teardown)
let remoteRoster = [];         // last roster snapshot pushed by the hub (names + node)
// outbound POST helper that always sets X-Bridge-Token.

// BOTH: a per-message "origin" tag so reply()/the relay knows where to send the answer.
// Store it on the message object as msg.origin = { node } (absent => local).
```

### 2.4 `/link/forward` payloads

```
question: { kind:"question", id, from, to, question, ts, originNode }
notice:   { kind:"notice",   id, from, to, content,  ts, originNode }
answer:   { kind:"answer",   id, answer, ts }   // id is the original question id
```

`originNode` = the node the asker/notifier lives on (so the answer can be routed home). The hub is the router: a spoke always forwards to the hub; the hub forwards to the owning spoke (or injects locally if the target is a hub-local session).

### 2.5 How the hub tracks spokes + advertised sessions

- On `POST /link/register`: `spokes.set(node, {res:<existing or null>, sessions, lastSeen:now})`.
- On `GET /link/stream`: attach `res` to the spoke entry (create if missing), start keepalive, `req.on("close")` → set `res=null`, prune sessions, **rebroadcast roster** to remaining spokes (de-merge, lesson-#9-style ghost avoidance applied to the link).
- On `POST /link/heartbeat`: bump `lastSeen`.
- A liveness sweep (interval ~15s) prunes spokes whose `lastSeen` is older than ~45s OR whose `res` is dead (prune-on-write-error, §11) and rebroadcasts roster.

---

## 3. Token-auth design (foundational piece #1 — land first)

### 3.1 Token file

- Path: `~/.claude/.cc-bridge-token` (hardcoded in the spec). Format: single line, the raw token, no trailing newline dependence (read + `.trim()`).
- Generation (`--share`): `crypto.randomUUID()` doubled or `openssl rand -hex 32` in shell — a high-entropy hex string. Bridge never generates it; `claude-bridge --share` writes it (so the file exists before the server reads it). The server **reads** the file at startup and on a refresh signal.
- The bridge reads the token at startup. If present → "sharing on" mode (gate active). If absent → standalone (no gate). The spoke's `--join` writes the *hub's* token into the same file so the spoke's outbound POSTs can authenticate.

### 3.2 Which endpoints are gated, and the loopback insight

> **SUPERSEDED BY v2.7.0 HARDENING (DEVELOPER.md lesson #29).** The single-port model below — "tunnel port 7400, gate `/health` + `/link/*` with the token" — was found to expose the intentionally token-free local routes (`/sse`, `/message`, `/pending`, `/whoami`) to anyone with the tunnel URL, since `--share` tunneled the *whole* bridge. The fix splits the bridge into **two loopback listeners**: the main server (`127.0.0.1:PORT`, all local routes, never tunneled) and a hub-only fed listener (`127.0.0.1:FED_PORT`, default `PORT+1`) that serves ONLY `/link/*` + the content-free `/health/ping` and is the **only** thing the tunnel exposes. `/link/reload` is now loopback-only AND token-gated. The token-gating rules below still apply to the fed listener; the table's "Tunneled?" column is now "main port = never tunneled; fed port = the only tunneled surface." Read lesson #29 for the authoritative design.

**KEY INSIGHT (spec §3, lesson-grade):** a localhost-forwarding tunnel makes remote requests arrive at the bridge from `127.0.0.1` — indistinguishable from genuine local clients. Therefore **"trust loopback, skip the token" is UNSAFE** for anything reachable through the tunnel. Resolution:

| Endpoint | Tunneled? | Gate when sharing is ON |
|---|---|---|
| `/sse`, `/message` (local MCP) | **No** (never tunneled) | **No token** — local sessions/hooks stay token-free. Safe *only because these paths are not exposed*. |
| `/pending`, `/whoami` (hooks) | No | No token — local hooks stay unchanged. |
| `/health` | **Yes-ish** (could be probed) | **Token required when sharing is on** (don't leak session names/descriptions). When standalone, `/health` stays open (preserves today's `claude-bridge --check`/test behaviour). |
| `/link/*` (incl. `/link/stream`) | **Yes** | **Always token-required.** |

**Concrete rule:** `if (FED.token)` (sharing on) → require `X-Bridge-Token === FED.token` on `/health` and all `/link/*`. `/sse`, `/message`, `/pending`, `/whoami` are never gated (they are not tunneled; gating them would force the hooks to carry the token, which the spec explicitly avoids).

**Problem this creates for local tooling when sharing is on:** `claude-bridge --check` and `tests/lib.mjs health()` hit `/health` without a token. Resolution (decide in §10, but recommended): `--check` reads the token file and sends the header when present; tests run standalone (no token) so `/health` stays open in tests. Document that a token-gated `/health` returns `401` to unauthenticated callers.

### 3.3 No-token guardrail

`claude-bridge --share` refuses to launch the tunnel if no token can be written/read. The server itself refuses to serve `/link/*` (returns 503 "federation disabled: no token") unless `FED.token` is set — i.e. **you cannot become a hub without a token**. This is the spec's hard guardrail.

### 3.4 Auth failure response

Unauthenticated `/link/*` or `/health` (when gated): `res.writeHead(401)`, JSON `{error:"unauthorized"}`. Constant-time compare is overkill for a localhost-trusted-group tool but use `crypto.timingSafeEqual` on equal-length buffers if cheap; otherwise a plain `===` is acceptable and documented.

---

## 4. Roster federation

### 4.1 Merge

`activeSessions()` (`:101`) stays the *local* truth. Add `globalRoster()`:
- **Hub:** local `activeSessions()` (tagged with `FED.node`) ∪ every live spoke's advertised sessions (tagged with the spoke's node).
- **Spoke:** local `activeSessions()` (tagged `FED.node`) ∪ `remoteRoster` (the hub's last pushed snapshot, already node-tagged).
- **Standalone:** just `activeSessions()`.

`list_sessions` (`:299`) returns `globalRoster()`. `/health` `sessions` field → `globalRoster()` when sharing on (still gated).

### 4.2 What an entry looks like

Phase 1: `{name, description, node}` where `node` is `"local"` for own sessions or the remote node id. Phase 1 **assumes unique bare names across the group** (locked decision) — `ask(to="frontend")` resolves by bare name. The `node` field is informational in Phase 1.

Phase 2: qualified key `name@node` for display and addressing; collision UX (auto-suffix or reject).

### 4.3 Node id derivation (decide in §10)

Recommended Phase 1: the node id is set at `--share`/`--join` time and stored in a file (`~/.claude/.cc-bridge-node`), defaulting to the machine hostname (`os.hostname()` lowercased, sanitized like the hook dir-name rule). Must be stable across restarts (so reconnect/roster is consistent) and unique within the group (user's responsibility, trusted-group assumption).

---

## 5. Message routing / relay

### 5.1 The new target resolution (the core branch)

Add a helper used by `ask`, `notify` (and Phase 2 `get_thread`):

```
function resolveTarget(to) {
  const sse = nameToSSE.get(to);
  if (sse && sseClients.has(sse)) return { kind: "local", sse };
  const remote = globalRoster().find(e => e.name === to && e.node !== "local");
  if (remote) return { kind: "remote", node: remote.node };
  return { kind: "none" };
}
```

- **local** → existing code path, byte-for-byte (current `ask`/`notify` logic).
- **remote** → hand to the relay (§5.2).
- **none** → existing "not connected" error, but list the **merged** roster: `globalRoster().map(e=>e.name)`.

### 5.2 "Inject remote message into the destination's LOCAL store" — the centerpiece

When a `forward` arrives at the node that *owns the target session* (the hub for a hub-local target, or a spoke whose local session is the target), the receiving bridge does exactly what the local handler does today — constructs the same message object and puts it in `messages` + `threads`:

```
function injectRemote(fwd) {                 // fwd = {kind,id,from,to,...,originNode}
  if (fwd.kind === "question") {
    const msg = { id: fwd.id, from: fwd.from, to: fwd.to, question: fwd.question,
                  answer: null, ts: fwd.ts ?? Date.now(), answeredAt: null,
                  origin: { node: fwd.originNode } };
    messages.set(msg.id, msg);
    pushThread(fwd.from, fwd.to, msg.id);
  } else if (fwd.kind === "notice") {
    const msg = { id: fwd.id, from: fwd.from, to: fwd.to, kind: "notice",
                  content: fwd.content, delivered: false, ts: fwd.ts ?? Date.now(),
                  origin: { node: fwd.originNode } };
    messages.set(msg.id, msg);              // NO answer field — lesson #19
    pushThread(fwd.from, fwd.to, msg.id);
  } else if (fwd.kind === "answer") {
    const msg = messages.get(fwd.id);        // the original question, queued here on this node
    if (msg && msg.answer === null) { msg.answer = fwd.answer; msg.answeredAt = Date.now(); }
  }
}
```

**Because the injected object is shape-identical to a locally-created one, every existing delivery path works with zero change:** `/pending` renders it (question banner or NOTICE banner), the Stop hook blocks on it, the idle-listener peeks it, `check_inbox` reads it, `get_thread` shows it, GC/TTL ages it out, migration reassigns it on rename. **This is the whole reason the design is small.**

### 5.3 `reply` over the link (answer routes home)

`reply` (`:340`) currently just sets `msg.answer`. Add at the end of `reply`, after setting the answer:

```
if (msg.origin && msg.origin.node && msg.origin.node !== FED.node) {
  relayAnswer(msg.origin.node, { kind:"answer", id: msg.id, answer: msg.answer, ts: msg.answeredAt });
}
```

`relayAnswer`:
- **Spoke side:** POST `/link/forward` to the hub (hub routes it home — to itself if the asker is hub-local, or to the owning spoke's stream).
- **Hub side:** if the origin node is a spoke, push `event: forward` over that spoke's `/link/stream`; if origin is the hub itself, it's already local (no relay).

### 5.4 Blocking `ask` round-trip — full trace

Asker is on node A (spoke), target `bob` is on node B (hub or another spoke).

1. A's `ask`: `resolveTarget("bob")` → `remote`. A **still queues the message locally** with `answer:null` and `origin:{node:A}` (so A's poll loop has an object to watch — reuse the existing 5-min poll at `:329`). Then A relays: spoke POSTs `/link/forward {kind:"question", id, from, to:"bob", question, originNode:A}` to the hub.
2. Hub receives `/link/forward`. If `bob` is hub-local → `injectRemote` into the hub store. If `bob` is on spoke B → hub pushes `event: forward` over B's `/link/stream`; B's stream handler calls `injectRemote`.
3. The node owning `bob` now has a local question with `answer:null` → its normal machinery wakes `bob` (PostToolUse `/pending`, Stop hook, idle-listener). `bob` calls `reply`.
4. `bob`'s `reply` sets `msg.answer` locally AND (because `msg.origin.node === A ≠ self`) relays `kind:"answer"` home: B→hub→A (or hub→A directly).
5. A receives the answer (via its `/link/stream` if A is a spoke; the hub injects via `injectRemote(answer)`), which sets A's local `msg.answer`.
6. A's still-running `ask` poll loop (`while Date.now()<deadline`) sees `msg.answer !== null` and returns it to the asker. **The blocking semantics work unchanged because the answer lands on the same in-memory `msg` object A is polling.**

**Timeout:** A's existing 5-min deadline still applies. If the link is down or the answer never comes home, A times out exactly as today. Lossless on reconnect only matters for *non-blocking* delivery (notices, and questions whose asker is still polling within 5 min); a blocking `ask` that out-waits 5 min returns a timeout (current behaviour, acceptable).

### 5.5 `notify` over the link

Same as `ask` minus the poll loop. `resolveTarget` → remote → relay `kind:"notice"` to the hub → injected at the owner → delivered once via the owner's normal notice path. **Preserve the no-`answer` invariant** (lesson #19) and **peek-doesn't-consume** (lesson #21) — both hold automatically because the injected notice is a normal local notice.

### 5.6 Lossless reconnect (queued flush)

- **Notices and unanswered questions live in each bridge's `messages` Map (30d TTL).** They are NOT lost on a link drop; they're just un-relayed.
- On link (re)establishment, each side re-runs `/link/register` (spoke→hub) and the hub re-pushes the roster. **Re-forward un-relayed messages:** track a per-message `relayedAt` (or a `pendingRelay` set of message ids) so that on reconnect the spoke re-POSTs any forward that was never acked, and the hub re-pushes any forward whose target-spoke stream had dropped. De-dupe on the receiving side by `messages.has(id)` (idempotent inject). **This reuses the existing store as the durable queue — no new persistence.** (Spec §2 "flush on resume.")
- **Idempotency rule:** `injectRemote` for a question/notice is a no-op if `messages.has(id)`; for an answer it's a no-op if `msg.answer !== null`. Safe to replay.

---

## 6. claude-bridge helpers

### 6.1 `--share` (become a hub)

1. Detect `cloudflared` (`command -v cloudflared`); if missing, print `brew install cloudflared` instructions and exit (don't auto-install). (Spec §6.)
2. Ensure a token exists: if `~/.claude/.cc-bridge-token` absent, generate (`openssl rand -hex 32` or node `crypto.randomUUID`), write it. `chmod 600`.
3. Ensure/derive node id → `~/.claude/.cc-bridge-node` (default hostname).
4. Start the bridge if not running (`start_bridge`) — but the server must read the token + node + role=hub. **Mechanism (decide in §10):** simplest is env vars at spawn (`CC_BRIDGE_TOKEN_FILE`, `CC_BRIDGE_ROLE=hub`, `CC_BRIDGE_NODE`) OR the server always reads the token file on boot and infers hub-mode from "token file present." Recommended: server reads `~/.claude/.cc-bridge-token` on boot; presence ⇒ gate on. A `~/.claude/.cc-bridge-role` file (or env) flips hub vs standalone-with-token. If the bridge is already running (common — sessions are attached), it must learn the new token **without a restart** (restart kills attached sessions, lesson #23a) — so add a `POST /link/reload` localhost-only endpoint (no token needed; localhost, not tunneled) that re-reads the config files. `--share` calls it after writing the files.
5. Launch `cloudflared tunnel --url http://localhost:7400` in the background; capture its stdout to parse the `https://<sub>.trycloudflare.com` URL. Store the tunnel PID (`/tmp/claude-bridge-tunnel.pid`) and URL (`/tmp/claude-bridge-tunnel.url`).
6. Print the join command: `./claude-bridge --join 'https://<sub>.trycloudflare.com#<token>'`.
7. **URL rotation (spec §11):** if `cloudflared` restarts, the URL changes. `--share` writes the URL to a file; a `--share --status` (or re-running `--share`) detects a running tunnel and reprints the current join link. Document that quick-tunnel URLs are ephemeral; the always-on path is a named tunnel.

**Self-restart hazard (lesson #23a):** `--share` must NOT stop/restart a running bridge that has attached sessions. The `/link/reload` endpoint exists precisely so `--share` can enable hub mode on a live bridge without dropping SSE clients. If the bridge is NOT running, a plain `start_bridge` is safe.

### 6.2 `--join '<link>'` (become a spoke)

1. Parse the link: `https://<host>` + `#<token>` fragment. The fragment is parsed locally (never sent to a server — spec §6). Write token → `~/.claude/.cc-bridge-token`, hub URL → `~/.claude/.cc-bridge-hub`, role → spoke.
2. Start the bridge if not running; if running, hit `/link/reload` so it opens the outbound link **without a restart** (lesson #23a).
3. The server, in spoke mode, opens `GET <hubUrl>/link/stream` with the token header + node header, and POSTs `/link/register` advertising its local sessions. Print "Linked to hub <host> as node <node>."

### 6.3 `--unlink` (spoke leaves)

POST `/link/unregister {node}` to the hub (graceful), close the outbound SSE, clear `~/.claude/.cc-bridge-hub`, set role standalone via `/link/reload`. **Local sessions are unaffected** (they were always local). Remove the token file only if it was a spoke-only token (decide; safest to leave it and just clear the hub URL + role).

### 6.4 `--stop-share` (hub stops sharing)

Kill the `cloudflared` tunnel (PID file), set role standalone via `/link/reload` (stop accepting `/link/*`), optionally keep the token (so re-`--share` is fast). Do NOT stop the bridge (attached sessions). Push `event: close` to spoke streams so they de-merge cleanly. **Ctrl-C on the `--share` terminal** also tears down the tunnel; the bridge stays up.

### 6.5 Manifest / uninstall implications

New artifacts to register (`manifest_add FILE …`) and remove on uninstall:
- `~/.claude/.cc-bridge-token`
- `~/.claude/.cc-bridge-hub`
- `~/.claude/.cc-bridge-node`
- `~/.claude/.cc-bridge-role` (if used)
- `/tmp/claude-bridge-tunnel.pid`, `/tmp/claude-bridge-tunnel.url` — `/tmp` runtime files, NOT manifest artifacts (like `.monitor`), but the uninstall `rm -f /tmp/claude-bridge-*` glob already covers them. **Verify the glob covers them** (it does: `/tmp/claude-bridge-*`).
- Uninstall must also kill the tunnel process if running (it's a child, not the bridge) and tell the user to `--stop` the bridge separately (lesson #15: uninstall doesn't stop the server).
- **Round-trip test** (lesson #6 of the owner's vision): `--uninstall` removes every federation file. Add to `tests/test-process-mgmt.sh` or a new test.

---

## 7. File-by-file change list

| File | NEW/MOD | Change |
|---|---|---|
| `bridge-server.mjs` | MOD | Federation state (§2.3); `globalRoster()`; `resolveTarget()`; `injectRemote()`; `relayAnswer()`; spoke outbound link client (SSE + POST helpers); hub `/link/*` routes + `/link/stream` SSE; token gate on `/health` + `/link/*`; `POST /link/reload` (localhost) to hot-load config; modify `ask`/`reply`/`notify`/`list_sessions`; extend `shutdown()` to tear down link; liveness sweep interval. **Keep zero deps — `http`, `crypto`, `fs`, `os` only.** Outbound HTTPS to the tunnel uses `node:https` (stdlib). |
| `claude-bridge` | MOD | `--share`/`--join`/`--unlink`/`--stop-share`/`--share --status`; `cloudflared` detect/launch; token+node+hub+role file management; join-link print/parse; tunnel PID tracking; `manifest_add` for new files; uninstall removes them + kills tunnel; extend `--check` (Phase 2) to show spokes/hub status. |
| `bridge-server.mjs` banner | MOD | version bump string. |
| `package.json` | MOD | version bump (minor — new feature). |
| `hooks/*.sh` | **UNCHANGED** | Sessions stay on localhost. (Spec §7, big simplification.) |
| `bridge-stdio.mjs` | **UNCHANGED** | Desktop connects to its own local bridge; federation is transparent to it (it's just another local session whose messages may be remote-origin). See §10 Desktop question. |
| `USAGE.md` | MOD | New "Cross-network" section: `--share`/`--join`/`--unlink`/`--stop-share`, `cloudflared` prereq, honesty/security note (TLS-in-transit, trusted group), token file, install-modifies table additions. |
| `README.md` | MOD (small) | "What this is" — add cross-network bullet; "What this isn't" — note "not a VPN / not E2E-encrypted." |
| `skill/SKILL.md` + `BRIDGE.md` | MOD | Note remote talk is transparent (you ask by name; it may be on another machine); Phase 2 `name@node`. Keep in sync. |
| `DEVELOPER.md` | MOD | New lessons (§11 list); "Planned features" → "Implemented (Phase 1)"; per-task notes for federation; update the architecture diagram + hook/tool counts if any. |
| `CHANGELOG.md` | MOD | Entries under `[Unreleased] → Added` per build step. |
| `tests/test-federation.mjs` | **NEW** | Two-bridge link harness (§8). |
| `tests/lib.mjs` | MOD | Add a second-port `TestBridge` already supported (port arg); add link helpers (`linkRegister`, `forward`, an SSE-consumer for `/link/stream`, token header support on `health()`). |
| `tests/test-token-auth.mjs` | **NEW** | Token gate accept/reject on `/health` + `/link/*` (foundational piece #1, lands first). |

**Critical "don't break local-only":** every change is behind `if (FED.role !== "standalone")` or `if (FED.token)`. With no token file and no hub URL, the server behaves byte-for-byte as v2.6.2. The test suite runs standalone, so existing tests stay green untouched.

---

## 8. Test plan

`tests/lib.mjs` spins one `TestBridge` per port; it keeps a **single** SSE connection (lesson #2) and reads JSON-RPC responses off it. The federation harness runs **two** `TestBridge` instances on two ports (e.g. 7403 hub, 7404 spoke) and links them.

### 8.1 `tests/test-token-auth.mjs` (foundational — land first)
- Start a bridge with a token configured (via `/link/reload` after writing a temp token file, or an env that points at a temp token file).
- `GET /health` with no header → 401; with correct header → 200.
- `POST /link/register` with no/wrong token → 401; correct → 200.
- Standalone (no token) → `/health` still 200 with no header (regression guard for `--check`/existing tests).
- No-token guardrail: `/link/register` when no token set → 503 "federation disabled."

### 8.2 `tests/test-federation.mjs` (Phase 1 core)
Harness: hub on 7403 (token T, node "hub"), spoke on 7404 (token T, hubUrl=hub, node "spoke"). Drive each via its own `/sse` MCP client (the `TestBridge.call` path) for tool calls, plus raw `/link/*` for link assertions.

Assertions:
1. **Link auth accept/reject** — spoke `/link/register` with T accepts; with wrong token rejects (covered partly in 8.1, repeat in two-bridge context).
2. **Roster merge** — register `alice` on hub, `bob` on spoke; `list_sessions` on hub includes `bob` (node=spoke); on spoke includes `alice` (node=hub).
3. **Cross-link `ask`/`reply` round-trip** — `alice@hub` asks `bob@spoke`; spoke's `/pending?session=bob` shows the question banner with an `id:` line (injected as a normal local question); `bob` calls `reply`; `alice`'s `ask` returns the answer. Assert the answer text round-tripped.
4. **`notify` relay** — `alice` notifies `bob`; spoke `/pending?session=bob` shows the NOTICE banner once; second `/pending` does not re-deliver (consume-once preserved across the link); `check_inbox` on bob lists it.
5. **`answer===null`/notice invariants across the link** — the injected notice never appears as a pending *question* (`getPendingFor`/`check_inbox.pending_count===0`); peek does not consume it (lesson #21).
6. **Link drop → local still works** — kill the spoke's link to the hub (stop pushing/POSTing); a spoke-local `ask` (bob→bob or bob→another local) still works; hub's global roster prunes `bob` within the liveness window.
7. **Reconnect flushes queued messages** — while the link is down, `alice` notifies `bob` (queued on hub as un-relayed); re-establish the link; assert `bob` receives the queued notice after reconnect (idempotent re-forward).
8. **Token-gated `/health`** — when sharing on, `/health` requires the token (assert 401 without).
9. **Idempotent inject** — replaying the same `forward` id does not duplicate (assert `messages` count / no double-delivery).

### 8.3 Harness notes
- Use `node:https`? No — tests run over `http` on localhost; the tunnel/TLS is out of scope for the unit harness (cloudflared is not invoked in tests). The link in tests is plain HTTP between two local ports. **This means the link transport must work over plain HTTP too** (it does — the tunnel just wraps it). The `--share`/cloudflared path is smoke-tested manually, not in CI (spec/DEVELOPER pattern: shell `claude-bridge` flags get a `test-*.sh`, but external tools like cloudflared are detect-and-instruct, so the test asserts detection/branching, not a real tunnel).
- `tests/test-share-flags.sh` (optional, NEW): assert `--share` without `cloudflared` prints install instructions and exits non-zero; `--share` without writable token dir fails the guardrail; `--join` parses a link into the right files. Use a fake `cloudflared` on PATH that prints a canned URL to test parsing. Port 7404-family.

---

## 9. Build sequence (each step independently testable; local-only never regresses)

1. **Token-auth layer (foundational #1).** Token file read at boot + `/link/reload`; gate `/health` + (stub) `/link/*` behind `if (FED.token)`; no-token guardrail. Ship `tests/test-token-auth.mjs`. **Local-only unchanged (no token = no gate).** Independently useful (locks down a LAN-exposed bridge).
2. **Link liveness tweak (foundational #2).** TCP keepalive (`socket.setKeepAlive`) + prune-on-write-error on SSE writes (apply to local `/sse` too — tightens local ghost de-merge to ~30–60s, lesson #9). Extend `test-graceful-shutdown.mjs` or add a liveness test.
3. **Link establishment + roster sync.** `/link/register`, `/link/stream` (hub→spoke SSE), `/link/heartbeat`, `/link/unregister`; spoke outbound client; `globalRoster()`; `list_sessions` merge. Assertions 1–2, 6, 8.
4. **Message relay.** `resolveTarget`, `injectRemote`, `relayAnswer`; branch `ask`/`reply`/`notify`. Assertions 3, 4, 5, 9.
5. **Lossless reconnect.** `pendingRelay`/`relayedAt` re-forward on reconnect; idempotent inject. Assertion 7.
6. **claude-bridge helpers.** `--share`/`--join`/`--unlink`/`--stop-share`; cloudflared detect/launch; join-link; manifest+uninstall. `tests/test-share-flags.sh`.
7. **Docs + release.** §12.

Phase 2 (separate effort): `name@node` qualification + collision UX; `get_thread` across the link; named-tunnel/self-host recipes; `--check` shows spokes/hub; decide scratchpad federation.

---

## 10. Open questions / decisions for the human

(Starts from spec §11, expanded with what the code surfaced.)

1. **Node id source & uniqueness.** Default to `os.hostname()`? Allow override via `--share --node <name>` / `--join … --node <name>`? Phase 1 trusts uniqueness; what if two spokes share a hostname?
2. **Name-collision policy for Phase 1.** Spec assumes unique bare names. If `frontend` exists on two nodes, does `ask(to="frontend")` pick the local one, the first in roster, or error? Recommended: **local wins**, remote ambiguity errors and tells the user to use `name@node` (forces Phase 2 early only if it bites).
3. **How the running bridge learns hub/spoke config without a restart.** Recommended: a localhost-only `POST /link/reload` that re-reads the config files (avoids lesson #23a self-restart kill). Confirm this approach vs. env-at-spawn (which would force a restart and drop attached sessions).
4. **Do `broadcast`/`read_scratchpad` (scratchpads) federate in Phase 1?** Spec §11 leaves it open. Recommended: **local-only in Phase 1** (scratchpads are pull-based, no delivery machinery to reuse; federating them means roster-wide replication — Phase 2 or never). Document the non-goal.
5. **`/health` gating vs. existing tooling when sharing is on.** Gating `/health` breaks `claude-bridge --check` and any unauthenticated probe. Confirm: `--check` reads the token file and sends the header; tests run standalone. Is a separate unauthenticated `/health/ping` (status only, no session names) wanted so liveness checks survive without the token? (Recommended: yes — a minimal `{status:"ok"}` with no roster, ungated; full `/health` gated.)
6. **Token rotation / multiple hubs.** One token file path means a machine can be a spoke of exactly one hub at a time. Confirm that's acceptable for Phase 1 (it matches hub-and-spoke).
7. **Desktop's role.** A Desktop session is just another local session on its machine's bridge; federation is transparent (its remote-origin messages arrive via the same local store; `check_inbox` reads them). **But Desktop has no hooks and no Monitor (lesson #16)** — so a Desktop user must manually `check_inbox` to see remote messages, same as today for local ones. Confirm: no Desktop-specific work in Phase 1; document the manual-poll limitation extends to remote messages.
8. **Quick-tunnel URL rotation.** Confirm `--share` re-print behaviour on tunnel restart, and that spokes must be re-`--join`'d with the new URL (a quick tunnel can't keep a stable URL). Named-tunnel is the documented always-on fix (Phase 2).
9. **Graceful `--unlink` vs. silent spoke death.** Both must converge the hub's roster (spec §11). `--unlink` POSTs `/link/unregister`; silent death is caught by the liveness sweep (~45s). Confirm the sweep window.
10. **`notify` to an offline remote name** (lesson #22 extended). A notice to `bob@spokeB` when spokeB is offline: queue on the hub and forward when spokeB reconnects? Or fail fast? Recommended: queue on the hub (reuses the store + reconnect flush), bounded by 30d TTL — but document that a stale/rotated remote name dead-letters (lesson #22).

---

## 11. Risks & lessons (cited)

- **Lesson #2 (one SSE gets responses).** The link adds a *second* SSE per spoke (`/link/stream`), but it's a different logical client (bridge-to-bridge), not a second connection for the same MCP session — no conflict. The test harness must keep the link SSE separate from the MCP `/sse`. ✔ designed.
- **Lesson #7 (wrap tool calls; uncaughtException net).** All `/link/*` handlers and `injectRemote`/`relayAnswer` must be wrapped in try/catch so a malformed forward can't crash the server. The outbound spoke client's POST/SSE callbacks must catch (a hub going away mid-write must not throw to the top). ✔ add explicit try/catch + rely on the existing `uncaughtException` net as backstop.
- **Lesson #8 & #23a (SSE drops kill sessions; never self-restart).** This is the biggest risk. (a) The link SSE dropping must NOT affect local MCP `/sse` clients — they're independent connections; a hub restart only drops `/link/stream`, local sessions keep their `/sse`. ✔ by design ("sessions always local"). (b) `--share`/`--join` must enable federation on a **running** bridge via `/link/reload`, NOT a restart — restarting drops local sessions and may kill the calling session (lesson #23a). ✔ designed. (c) A hub restart cascading: spokes' `/link/stream` drop → spokes reconnect with backoff (don't hot-loop). **Add reconnect backoff** (e.g. 1s→2s→5s→max 30s) on the spoke's outbound client.
- **Lesson #9 (ghost SSE / de-merge).** The hub must prune a spoke's roster entry on `/link/stream` close + on write-error + on heartbeat timeout, then rebroadcast roster — same discipline as local. ✔ §2.5, §11 step-2 liveness.
- **Lesson #19 (`answer===null` IS pending; notice has no `answer`).** `injectRemote` constructs notices with NO `answer` field and questions with `answer:null`. The `kind:"notice"` guard in `getPendingFor`/`/pending`/`check_inbox` stays. ✔ §5.2.
- **Lesson #20 (idle-listener grep ↔ `/pending` coupling).** Phase 1 adds **no new banner type** — remote messages render through the existing question/NOTICE formatters. So the grep is untouched. ✔ (If Phase 2 ever adds a "remote" banner variant, update the grep + add an `id:` line.)
- **Lesson #21 (idle-listener must peek).** Injected notices are normal notices; `?peek=1` still doesn't consume them. ✔ no change needed.
- **Lesson #22 (notify to offline auto-name dead-letters).** Extends across the link (open question #10). Document, don't over-engineer.
- **Lesson #6/#15 (uninstall round-trip; uninstall doesn't stop server).** New token/hub/node files go in the manifest + hardcoded cleanup; uninstall kills the tunnel child but not the bridge. ✔ §6.5.
- **GC/TTL interaction.** GC (`:50`) prunes messages older than 30d and scratchpads/sessions with no active session + no messages. A remote-origin message has `from`/`to` names that may not be local sessions — GC keys on `ts` for messages (fine) and on name presence for scratchpads/claudeIds (a remote name won't have a local session, so its scratchpad — if federated — could be GC'd early; another reason to keep scratchpads local-only in Phase 1, open question #4). ✔ flag.

---

## 12. Doc + release checklist

Per the repo rule "every code change touches ≥1 MD file + ships a test":

- [ ] `CHANGELOG.md` — `[Unreleased] → Added` entry per build step (token-auth, liveness, link, relay, reconnect, install flags).
- [ ] `USAGE.md` — cross-network section (`--share`/`--join`/`--unlink`/`--stop-share`), `cloudflared` prereq, security honesty note, token file, "What claude-bridge modifies" additions, troubleshooting (link won't connect, URL rotated, 401).
- [ ] `README.md` — one "what this is" bullet (cross-network), one "what this isn't" (not a VPN, not E2E).
- [ ] `skill/SKILL.md` + `BRIDGE.md` — kept in sync; note remote talk is transparent, Phase 2 `name@node`.
- [ ] `DEVELOPER.md` — new lessons (link reconnect backoff; `/link/reload` to avoid self-restart; loopback-looks-local token insight; idempotent inject; scratchpads local-only); update architecture diagram, tool/endpoint inventory; move federation from "Planned" to "Implemented (Phase 1)."
- [ ] `bridge-server.mjs` startup banner version string.
- [ ] `package.json` version (minor bump, e.g. 2.7.0).
- [ ] `tests/` — `test-token-auth.mjs`, `test-federation.mjs`, optional `test-share-flags.sh`; extend `lib.mjs` (link helpers, token header on `health()`).
- [ ] Manifest — `manifest_add FILE` for `.cc-bridge-token`/`.cc-bridge-hub`/`.cc-bridge-node`/`.cc-bridge-role`; matching `remove_*` in uninstall.
- [ ] Release checklist (DEVELOPER.md): `npm test` green; `--uninstall`→install→`--check` clean round-trip (now including federation files); manual smoke of `--share`/`--join` between two machines (or two ports locally with a fake/real cloudflared).

---

## 13. Issues with the spec (flagged, not silently deviated)

1. **Hub as a single point of failure / single hub per spoke.** The token file is one path → a spoke joins exactly one hub. The spec's hub-and-spoke accepts this; just confirm (open question #6). No deviation.
2. **`/link/reload` is not in the spec but is required by lesson #23a.** The spec says `--share`/`--join` "links the local bridge" but doesn't say *how* a running bridge picks up the new role without a restart. A naive implementation would restart the bridge and kill attached sessions (lesson #23a). **I am introducing `POST /link/reload` (localhost-only)** as the mechanism. This is an addition the spec implies but doesn't spell out — flag for human sign-off (open question #3).
3. **Gating `/health` fully breaks `claude-bridge --check` and the test `health()` helper when sharing is on.** The spec says "gate `/health`" but the existing tooling reads it unauthenticated. I recommend a split: ungated `/health/ping` (status only, no names) + gated full `/health` (open question #5). Minor deviation in service of the spec's intent (don't leak names) without breaking local tooling.
4. **Blocking `ask` over the link inherits the 5-min timeout.** The spec's "lossless on reconnect" applies to the durable store (notices, queued questions), but a *blocking* `ask` whose link is down longer than 5 min returns a timeout (today's behaviour). This is correct and acceptable, but should be documented so users don't expect a blocking ask to survive an arbitrarily long partition.
5. **The link transport must work over plain HTTP (tests) and HTTPS (tunnel).** The bridge speaks HTTP on localhost; cloudflared provides the HTTPS edge. The spoke's outbound client must therefore use `http` or `https` depending on the hub URL scheme. Use `node:https` for `https://` hub URLs (stdlib, still zero-dep). No deviation, just an implementation note.
