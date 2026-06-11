# DEVELOPER.md

Working notes for whoever maintains claude-bridge next — including future-me. This is the file you read **before** changing anything non-trivial.

---

## First-time setup if you're a developer of this repo

If you are **developing/modifying** claude-bridge, **read this whole file before touching anything** so all the rules below are enforced.

> ⚠️ The root `CLAUDE.md` **deliberately does NOT `@`-auto-load this file.** It used to (`@DEVELOPER.md`), but that injected the maintainer guide — including "run the test suite" / release methodology — into *every* session, so an AI handed the repo just to **install** it would start running tests instead of installing. `CLAUDE.md` now splits by intent: install sessions get `./claude-bridge install` (and an explicit "do NOT run tests"), and only **development** sessions are told to open this file. So: when you sit down to change code, open `DEVELOPER.md` yourself (the brainstorming/skill flow and the `CLAUDE.md` pointer will remind you). Do NOT re-add `@DEVELOPER.md` to `CLAUDE.md`, and never inject any of this into the global `~/.claude/CLAUDE.md` (see "Skills over CLAUDE.md injection" in the owner's vision below).

Why this matters: half of this document is "do not redo these mistakes." If you're changing code and can't see it, you'll redo them — so read it before dev work.

---

## Documentation update checklist (every feature, every fix)

**Hard rule: every code change updates at least one MD file.** If you can't think of which one, the change is either undocumented user-facing behaviour (update USAGE.md), an unrecorded release entry (update CHANGELOG.md), or a learning the next developer will need (update DEVELOPER.md).

For each feature/fix, run through this list before committing:

| File | When to update it |
|---|---|
| `CHANGELOG.md` | **Always.** One line under `[Unreleased]` describing what changed, in `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated`. |
| `USAGE.md` | If user-facing behaviour changed: a new flag, a new tool, a new troubleshooting case, a new install step. |
| `README.md` | Rarely. Only if the elevator pitch or "What this is/isn't" changes. Don't bloat it. |
| `BRIDGE.md` + `skill/SKILL.md` | If the agent-facing protocol changed (new tool name, new required arg, changed reply semantics). Keep them in sync. |
| `DEVELOPER.md` | If you learned something the next maintainer needs to know — a new gotcha, a deprecated pattern, an updated architectural decision. Update the "Hard-learned lessons" list. |
| `tests/test-*.{mjs,sh}` | **Always** for new features. Treat tests as documentation that doesn't lie. |

Tactical reminders are already embedded in the "When you add a new tool / hook / install flag" sections below — those are the per-task checklists. This table is the master rule.

---

## What this project is, in one paragraph

claude-bridge (internally still aliased as `cc-bridge` in some runtime paths) is a localhost-only message broker that lets multiple Claude sessions (Claude Code CLI + Claude Desktop app) talk to each other in real time. It runs one Node.js server (`bridge-server.mjs`) on port 7400 with two transports: MCP-over-SSE for CLI sessions, and MCP-over-stdio (via `bridge-stdio.mjs` adapter) for the Desktop app. Five shell hooks plug into Claude Code's lifecycle to auto-register sessions, inject pending questions, and clean up on exit. State is in-memory with a 30-day TTL.

---

## The owner's vision (do not violate)

These are absolute principles the user has stated explicitly. Don't second-guess them:

1. **AI-to-AI protocol** — when an agent receives a bridge question, IT answers from its own context. It does NOT ask the human. This is bolded in BRIDGE.md and SKILL.md for a reason.
2. **Agents announce their registered name to the user** after registering. The user needs the name to route other sessions.
3. **Agent-first documentation style** — USAGE.md is structured as "what you do" vs "what to tell your agent." We document plain-language instructions, not raw tool calls.
4. **Honest claims** — no "battle-tested" if it's been used by 5 sessions. Soft language. The README sells the project; don't oversell.
5. **Skills over CLAUDE.md injection** — never append protocol docs to `~/.claude/CLAUDE.md`. That bloats every session's context permanently. Use Claude Code's skill infrastructure (`~/.claude/skills/<name>/SKILL.md`).
6. **Robust uninstall** — every file the install script creates must be removed by uninstall. Test this round-trip every release.
7. **Don't break running sessions** — the bridge server is a shared dependency. Graceful shutdown matters. Killing it abruptly can crash connected Claude sessions.
8. **No half-finished implementations** — don't ship features behind feature flags or with TODOs. Either it works or it isn't in main.

---

## Architecture quick reference

```
Claude Code CLI ──SSE──┐
                       ├── bridge-server.mjs ──┐
Claude Desktop ──stdio──┘  MAIN listener        │
                           127.0.0.1:7400        │   ← loopback ONLY; serves /sse,/message,/pending,
                           (all local routes)    │     /whoami,/health,/health/ping,/link/reload.
                                                 │     NEVER tunneled, unreachable from the LAN.
                                                 │
                           FED listener          ├── /tmp/claude-bridge-*  (session name files, MCP cache, stamps, PID)
                           127.0.0.1:7401        ├── /tmp/claude-bridge-server.log
                           (hub mode ONLY)       └── In-memory state (messages, threads, scratchpads — 30d TTL)
                           serves ONLY /link/* (token-gated) + /health/ping; every other path 404.
                           ← this is the ONLY thing the cloudflared tunnel exposes.

~/.claude/settings.json                       — 5 hooks point to hooks/*.sh
~/.claude/skills/claude-bridge/SKILL.md        — protocol docs (loaded on-demand by Claude)
~/.claude/skills/claude-bridge-debug/SKILL.md  — read-only expert-debugger skill (repo: skill-debug/SKILL.md; triggered by "debug bridge", surfaced by `claude-bridge debug`)
~/.claude/.cc-bridge-version                   — installed version marker
~/.claude/.cc-bridge-manifest                  — list of files/dirs install touched (for uninstall)
~/.claude/.cc-bridge-token                     — federation shared secret (only if --share/--join; chmod 600)
~/.claude/.cc-bridge-role                      — federation role: hub | spoke | standalone
~/.claude/.cc-bridge-hub                       — spoke only: the hub's https://host URL
~/.claude/.cc-bridge-node                      — this node's stable id (defaults to hostname)
/tmp/claude-bridge-tunnel.{pid,url,provider}   — share process PID + URL/ticket + provider name (runtime)
/tmp/claude-bridge-spoke-pipe.{pid,port,ticket} — p2p spoke forwarder state (runtime; dumbpipe connect-tcp)
~/Library/Application Support/Claude/claude_desktop_config.json  — Desktop MCP entry (macOS)
```

### Federation (cross-network, v2.7.0+)

Hub-and-spoke. A bridge is `standalone` (default, no token), a `hub` (token + tunnel, accepts spokes), or a `spoke` (token + hub URL, opens an outbound link). **All federation logic lives in `bridge-server.mjs`, gated behind `FED.token` / `FED.role !== "standalone"`** — with no token file the server is byte-for-byte v2.6.2. **Sessions stay local; hooks are unchanged.** A remote message is *injected into the destination bridge's local `messages` Map* as a shape-identical object (`injectRemote`), so every existing delivery path is reused untouched. Helpers: `loadFedConfig`/`applyFedConfig`, `globalRoster`, `resolveTarget` (local-first; `name@node`), `injectRemote`, `routeForward` (hub router), `relayForward`/`relayAnswer`, `connectToHub` (spoke outbound SSE with backoff), `flushPendingForwards`/`flushSpokeOutbound` (lossless reconnect), `startFedListener`/`stopFedListener` (the hub-only loopback link listener), `handleLinkRequest` (the link surface served on the fed port).

**Two listeners (v2.7.0 hardening — lesson #29).** The MAIN server binds `127.0.0.1:PORT` and is never tunneled. In hub mode a SECOND server binds `127.0.0.1:FED_PORT` (`CC_BRIDGE_FED_PORT`, default `PORT+1`) and serves ONLY `/link/*` + `/health/ping`. The cloudflared tunnel points at `FED_PORT`. A spoke makes only outbound connections and never binds the fed port.

```
Spoke bridge ──POST /link/{register,forward,heartbeat,unregister}──▶ Hub FED listener (127.0.0.1:FED_PORT)
Spoke bridge ◀──SSE /link/stream (roster + forward events)──────────  Hub FED listener
   (token in X-Bridge-Token header; cloudflared tunnel → Hub FED_PORT ONLY; /link/* token-gated, /health/ping ungated/content-free)
```

claude-bridge: `share [--stable <h> | --tailscale | --p2p | --provider <p>] [--node <id>]` (default provider: **p2p/dumbpipe**; `--named-tunnel <h>` = back-compat alias for `--stable`), `join '<link>'` (https OR `p2p:<ticket>` links), `unlink`, `stop-share` — all flip a *running* bridge via `POST /link/reload` (no restart). Provider binaries are **auto-installed by `share`** (cloudflared via brew/static download; dumbpipe/bore/zrok from GitHub releases via `install_release_binary`) — opt out with `CC_BRIDGE_NO_AUTOINSTALL=1`. The bridge *server* is still zero-dependency: providers only touch the hub/spoke CLI paths. (CI never installs them — `test-share-flags.sh`/`test-providers.sh` use fake binaries on PATH + `CC_BRIDGE_NO_AUTOINSTALL=1`.) Provider contract + SSE-safety table: lessons #32/#33.

### The 5 hooks (CLI only)

| Hook | When it fires | What it does |
|---|---|---|
| SessionStart | New session | Generate name, check MCP is registered, prompt agent to call register() |
| UserPromptSubmit | User sends a message | If not registered, force registration before the agent responds |
| PostToolUse | After every tool call | Poll /pending, inject any bridge questions as additionalContext |
| Stop | Agent finishes a turn | If questions pending, return `{decision:"block", reason:...}` to keep agent running |
| SessionEnd | Session ends | Clean up `/tmp/claude-bridge-${SESSION_ID}.*` files |

### MCP tool list

`register`, `list_sessions`, `ask`, `reply`, `notify`, `check_inbox`, `get_thread`, `broadcast`, `read_scratchpad` — 9 tools, defined in `bridge-server.mjs` TOOLS array.

---

## Hard-learned lessons (DO NOT redo these)

### 1. `os.tmpdir()` on macOS returns a per-user directory, NOT `/tmp`
`/var/folders/.../T/` — so if the bridge writes its PID there but claude-bridge reads `/tmp/claude-bridge.pid`, the file is invisible to the script. **Always hardcode `/tmp/claude-bridge.pid`** (and other shared files) so the server, hooks, and claude-bridge agree.

### 2. SSE has only one connection that receives JSON-RPC responses
If you connect to `/sse` twice, only one connection gets the responses. Tests that open multiple SSE connections will hang on tool calls. Keep one persistent SSE connection per logical client.

### 3. The MCP endpoint URL is `?session=` not `?sessionId=`
This bit me when writing the end-to-end test. Check `bridge-server.mjs` SSE handler for the exact format. Don't trust general MCP knowledge — this implementation uses `session`.

### 4. Hooks must use `additionalContext` to reach the model
Plain stdout from a PostToolUse/Stop hook is silent. The agent only sees text injected via `hookSpecificOutput.additionalContext` (for PostToolUse) or `reason` (for Stop with `decision: "block"`). Print to stderr for debugging; print to stdout in the structured JSON envelope for visibility.

### 5. Don't try to detect a "stop_hook_active" field
It doesn't exist in Claude Code's Stop hook input. The protection against Stop-loops is natural: once reply() clears /pending, the next Stop sees no questions and exits.

### 6. `os.tmpdir()` aside — never trust process.cwd() inside hooks either
Hooks may execute with any working directory. Use absolute paths or read `cwd` from the hook input JSON.

### 7. Single bad MCP tool call should never kill the server
Every tool handler in `executeTool()` runs inside the request handler. If a handler throws, it propagates up unless we wrap the call site. `executeTool` must be called inside `try/catch`. Also: `process.on("uncaughtException")` and `process.on("unhandledRejection")` as final safety nets. We learned this from the `broadcast({content: undefined})` crash.

### 8. SSE drops kill connected Claude sessions
When the server process dies, all SSE connections terminate abruptly. Claude Code's MCP client doesn't always recover gracefully — sessions may die. **Always do graceful shutdown**: catch SIGTERM/SIGINT, send `event: close` to every SSE client, then exit. `./claude-bridge --stop` does this correctly. `kill -9` does not.

### 9. Multiple SSE connections per session is a footgun
If the same Claude session reconnects (bridge restarted, SSE dropped, settings hot-reload), the old SSE connection may still appear "alive" because of keepalive pings. New questions get queued for the new connection's name; the old one is a ghost. The `register()` handler detects this via `claude_session_id` and explicitly closes the old SSE. Don't remove that code.

### 10. Pending asks must be migrated, not failed
When a session re-registers under a new name (rename or reconnect), pending questions targeted at the OLD name must be reassigned to the NEW name. Failing them strands the asker. See the migration loop in `register()`.

### 11. The skill auto-discovery works through the `description` field
Claude Code reads `description` from SKILL.md frontmatter to decide when to auto-invoke. Keep it specific and keyword-rich — list the actual tool names, the triggers ("bridge question", "another agent", "register"). Avoid generic phrases.

### 12. CLAUDE.md edits are PERMANENT until --uninstall
A user reported that appending ~70 lines of protocol docs to their global `~/.claude/CLAUDE.md` was invasive — every Claude session everywhere paid the token cost. Switched to the skill model. **Never append to CLAUDE.md again.** The legacy cleanup function (`remove_claude_md_legacy`) stays in claude-bridge to fix older installs.

### 13. The bridge MCP isn't loaded in pre-install sessions
If you install cc-bridge mid-session, hooks fire (settings.json is hot-loaded) but MCP tools aren't available (MCP connects at session start). Hooks now check `/tmp/claude-bridge-${SESSION_ID}.mcp` written by SessionStart — if MCP isn't registered, they exit silently. Otherwise they'd spam every tool call telling the agent to call `register()` when the tool doesn't exist.

### 14. The "MCP installed" check via `claude mcp list` is slow (~1s)
Run it ONCE per session in SessionStart and cache the result. Other hooks just read the cache.

### 15. Uninstall IS a full teardown — it STOPS the running bridge (reversed v2.7.0)
**Originally** uninstall left the server running (the thinking: it might serve other sessions). The owner reversed this: **uninstall = remove everything AND stop the bridge + close the tunnel.** Implementation rules that must hold:
- The bridge stop is the **LAST** action in the uninstall case, *after* all config/file removal. Reason: if uninstall is run from a session bound to the bridge, stopping it disconnects that session and the harness may SIGKILL the in-flight script (lesson #23) — doing it last means every other cleanup step has already completed.
- It stops by **listener port** (`lsof -ti:PORT -sTCP:LISTEN`), not the PID file — the temp cleanup deletes the PID file first, and the bridge may be unmanaged. Capture the **tunnel** PID *before* the `/tmp` wipe (the wipe removes `claude-bridge-tunnel.pid`), then kill it.
- Graceful first (`SIGTERM` → server emits `event: close`), then `SIGKILL` after a short grace if still bound.
- A loud warning prints at the top ("connected sessions will disconnect; run from a separate terminal"). Uninstall stays non-interactive (no prompt).
- Test: `tests/test-cli.sh` starts a throwaway bridge on an isolated HOME + port 7497 and asserts uninstall leaves the port free. **Every test that invokes `uninstall` MUST set `CC_BRIDGE_PORT` to an unused port AND the `CC_BRIDGE_TUNNEL_*`/`CC_BRIDGE_SPOKE_PIPE_*` path overrides** (uninstall skips the global `/tmp/claude-bridge-*` wipe when the tunnel paths are overridden — without the overrides it kills the REAL tunnel PID and wipes live session state; this bit us TWICE: test-share-flags 2026-06, test-cli uninstall 2026-06-10) — uninstall now kills the listener on `$PORT`, so a default-port (7400) uninstall in a test stops a live production bridge. This regression bit us: the skill-install round-trip test called `uninstall` with no port and killed the dev's running :7400 bridge during `npm test`. (Never run uninstall against :7400 from tests.)

### 16. The `Monitor` tool is the ONLY way to wake a dormant agent — and the repo can't call it
Hooks fire during active work (PostToolUse/Stop) but nothing fires while a session is truly idle, waiting on the user. A hook that spawns a detached background poller can't help: a detached process has no channel back into the model. The only primitive that re-invokes a dormant agent is a background `Monitor` task **the agent itself armed** (its stdout lines become harness notifications). So the bridge can't "auto-run" a monitor — it can only *instruct the agent* to arm one. The idle-listener does exactly that: `bridge-hook.sh` nudges the agent (once, on first ask/reply) with a ready-made Monitor command. This is Claude Code CLI only (Desktop has neither hooks nor Monitor).

### 17. Idle-listener costs zero tokens ONLY because the command emits on change
The Monitor poll loop runs in the shell — the model is invoked **only when the command prints a line**. The arm command must therefore stay silent unless a *new* question id appears (dedupe via `grep -o 'id: ...' | sort` compared to the previous round). If you "improve" it to also emit health/heartbeat/bridge-down lines, every one of those wakes the agent and burns tokens — the user explicitly wanted idle = silent = free. Don't add chatter to that loop. The trigger excludes `register`/`list`/`inbox` on purpose: only *engaging* (ask/reply) means "you're in a conversation, stay reachable."

### 18. The `.monitor` stamp is written by the AGENT on arm — NOT optimistically by the hook
`/tmp/claude-bridge-${SESSION_ID}.monitor` holds `on` (agent has armed the Monitor), `off` (user disabled), or is absent (eligible). The hook nudges whenever it's absent and re-nudges on every ask/reply until it's set. **The first version had the hook write `on` itself, the moment it nudged — that was a bug.** The nudge is only advisory `additionalContext`; the agent may not act on it (especially as an *asker*, where the nudge arrives bundled with the reply it was waiting on). Writing `on` pre-emptively meant a skipped nudge was lost forever: the session showed `on` but had no monitor running, and never got re-nudged. Fix: the AGENT runs `echo on > $MONITOR_FILE` only once the Monitor is actually live; the hook keeps reminding until then. "Stop the bridge listener" → agent writes `off`; re-enable → `rm`s the file. It's a `/tmp` runtime file, not an install artifact, so it's NOT in the manifest — but `bridge-end-hook.sh` must `rm` it on SessionEnd (it's in the glob). If you add more per-session `/tmp` files, add them there too.

Trade-off (originally accepted, now CLOSED — see next paragraph): while un-armed, the PostToolUse reminder repeats on each ask/reply (engagement-rate-limited, never on idle ticks). This advisory nudge was **reliably skipped by askers** — `ask()` blocks and returns the answer in the same step the nudge is appended, so the model fixates on the answer and treats the nudge as FYI. Don't rely on the nudge alone.

**Arm-enforcement at Stop (the fix for asker-skips-it).** The PostToolUse hook now writes a `.engaged` marker on `ask`/`reply`; the **Stop hook** blocks the turn **once per engagement** (`decision: block` with the arm instruction) when `.engaged` is set, the `.monitor` stamp is neither `on` nor `off`, and a per-episode `.armblocked` marker isn't present. At Stop the answer is already delivered, so the instruction lands cleanly and `block` *makes* the agent act (same mechanism as the pending-question block). Loop-safe: `.armblocked` is set on the block and cleared by the PostToolUse hook on the next `ask`/`reply`, so it's at most one block per engagement episode (no Stop-loop, lesson #5) and re-arms if the session engages again. Respects `off` (user-disabled) and `on` (already armed). The two new `/tmp` markers (`.engaged`, `.armblocked`) are runtime-only — NOT manifest artifacts — but `bridge-end-hook.sh` must `rm` them on SessionEnd (added to its explicit list). Tests: `test-monitor-trigger.sh` cases 13–18. A session that genuinely can't run Monitor would be blocked once per engagement; that's bounded (one block/episode), not a loop.

**Resume kills the Monitor — the `rearm` state fixes the stale stamp.** A background Monitor is tied to the session process: a restart/resume kills it, but the `.monitor` stamp (a `/tmp` file) survives. `SessionEnd` clears the stamp, but a *resume does not reliably fire `SessionEnd`* — so a resumed session was left showing `on` with no live Monitor, and the hook (which only nudges when the stamp is absent) never re-armed it. Fix: a fourth stamp state, **`rearm`**. `bridge-start-hook.sh` (SessionStart) flips `on` → `rearm` on every (re)start; `bridge-hook.sh` treats `rearm` like "eligible but on ANY tool call, not just ask/reply" — so the first tool call after a resume re-nudges (with the name freshly resolved via `/whoami`), and the agent re-arms. `off` and absent are left untouched by SessionStart. The agent still writes `on` only once the Monitor is genuinely live (so `rearm` keeps re-nudging until then — same anti-optimistic-write rule as above).

### 19. Message "pending" is `answer === null` — a one-way NOTICE must carry NO `answer`
The whole pending/delivery system keys on `answer === null`: it's what blocks `ask`, what `/pending` re-injects, what `getPendingFor`/`reply`/`check_inbox` treat as "awaiting a reply." The `notify` tool's one-way NOTICE (`kind: "notice"`) therefore stores **no `answer` field at all** and uses a separate `delivered` boolean instead. If you ever give a notice an `answer: null`, it will instantly start behaving like an unanswered question — re-injected forever, "reply NOW" prompt, targetable by `reply()`. Don't. The filters also carry an explicit `m.kind !== "notice"` guard as belt-and-suspenders; keep it. Notices are delivered exactly once (marked `delivered` on first read via `/pending` OR `check_inbox`), appear in `get_thread`, and migrate on rename/reconnect alongside pending asks.

### 20. The idle-listener grep and the `/pending` output are coupled — change them together
The Monitor command embedded in `bridge-hook.sh` greps `'Question from|NEW QUESTION|NOTICE from|id:'` and dedupes on `id: <id>`. So any new message type surfaced by `/pending` must (a) include an `id: <id>` line (for dedupe) and (b) have its banner keyword added to that grep, or an idle session won't wake on it. That's why adding `notify` required editing both the server's `/pending` block AND the hook's grep. Already-armed monitors from before a grep change only pick up the new keyword after re-arming.

### 21. The idle-listener MUST peek `/pending?peek=1` — a consume-once message it polls would be eaten before the agent reads it
`/pending` marks one-way notices `delivered` as a side-effect of the GET (questions are NOT consumed — they persist until answered, so this never bit them). The idle-listener polls `/pending` every 25s; if it consumed, the monitor's own poll would mark the notice delivered, then wake the agent with only the grepped banner (the content line doesn't match the grep) — and the woken agent's `check_inbox` would find nothing. **Real bug we hit:** a notice arrived, the listener woke the receiver, and its inbox came back empty because the listener's poll had already eaten it. Fix: the monitor uses `/pending?session=X&peek=1`, which renders without marking delivered. Consumption (mark-delivered) happens only on the real-delivery paths — the PostToolUse hook injection and `check_inbox` — where the content actually reaches the agent. **If you add another consume-once message type, the monitor must peek it too.**

### 22. `notify` to an offline name is a dead-letter when names are auto-generated
`notify` queues for an offline target and delivers when a session by that name next polls (30-day TTL). But auto-generated names are random per session-start (`<dir>-<4hex>`), so a notice addressed to a *stale* name will essentially never deliver — no future session reclaims it. `notify` is reliable for currently-online sessions and for stable names (`CC_BRIDGE_SESSION`); addressing a name that has since rotated is user error, not a bug. Don't "fix" this by trying to reroute — the sender chose the name. Documented as a limitation in USAGE.md.

### 23. NEVER `--stop`/`--restart` the bridge from a session connected to it — and the server must die on a bind failure
Two related failures, both diagnosed from a real incident (a live session was SIGKILLed, exit 137, mid-`--restart`):

**(a) The self-restart hazard.** `--stop`/`--restart` tears down every SSE connection — including the MCP transport of the session running the command. When that session loses its tool provider, the Claude Code harness kills it (the in-flight Bash child takes the SIGKILL). Graceful shutdown (`event: close`) does NOT save it: it makes the disconnect *tidy*, but you cannot keep a tool provider alive while it restarts itself. There is no server-side fix. The mitigation is procedural: **run lifecycle commands from a separate terminal**, never from a Claude session bound to the bridge. `claude-bridge` now prints a loud warning on `--stop`/`--restart`. A plain `--start` is safe (it never stops anything). It was NOT an OOM and NOT claude-bridge killing the parent — `stop_bridge` only ever `kill`s the bridge PID.

**(b) The orphan-process leak.** `bridge-server.mjs` had no `server.on("error")` handler, so a startup `EADDRINUSE` was swallowed by the catch-all `uncaughtException` (lesson #7) — the process never bound a port and never exited, kept alive forever by the keepalive + gc `setInterval`s. Result: headless zombie servers (we found three ~17 days old). Fixed: `server.on("error")` now `process.exit(1)` on bind failure. And `start_bridge` no longer trusts the PID file alone (it's written only *after* a successful bind) — it polls `/health/ping` (the ungated liveness probe; the full `/health` is token-gated when sharing is on — see lesson #26) and reaps the child if the server never serves. Regression-tested in `test-process-mgmt.sh` (a second server on a busy port must exit, not orphan).

### 24. Federation is an additive relay layer — inject remote messages into the LOCAL store, don't rewrite handlers
The whole reason cross-network is small: a remote `ask`/`notify` is forwarded to the owning node, which calls `injectRemote()` to put a **shape-identical** message object into its own `messages` Map. From there, every existing path runs untouched — `/pending`, the Stop hook, the idle-listener peek, `check_inbox`, the blocking `ask` poll loop, `get_thread`, GC, rename migration. **Do not add a "remote" branch to each tool handler.** The only handler changes are: target resolution via `resolveTarget` (`ask`/`notify`), and an answer-relay tail on `reply`. `injectRemote` MUST preserve the invariants: a question has `answer:null`; a notice carries **no** `answer` field, only `delivered` (lesson #19). Inject is idempotent (`messages.has(id)` for q/notice; `answer!==null` for an answer) so re-forwards on reconnect are safe.

### 25. `resolveTarget` is local-first; `globalRoster` is live-only but routing must see offline-but-known spokes
`resolveTarget(to)` resolves a **bare** name to a LOCAL session if one exists (local-name-wins), else a remote one; `name@node` targets a specific remote session. **Subtlety:** `globalRoster()` only lists spokes whose stream is currently live (so `list_sessions` doesn't show ghosts). But for **lossless reconnect** the hub must still *route* a message to a spoke whose stream just dropped (its `spokes` entry persists until the 45s sweep). So `resolveTarget` has a hub-side fallback that scans `spokes` (incl. offline) for the name and returns `{kind:"remote", node}` — `relayForward` then queues it (`markPendingRelay`) and `flushPendingForwards` re-pushes on reconnect. If you "simplify" routing to use `globalRoster` alone, you reintroduce message loss across a brief link blip. The split is deliberate: **roster = live (display); routing-for-queue = known (durability).**

### 26. The `/health` split: ungated `/health/ping` + token-gated `/health`
A localhost-forwarding tunnel makes remote requests arrive from `127.0.0.1` — you **cannot** trust loopback to skip the token on anything tunneled. So when sharing is on, `/health` (which lists session names) and all `/link/*` require `X-Bridge-Token`. But `claude-bridge --check`, `start_bridge`'s liveness poll, and the test `health()` helper hit `/health` unauthenticated — gating it fully would break them. Fix: a separate **ungated** `/health/ping` returning only `{status, role, node, sharing}` (NO session names). `--check` and `start_bridge` use the ping; the full `/health` stays gated. `/sse`, `/message`, `/pending`, `/whoami` are never gated (never tunneled — gating them would force the token into the hooks, which we refuse). Standalone (no token) leaves `/health` open, so existing tests are unchanged.

**The hooks MUST follow this split too (BUG-5, fixed).** The hooks are token-free by design, so for **liveness** they must probe `/health/ping`, and for **"is this session registered"** they must use `/whoami?session_id=` — NEVER `curl -sf .../health` (which `401`s once a token is present). The original hooks used `-sf /health` for liveness and parsed `/health`'s `.sessions`; that worked only while standalone. The moment a machine became a hub/spoke (token set), every hook saw `401`, concluded "bridge down", and bailed silently → **new sessions stopped auto-registering and stopped getting the idle-listener nudge** (reported in the field). If you add a new hook or a new liveness/registration check in a hook, use `/health/ping` + `/whoami`, never `/health`. Regression: `tests/test-hook-token-liveness.sh` starts a token-bearing bridge and asserts all three hooks still emit.

### 27. `POST /link/reload` exists so `--share`/`--join` never restart a running bridge (lesson #23a)
A restart drops every SSE client and can kill the calling session. So federation config lives in dotfiles (`.cc-bridge-{token,role,hub,node}`) and `--share`/`--join`/`--unlink`/`--stop-share` write them, then `curl -X POST localhost:7400/link/reload` makes the **running** bridge re-read them and bring up/tear down the link in place. `/link/reload` lives on the **main (loopback-only) server**, never the tunneled fed listener, and is **token-gated (when a token is configured) AND restricted to a loopback peer** (`req.socket.remoteAddress`) — defense-in-depth from the v2.7.0 hardening (lesson #29). `claude-bridge fed_reload` and `tests/lib.mjs reloadFed` therefore send `X-Bridge-Token` when a token is present. Never go back to "restart the bridge to enable sharing," and never make `/link/reload` token-free again.

### 28. The spoke outbound link needs reconnect backoff; the hub prunes on write-error + sweep
The spoke opens `GET /link/stream` to the hub with `node:https` (or `http` for tests). On any drop it reconnects with exponential backoff (1s→2s→5s→…→30s, reset on success) — **do not hot-loop** a reconnect (lesson #8/#23 cascade risk). The hub prunes a spoke on stream close, on SSE write-error (`linkSend` nulls `res`), and via a 15s liveness sweep (45s stale cutoff), rebroadcasting the roster each time — the link version of lesson #9 ghost de-merge.

**Spoke heartbeat (keeps the lossless-reconnect window honest).** The sweep prunes a spoke (and deletes its `pendingRelay` queue) when it is `dead && now-lastSeen > SPOKE_STALE_MS`. `lastSeen` advances only on inbound spoke→hub traffic (`/link/register|forward|heartbeat`); the 25s `ka` ping is hub→spoke and does NOT touch it. So **the spoke POSTs `/link/heartbeat` every `SPOKE_HEARTBEAT_MS` (25s)** — without it an *idle* spoke is already stale when it disconnects and the next sweep tick wipes its queue within seconds, silently dropping messages queued during the outage (found by the real Mac↔VM tunnel chaos: an idle-spoke crash lost a queued notice; a freshly-active one kept it). Start the heartbeat in `connectToHub`'s 200 block, clear it in `teardownHubStream` and on gen-change. The three timings are env-overridable (`CC_BRIDGE_HEARTBEAT_MS`/`CC_BRIDGE_SPOKE_STALE_MS`/`CC_BRIDGE_SPOKE_SWEEP_MS`) so `test-federation-heartbeat.mjs` can drive the stale-prune deterministically; production never sets them (25s/45s/15s). This also serves as the sub-100s Cloudflare SSE keepalive on the link path. A `spokeGen` counter invalidates stale stream callbacks after a teardown so a late `data` event from an old connection can't corrupt `remoteRoster`. **On link-drop the spoke also CLEARS `remoteRoster`** (in `scheduleSpokeReconnect` — covering all drop paths — and `teardownHubStream`): otherwise a downed hub's sessions linger as ghosts, `resolveTarget` keeps treating them as routable, and a blocking `ask` to one hangs the full 5-min deadline instead of failing fast with "not connected" (G7). It repopulates from the `/link/register` response + roster broadcast on reconnect. Tunnel/cloudflared is never invoked in CI — the link transport is plain HTTP between two local ports in tests; cloudflared is detect-and-instruct (`test-share-flags.sh` uses a fake cloudflared on PATH). **Gotcha:** claude-bridge runs under `set -euo pipefail`, so an empty `grep ... | head -1` in a command substitution aborts the script — guard tunnel-URL parsing with `|| true`.

### 29. NEVER tunnel the main bridge port — there are TWO listeners, and only the loopback fed port is exposed (v2.7.0 hardening)
The original Phase-1 federation tunneled the whole bridge (`cloudflared tunnel --url http://localhost:7400`). But `/sse`, `/message`, `/pending`, `/whoami` are intentionally token-free ("local only, never tunneled" — lesson #26). With the whole port tunneled, anyone with the URL could register a session, ask/notify, and read any session's pending messages **with no token**. The fix is structural, not just gating:

- **Two listeners, both loopback.** The **main** `http.createServer` binds `127.0.0.1:PORT` (was all-interfaces — also LAN-exposed; fixed) and serves ALL local routes. It is NEVER tunneled. In **hub mode** a **second** server binds `127.0.0.1:FED_PORT` (`CC_BRIDGE_FED_PORT`, default `PORT+1`) and serves ONLY the token-gated `/link/*` surface + the content-free `/health/ping`; **every other path 404s** (`handleLinkRequest`). The fed listener shares the process's in-memory state (same module scope).
- **The tunnel points at `FED_PORT`, not `PORT`.** Both the quick-tunnel and named-tunnel `cloudflared` invocations in `claude-bridge` use `$FED_PORT`. So `/sse`/`/message`/`/pending`/`/whoami`/full-`/health` simply do not exist on the tunneled surface — the hole is closed by construction, not just by a token check.
- **Lifecycle:** `applyFedConfig()` calls `startFedListener()` when this node becomes a hub and `stopFedListener()` when it leaves hub mode. A **spoke** makes only OUTBOUND connections to the hub and **never binds the fed port** (verify this if you touch `applyFedConfig`). Standalone never binds it either, so standalone is byte-for-byte unchanged. Both listeners get the EADDRINUSE-fatal `server.on("error")` treatment (lesson #23b) and are closed in `shutdown()`.
- **Why a separate port instead of path-filtering one port?** A single port can't be "tunneled for `/link/*` but not for `/sse`" — cloudflared forwards the whole origin. Two ports is the only way to expose the link surface without exposing the local routes.
- **Tests:** `tests/lib.mjs` knows the fed port (`port+1` default, third constructor arg to override); `raw()` routes `/link/*` to the fed port automatically (`onMain`/`onFed` overrides force a port). The federation tests point the spoke's `hub` URL at the HUB's fed port. `test-token-auth.mjs` has the regression assertions: main port 404s `/link/*`; fed port 404s the local routes + full `/health`; fed `/link/*` needs the token; fed `/health/ping` leaks no names; `/link/reload` rejects a wrong token. **Do not collapse back to one port.**

### 30. Chaos suite gotchas + the federation resilience gaps it pins (test-federation-chaos.mjs)
The chaos suite (hub + two spokes, all localhost) is the first test to **restart a bridge on the same `TestBridge` instance** and to crash spokes mid-flight. Two harness fixes were required and must stay (lesson: a harness built for one-shot bridges hides restart bugs):
- **`TestBridge.start()` resets `this.sid` + `this.responses`.** Without it, a second `start()` keeps the stale session id and the SSE handshake's `!this.sid` guard never captures the new `session=` line → a silent 5-min-style "SSE handshake timeout". Any test that does `stop()`+`start()` depends on this reset.
- **Spawn the server's stdout as `"ignore"`, not `"pipe"`.** An unread pipe fills its ~64KB buffer once the server logs enough and the **synchronous** `console.log` blocks the event loop → `/sse` stops being served. Production redirects stdout to the log file, so it never bites there — only the harness did. Don't reintroduce an unread stdout pipe.
- Tests must use lowercase node ids in assertions because `sanitizeNode` lowercases them (roster renders `name@spokea`). **`@node` addressing is now case-insensitive** — `resolveTarget` `sanitizeNode`-normalizes the node part, so `ask("alice@MyLaptop")` resolves (G6 fixed).

Resilience limitations the suite originally pinned — status after the Tier-1 fix pass:
1. ✅ **In-flight question loss — FIXED (G4).** `flushPendingForwards` now, on reconnect, also scans `messages` and re-pushes any still-open question/undelivered notice addressed to a session on the reconnecting node (idempotent via `injectRemote`). It is called from BOTH `/link/stream` connect and `/link/register` (the register-after-stream race). So a question a spoke received and lost to a crash is re-delivered and the asker is answered.
2. ✅ **Qualified-notify to an offline spoke — FIXED (G3).** The `@node` branch of `resolveTarget` now has the same offline-spoke fallback as the bare-name path, so both forms `markPendingRelay` and flush losslessly.
3. ⬜ **Orphan-question adoption** (low, still open). The asker keeps an un-answered question with `to:"<name>"` (30d TTL); a NEW *local* session later registering under that name inherits it as pending. Rare for auto-generated names; surprising for stable `CC_BRIDGE_SESSION` names.

### 31. Tier-2 DoS/info-leak hardening — caps, rate limit, and the 413 keep-alive gotcha
Added bounds so a flood / hostile-but-authenticated peer can't exhaust the hub, plus privacy fixes. All limits are env-overridable (`CC_BRIDGE_MAX_BODY`/`MAX_NODES`/`MAX_SESSIONS`/`RATE_MAX`/`RATE_WINDOW_MS`/`SHARE_DESCRIPTIONS`) with production-safe defaults; `test-hardening.mjs` shrinks them to trip the caps deterministically.
- **Rate limiting** is on the message-CREATING tools only (`ask`/`notify`/`broadcast`) keyed by `sse:<sseId>`, plus `/link/forward` keyed by `node:<node>`. **Never** rate-limit reads (`check_inbox`/`list_sessions`/`get_thread`/`/pending`), `register`, or `reply` — that would break the blocking-`ask` round-trip and reconnect flushes. The bucket map is GC-pruned (idle buckets refill fully → deleted).
- **Descriptions don't cross the link** by default — `linkSessions()` (name-only) is what `broadcastRoster`/`spokeAdvertise` send, NOT `activeSessions()` (which keeps descriptions for LOCAL `list_sessions`). If you add a new link-crossing roster path, use `linkSessions()`.
- **The 413 keep-alive gotcha (cost me a test):** on an over-cap body, do **not** `req.destroy()` mid-read and keep the connection — Node ≥19 pools keep-alive sockets by default, so the half-read socket gets reused and the NEXT request on it ECONNRESETs. Respond `413` with **`Connection: close`** and `res.end()` so the agent discards the socket. Same rule for any early-abort response that hasn't drained the request body.
- **Don't log message content.** `ask`/`notify` log lines carry only `id` + char-count, never the question/notice text (the log is world-readable until claude-bridge's `0600`). Keep it that way.

### 32. Tunnel providers are four case-dispatched functions + shared state files — update every reader together

`share` dispatches on a provider name (`p2p` default | `cloudflared-named` | `bore` | `pinggy` | `zrok` | `tailscale`; `cloudflared-quick` is REJECTED with an explanation — lesson #33) to `provider_<p>_{ensure,launch,extract,warn}` (bash-3.2-safe computed names — no associative arrays; `-` → `_` via `tr`). Shared state: `TUNNEL_{PID,URL,PROVIDER}_FILE` + the tunnel log (ALL env-overridable for tests — `CC_BRIDGE_TUNNEL_{PID,URL,LOG,PROVIDER}`), plus the spoke-side `SPOKE_PIPE_{PID,PORT,TICKET}_FILE` (`CC_BRIDGE_SPOKE_PIPE_*`). Rules learned the hard way:
- **Readers and writers move together.** `stop_share`, `stop_share_tunnel_only`, `check_bridge`, `doctor`, `health_cmd`, and `uninstall` ALL read these files. Adding a provider or file means auditing every one of them.
- **tailscale is the odd one out**: no process of ours, no PID file — `tailscaled` owns the forward. Its liveness is `tailscale serve status` (never `pgrep`), and its serve config **persists across reboots**, so teardown must run `tailscale serve --tcp $FED_PORT off` and VERIFY. It must use `serve --tcp` (L4); the HTTP serve/funnel modes buffer SSE (same bug class as quick tunnels).
- **The p2p spoke forwarder**: `join 'p2p:<ticket>#<token>'` spawns `dumbpipe connect-tcp` (same detach hardening as `launch_tunnel`), writes the pipe files, and rewrites the hub URL to `http://127.0.0.1:<port>`. `unlink` MUST notify the hub BEFORE killing the forwarder (the unregister POST rides the pipe). `uninstall` captures the pipe PID before the /tmp wipe, same as the tunnel PID.
- **Fake-binary tests** (`tests/test-providers.sh`): every fake writes its URL after a ~1s delay (exercises the extractor's poll loop); a fake `ssh` MUST be removed from PATH after its case (everything later would break); per-provider extract functions keep the fake's output format and the real grep from drifting apart.

### 33. The SSE-buffering table — which transports can actually carry the bridge

Verified June 2026 (deep-research + Opus verification pass, sources in docs/specs/2026-06-10-multi-tunnel-providers-plan.md):
- ❌ **cloudflared QUICK tunnels buffer SSE** until the origin closes the connection — events through `/link/stream` NEVER arrive (cloudflared#1449; now stated in official docs; confirmed intentional "demo product guardrails" by a CF maintainer). This was the real cause behind the "quick tunnels are flappy" field reports.
- ✅ cloudflared NAMED tunnels stream SSE correctly — but run ONE connector per hostname (two = CF load-balancing = intermittent 530/1033 split-brain).
- ❌ **Tailscale Serve/Funnel HTTP modes buffer SSE** (opencode#16726) + WS drops (tailscale#18827). ✅ `serve --tcp` (L4) and raw tailnet IP access are fine.
- ❌ MS dev tunnels: hard 504 on SSE at 15 min (dev-tunnels#518, closed not-planned). Excluded.
- ❌ ngrok free: no idle timeout but 20k req/mo + 1GB/mo quotas — a chatty broker exhausts them. Excluded.
- ✅ Raw-stream transports are SSE-safe by construction: bore (TCP — but PLAINTEXT through the relay), pinggy (ssh stream; 60-min free cap), zrok (Ziti), dumbpipe (QUIC, E2E-encrypted, multi-connection through one ticket, auto relay fallback — hole-punching succeeds ~70% in production measurements, so the fallback matters).
- Rule of thumb: **anything that proxies HTTP must prove it streams; anything that moves raw bytes is safe.**

### 34. Rooms (3a): the store is server-owned; auth is a gate-swap; tests isolate `CC_BRIDGE_ROOMS_FILE`

The rooms store (`~/.claude/.cc-bridge-rooms.json`) is owned by the RUNNING server — the CLI never edits it, it drives the loopback `/room/*` admin surface (same defense as `/link/reload`). `roomAuth()` wraps `tokenOk()`: no room → legacy compare (standalone/shared-token suites pass untouched, which IS the back-compat proof); room → sha256 member-token lookup. Invariants: tokens/invites stored HASHED (plaintext shown once); saves are atomic (tmp+rename — a truncated store would silently un-revoke kicks); `/link/join` is the only unauthenticated link endpoint and sits behind its own strict bucket (`CC_BRIDGE_JOIN_MAX`/`_WINDOW_MS`); kick/rotate/delete must `severSpoke()` (close stream + prune pendingRelay + rebroadcast roster) or the kicked spoke ghosts until the sweep. `lib.mjs` ALWAYS isolates `CC_BRIDGE_ROOMS_FILE` per test bridge, and `stop()` deliberately does NOT delete it (stop+start models a restart; revocation-survives-restart is a tested guarantee). The `enc` field is now LIVE (3b): seal at the outbound seams (ask/notify remote, reply's relay tail, BOTH re-flush paths — pushForwardToSpoke and flushSpokeOutbound re-encrypt fresh, never reuse a nonce), open ONLY in injectRemote. If you add a new relay path, it must either pass `enc` through untouched or re-seal — the routeForward answer branch DROPPED `enc` when rebuilding its payload and the sealed answer never arrived (caught by test-e2ee). Crypto is node:crypto only (chacha20-poly1305 + scrypt) — do NOT add libsodium; zero-deps still holds. Key material: rooms.json holds the raw key on the OWNER (0600, owner is a participant in 3b) and a password-WRAPPED copy (scrypt with a salt DIFFERENT from the join-gate hash — same-salt would let the hub unwrap); members hold `.cc-bridge-room-key`. An undecryptable answer must NOT un-pend its question (injectRemote guards non-string answers).

### 35. NEVER feed a network/JSON value to bash `$(( ))` — arithmetic expansion executes

`$(( expr ))` evaluates `expr` as a bash expression, and array-subscript syntax inside it runs commands: `$(( a[$(rm -rf x)] ))`. A value pulled from any response (`jq -r .field` off the rendezvous or a bridge reply) reaching arithmetic is a command-injection hole (real HIGH finding, 2026-06-11, the expiry-date display). Rule: validate pure-integer (`case "$v" in ''|*[!0-9]*) ...`) BEFORE arithmetic. Use the `expiry_human()` helper for epoch-MS → date. jq-internal arithmetic (`.expires_at/1000` inside a jq program) is fine — that's jq, not bash. Loop counters (`i=$((i+1))`) are fine — the operand is ours.

---

## Versioning + manifest approach

`claude-bridge` reads `VERSION` from `package.json` and writes:
- `~/.claude/.cc-bridge-version` — single line, version string
- `~/.claude/.cc-bridge-manifest` — list of paths the installer created/touched

The uninstaller reads the manifest first (removes everything listed), then runs the full hardcoded cleanup as a belt-and-suspenders backup (for installs that predate manifest tracking).

**Why both?** Manifest handles future versions that install files we don't know about today. Hardcoded cleanup handles old installs that have no manifest yet.

**When you add a new file/dir to install:**
1. Add `manifest_add FILE "$path"` or `manifest_add DIR "$path"` next to the copy/mkdir
2. Add the corresponding `remove_*` function for the hardcoded cleanup
3. Bump `package.json` version (semver — minor for new features, patch for bug fixes)

**When you change file format/location across versions:**
1. Move the OLD version's content to `versions/v<old>/` for historical reference (or just rely on git history)
2. The NEW install writes the new location into the manifest
3. The uninstall hardcoded cleanup also removes the OLD location (e.g., `remove_claude_md_legacy` removes the pre-skill CLAUDE.md injection)

---

## CHANGELOG discipline

`CHANGELOG.md` is the canonical record of what shipped when. Update it
**while you work**, not after.

- Every time you start a new version, open `[Unreleased]` and add entries
  under `Added`, `Changed`, `Fixed`, `Removed`, or `Deprecated` as you go.
- When you tag a release, rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`
  and create a fresh empty `[Unreleased]` at the top.
- Each entry is one short line — the *what* and the *why*, not the *how*.
  PR descriptions and commit messages hold the implementation details.
- Bumping `package.json` `version` and the banner in `bridge-server.mjs`
  is half the release; finalizing the CHANGELOG entry is the other half.

If you can't summarize a change in one line for CHANGELOG, the change is
probably too big — split it.

## Release checklist

Before tagging a release:

1. [ ] All entries for this version are under a dated heading in `CHANGELOG.md` (no leftovers under `[Unreleased]` unless intentional)
2. [ ] Bump `package.json` `version`
3. [ ] Bump version string in `bridge-server.mjs` startup banner
4. [ ] `npm test` — all green, zero failures
5. [ ] `./claude-bridge --uninstall` then `./claude-bridge` then `./claude-bridge --check` — all green
6. [ ] Restart bridge with `./claude-bridge --restart`, verify health endpoint
7. [ ] Update README "Status" section if non-trivial new features
8. [ ] Update USAGE.md if any user-facing flag/command changed
9. [ ] Update this DEVELOPER.md if you learned anything new
10. [ ] One squash commit per logical change, descriptive message

---

## How to test changes

### Run the test suite

```bash
npm test           # or: ./tests/run-all.sh
```

`run-all.sh` auto-discovers every `tests/test-*.mjs` and `tests/test-*.sh` file
and runs them in sequence. It exits non-zero if any test fails. The suite uses
port 7402–7404 so it won't disturb a running production bridge on 7400.

### Test layout

```
tests/
├── lib.mjs                       # shared SSE + JSON-RPC helpers; assert() / reportAndExit()
├── run-all.sh                    # discovers and runs every test, prints summary
├── test-tools.mjs                # MCP tools: register, broadcast, list_sessions, check_inbox, ...
├── test-graceful-shutdown.mjs    # SIGTERM emits `event: close` before exit
├── test-hook-mcp-check.sh        # hooks silent when MCP=no, runs clean when MCP=yes
├── test-process-mgmt.sh          # claude-bridge --start / --stop / --restart, PID file, idempotency
├── test-token-auth.mjs           # federation token gate accept/reject; ungated /health/ping; no-token guardrail
├── test-federation.mjs           # two-bridge link: roster merge, cross-link ask/reply, notify relay, invariants, gated health, drop-prune
├── test-federation-reconnect.mjs # lossless reconnect: queued message flushes idempotently after the link returns
├── test-federation-chaos.mjs     # hub+2 spokes: crash/restart/churn, spoke→hub→spoke routing, name@node, auth-under-chaos (lesson #30)
└── test-share-flags.sh           # claude-bridge --share/--join/--unlink/--stop-share parsing (fake cloudflared on PATH)
```

`lib.mjs`'s `TestBridge(port, fed)` takes an optional `fed = {token, role, hub, node}` that writes per-bridge temp config files and points the server at them (env `CC_BRIDGE_{TOKEN,ROLE,HUB,NODE}_FILE`) — so federation tests never touch the developer's real `~/.claude` dotfiles. `reloadFed()` rewrites them + hits `/link/reload`; `raw()`, `healthPing()`, and `health(token)` cover the gated endpoints.

### Rule: every new feature ships with a test

When you add a tool, a hook, a flag, or a server behaviour, add or extend a
test in `tests/`. The discovery is automatic — any file matching
`tests/test-*.{mjs,sh}` is picked up.

- New MCP tool? Add assertions to `tests/test-tools.mjs` using the `bridge.call(...)` helper.
- New claude-bridge flag? Add a `tests/test-<name>.sh` script that exits 0 on
  success and non-zero on failure. Use port 7404 (or a fresh one) so it
  doesn't collide with other tests.
- New server-level behaviour (shutdown, GC, reconnect)? New `tests/test-<name>.mjs`
  using `TestBridge` from `lib.mjs`.

### Manual smoke (after any change)

```bash
./claude-bridge --restart
./claude-bridge --check
npm test
```

`--check` must be all green; tests must report 0 failures.

---

## When you add a new tool

1. Add the schema to `TOOLS` array in `bridge-server.mjs`
2. Add a case to `executeTool` switch
3. **Validate every required arg** — `if (typeof args.X !== "string") return { error: "..." }`. The broadcast crash taught us this.
4. Update the tool table in `USAGE.md` (Required args / Optional args / What it does)
5. Update `skill/SKILL.md` if agents need new instructions for it
6. Add assertions to `tests/test-tools.mjs` covering happy path + invalid input
7. Add a line to `CHANGELOG.md` under `[Unreleased] → Added`

---

## When you add a new hook

1. Add the script to `hooks/`
2. Add an entry to `HOOK_MAP` in `claude-bridge`
3. The script MUST exit 0 on bridge-down (the install assumes hooks are resilient)
4. The script MUST check `/tmp/claude-bridge-${SESSION_ID}.mcp` and exit silently if "no" — this is the anti-spam pattern
5. Update the hook count in `check_hooks()` (currently expects 5)
6. Update USAGE.md hook configuration reference
7. Extend `tests/test-hook-mcp-check.sh` to cover the new hook's silence/run-clean contract
8. Add a line to `CHANGELOG.md` under `[Unreleased] → Added`

---

## When you change claude-bridge

1. **Test the full round-trip** — uninstall (with whatever was there), reinstall, check. All steps must succeed cleanly.
2. **Test from a clean state** — `rm -rf` the relevant artifacts, then install.
3. **Test idempotency** — run install twice, verify nothing duplicates.
4. If you create a new file or directory, register it in the manifest (`manifest_add`).
5. Update the "What claude-bridge modifies" table in USAGE.md.
6. Add or extend `tests/test-process-mgmt.sh` if you change a flag's behaviour.
7. Add a line to `CHANGELOG.md` under `[Unreleased]`.

---

## Planned features (designed, not built)

- [ ] **Cross-network federation (hub-and-spoke bridge linking).** Let sessions on different machines/networks talk, while each machine keeps working locally if the link drops. Full design recorded in [`docs/specs/cross-network-federation.md`](docs/specs/cross-network-federation.md) — read it before starting. Key shape: sessions ALWAYS stay on their local bridge (hooks unchanged); `--share`/`--join` link bridges at the bridge layer over a Cloudflare quick tunnel + token; the link injects remote messages into the destination's local `messages` store so all existing delivery (hooks, idle-listener, `check_inbox`, `ask`, `notify`) is reused untouched. Phased (Phase 1 = link + relay + merged roster). Its two foundational pieces — a **token-auth layer** (header + token file + `/health` gate) and a **link/SSE liveness tweak** (TCP keepalive + prune-on-write-error) — can land independently first and are useful on their own. This supersedes the **Auth** TODO below.

## Frequent TODOs (work that's perpetually almost-worth-doing)

- [ ] **Bridge logs**: rotate `/tmp/claude-bridge-server.log` — currently grows unbounded.
- [ ] **Test suite**: extract the end-to-end script into a proper `npm test`.
- [ ] **Linux verification**: README says Linux "should work, untested." Actually test it.
- [ ] **Persistence option**: optional SQLite backing for messages so server restarts don't lose state.
- [ ] **Web UI**: a `/debug` HTML page showing active sessions, message timeline, scratchpads. Currently `--check` and curl are the only views.
- [ ] **Auth**: the bridge is wide open on localhost. If someone runs untrusted code on their machine, it can spam the bridge. Maybe a token in `claude mcp add`'s URL.

These are not blockers. Each is a one-or-two-evening project. None are urgent — don't pick them up unless a user actually hits the pain.

---

## What NOT to do

- **Don't** add features without the user explicitly asking. The user has rejected several "nice to have" suggestions (auto-scratchpad-read, push notifications, etc.). Stick to user-requested work.
- **Don't** add MCP transports beyond SSE + stdio. We considered WebSocket; it's not worth the complexity.
- **Don't** add CLI commands to the bridge server itself. All UX lives in `claude-bridge`.
- **Don't** persist state to disk by default. The in-memory + 30d TTL design is intentional. Add persistence only as opt-in.
- **Don't** make the install script chatty by default. `--check` is for verbose status; `install` should be ~10 lines of output.
- **Don't** rename or move files in `hooks/` without updating settings.json migration logic in claude-bridge.
- **Don't** edit the user's `~/.claude/CLAUDE.md` for any reason. We learned that lesson.
- **Don't** use external dependencies in `bridge-server.mjs`. Zero deps is a feature.

---

## Files in this repo, ranked by "how often you'll touch them"

| File | Frequency | Notes |
|---|---|---|
| `bridge-server.mjs` | High | Most logic lives here. ~600 lines, single file by design. |
| `claude-bridge` | Medium | Every new file/dir/hook needs a line here. |
| `USAGE.md` | Medium | Update with every user-facing change. |
| `CHANGELOG.md` | Medium | Update WHILE you work, not after. One line per change under `[Unreleased]`. |
| `DEVELOPER.md` | Medium | Update when you learn something. THAT'S THIS FILE. |
| `tests/test-*.{mjs,sh}` | Medium | Add a test for every new feature. `run-all.sh` auto-discovers. |
| `skill/SKILL.md` | Low | Only when the protocol changes. |
| `hooks/*.sh` | Low | Stable. Only touch for MCP-availability logic or new events. |
| `bridge-stdio.mjs` | Rare | Desktop adapter. Almost never changes. |
| `README.md` | Rare | Sells the project. Don't bloat it with operational detail. |
| `BRIDGE.md` | Rare | Repo-level protocol doc; SKILL.md is the live copy. |

---

## Quick command reference

```bash
./claude-bridge                      # Install / re-install (idempotent)
./claude-bridge --uninstall          # Remove everything (manifest + hardcoded fallback)
./claude-bridge --check              # Status of all components
./claude-bridge --start              # Start bridge server (writes PID)
./claude-bridge --stop               # Graceful stop (SIGTERM, sends SSE close event)
./claude-bridge --restart            # Stop + start

curl -sf localhost:7400/health    # Server health + active session count
tail -f /tmp/claude-bridge-server.log # Server logs
cat /tmp/claude-bridge.pid            # Currently running bridge PID
ls /tmp/claude-bridge-*               # Per-session state files

claude mcp list                   # Verify bridge MCP is registered with Claude Code
claude mcp remove bridge          # Remove the MCP registration (uninstall does this)
```
