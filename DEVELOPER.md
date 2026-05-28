# DEVELOPER.md

Working notes for whoever maintains claude-bridge next — including future-me. This is the file you read **before** changing anything non-trivial.

---

## First-time setup if you're a developer of this repo

After cloning, **load this file into your Claude Code working context for every session inside this repo** so all the rules below are enforced automatically. There are two ways:

1. **Recommended — project-level CLAUDE.md (already exists).** This repo ships a `CLAUDE.md` at the root that `@`-references `DEVELOPER.md`. Claude Code auto-loads `CLAUDE.md` whenever it runs in this directory, so just `cd` here and you're done.
2. **If you keep your own notes in a fork's CLAUDE.md**, either append the contents of this file or add the line `@DEVELOPER.md` to it. Do NOT inject anything from this file into the global `~/.claude/CLAUDE.md` — same rule as the user-facing protocol docs (see "Skills over CLAUDE.md injection" in the owner's vision below).

Why this matters: half of this document is "do not redo these mistakes." If Claude can't see it, Claude redoes them.

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
Claude Desktop ──stdio──┘   (port 7400)        │
                                                ├── /tmp/claude-bridge-*  (session name files, MCP cache, stamps, PID)
                                                ├── /tmp/claude-bridge-server.log
                                                └── In-memory state (messages, threads, scratchpads — 30d TTL)

~/.claude/settings.json                       — 5 hooks point to hooks/*.sh
~/.claude/skills/claude-bridge/SKILL.md        — protocol docs (loaded on-demand by Claude)
~/.claude/.cc-bridge-version                   — installed version marker
~/.claude/.cc-bridge-manifest                  — list of files/dirs install touched (for uninstall)
~/Library/Application Support/Claude/claude_desktop_config.json  — Desktop MCP entry (macOS)
```

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
`/var/folders/.../T/` — so if the bridge writes its PID there but install.sh reads `/tmp/claude-bridge.pid`, the file is invisible to the script. **Always hardcode `/tmp/claude-bridge.pid`** (and other shared files) so the server, hooks, and install.sh agree.

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
When the server process dies, all SSE connections terminate abruptly. Claude Code's MCP client doesn't always recover gracefully — sessions may die. **Always do graceful shutdown**: catch SIGTERM/SIGINT, send `event: close` to every SSE client, then exit. `./install.sh --stop` does this correctly. `kill -9` does not.

### 9. Multiple SSE connections per session is a footgun
If the same Claude session reconnects (bridge restarted, SSE dropped, settings hot-reload), the old SSE connection may still appear "alive" because of keepalive pings. New questions get queued for the new connection's name; the old one is a ghost. The `register()` handler detects this via `claude_session_id` and explicitly closes the old SSE. Don't remove that code.

### 10. Pending asks must be migrated, not failed
When a session re-registers under a new name (rename or reconnect), pending questions targeted at the OLD name must be reassigned to the NEW name. Failing them strands the asker. See the migration loop in `register()`.

### 11. The skill auto-discovery works through the `description` field
Claude Code reads `description` from SKILL.md frontmatter to decide when to auto-invoke. Keep it specific and keyword-rich — list the actual tool names, the triggers ("bridge question", "another agent", "register"). Avoid generic phrases.

### 12. CLAUDE.md edits are PERMANENT until --uninstall
A user reported that appending ~70 lines of protocol docs to their global `~/.claude/CLAUDE.md` was invasive — every Claude session everywhere paid the token cost. Switched to the skill model. **Never append to CLAUDE.md again.** The legacy cleanup function (`remove_claude_md_legacy`) stays in install.sh to fix older installs.

### 13. The bridge MCP isn't loaded in pre-install sessions
If you install cc-bridge mid-session, hooks fire (settings.json is hot-loaded) but MCP tools aren't available (MCP connects at session start). Hooks now check `/tmp/claude-bridge-${SESSION_ID}.mcp` written by SessionStart — if MCP isn't registered, they exit silently. Otherwise they'd spam every tool call telling the agent to call `register()` when the tool doesn't exist.

### 14. The "MCP installed" check via `claude mcp list` is slow (~1s)
Run it ONCE per session in SessionStart and cache the result. Other hooks just read the cache.

### 15. Uninstall does NOT stop the bridge server
Intentional — the server may have active sessions from other users/contexts. Uninstall removes config files and the PID file, but the running process stays. Users must `./install.sh --stop` explicitly (or `lsof -ti:7400 | xargs kill`). The reinstall path handles this gracefully: `--start` reports failure if port is busy, and you can investigate with `--check`.

### 16. The `Monitor` tool is the ONLY way to wake a dormant agent — and the repo can't call it
Hooks fire during active work (PostToolUse/Stop) but nothing fires while a session is truly idle, waiting on the user. A hook that spawns a detached background poller can't help: a detached process has no channel back into the model. The only primitive that re-invokes a dormant agent is a background `Monitor` task **the agent itself armed** (its stdout lines become harness notifications). So the bridge can't "auto-run" a monitor — it can only *instruct the agent* to arm one. The idle-listener does exactly that: `bridge-hook.sh` nudges the agent (once, on first ask/reply) with a ready-made Monitor command. This is Claude Code CLI only (Desktop has neither hooks nor Monitor).

### 17. Idle-listener costs zero tokens ONLY because the command emits on change
The Monitor poll loop runs in the shell — the model is invoked **only when the command prints a line**. The arm command must therefore stay silent unless a *new* question id appears (dedupe via `grep -o 'id: ...' | sort` compared to the previous round). If you "improve" it to also emit health/heartbeat/bridge-down lines, every one of those wakes the agent and burns tokens — the user explicitly wanted idle = silent = free. Don't add chatter to that loop. The trigger excludes `register`/`list`/`inbox` on purpose: only *engaging* (ask/reply) means "you're in a conversation, stay reachable."

### 18. The `.monitor` stamp is written by the AGENT on arm — NOT optimistically by the hook
`/tmp/claude-bridge-${SESSION_ID}.monitor` holds `on` (agent has armed the Monitor), `off` (user disabled), or is absent (eligible). The hook nudges whenever it's absent and re-nudges on every ask/reply until it's set. **The first version had the hook write `on` itself, the moment it nudged — that was a bug.** The nudge is only advisory `additionalContext`; the agent may not act on it (especially as an *asker*, where the nudge arrives bundled with the reply it was waiting on). Writing `on` pre-emptively meant a skipped nudge was lost forever: the session showed `on` but had no monitor running, and never got re-nudged. Fix: the AGENT runs `echo on > $MONITOR_FILE` only once the Monitor is actually live; the hook keeps reminding until then. "Stop the bridge listener" → agent writes `off`; re-enable → `rm`s the file. It's a `/tmp` runtime file, not an install artifact, so it's NOT in the manifest — but `bridge-end-hook.sh` must `rm` it on SessionEnd (it's in the glob). If you add more per-session `/tmp` files, add them there too.

Trade-off accepted: while un-armed, the reminder repeats on each ask/reply (engagement-rate-limited, never on idle ticks). A session that genuinely can't run Monitor (no such tool) would be reminded each time it engages — bound it with a retry cap if that ever bites, but don't go back to the silent optimistic write.

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

**(a) The self-restart hazard.** `--stop`/`--restart` tears down every SSE connection — including the MCP transport of the session running the command. When that session loses its tool provider, the Claude Code harness kills it (the in-flight Bash child takes the SIGKILL). Graceful shutdown (`event: close`) does NOT save it: it makes the disconnect *tidy*, but you cannot keep a tool provider alive while it restarts itself. There is no server-side fix. The mitigation is procedural: **run lifecycle commands from a separate terminal**, never from a Claude session bound to the bridge. `install.sh` now prints a loud warning on `--stop`/`--restart`. A plain `--start` is safe (it never stops anything). It was NOT an OOM and NOT install.sh killing the parent — `stop_bridge` only ever `kill`s the bridge PID.

**(b) The orphan-process leak.** `bridge-server.mjs` had no `server.on("error")` handler, so a startup `EADDRINUSE` was swallowed by the catch-all `uncaughtException` (lesson #7) — the process never bound a port and never exited, kept alive forever by the keepalive + gc `setInterval`s. Result: headless zombie servers (we found three ~17 days old). Fixed: `server.on("error")` now `process.exit(1)` on bind failure. And `start_bridge` no longer trusts the PID file alone (it's written only *after* a successful bind) — it polls `/health` and reaps the child if the server never serves. Regression-tested in `test-process-mgmt.sh` (a second server on a busy port must exit, not orphan).

---

## Versioning + manifest approach

`install.sh` reads `VERSION` from `package.json` and writes:
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
5. [ ] `./install.sh --uninstall` then `./install.sh` then `./install.sh --check` — all green
6. [ ] Restart bridge with `./install.sh --restart`, verify health endpoint
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
└── test-process-mgmt.sh          # install.sh --start / --stop / --restart, PID file, idempotency
```

### Rule: every new feature ships with a test

When you add a tool, a hook, a flag, or a server behaviour, add or extend a
test in `tests/`. The discovery is automatic — any file matching
`tests/test-*.{mjs,sh}` is picked up.

- New MCP tool? Add assertions to `tests/test-tools.mjs` using the `bridge.call(...)` helper.
- New install.sh flag? Add a `tests/test-<name>.sh` script that exits 0 on
  success and non-zero on failure. Use port 7404 (or a fresh one) so it
  doesn't collide with other tests.
- New server-level behaviour (shutdown, GC, reconnect)? New `tests/test-<name>.mjs`
  using `TestBridge` from `lib.mjs`.

### Manual smoke (after any change)

```bash
./install.sh --restart
./install.sh --check
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
2. Add an entry to `HOOK_MAP` in `install.sh`
3. The script MUST exit 0 on bridge-down (the install assumes hooks are resilient)
4. The script MUST check `/tmp/claude-bridge-${SESSION_ID}.mcp` and exit silently if "no" — this is the anti-spam pattern
5. Update the hook count in `check_hooks()` (currently expects 5)
6. Update USAGE.md hook configuration reference
7. Extend `tests/test-hook-mcp-check.sh` to cover the new hook's silence/run-clean contract
8. Add a line to `CHANGELOG.md` under `[Unreleased] → Added`

---

## When you change install.sh

1. **Test the full round-trip** — uninstall (with whatever was there), reinstall, check. All steps must succeed cleanly.
2. **Test from a clean state** — `rm -rf` the relevant artifacts, then install.
3. **Test idempotency** — run install twice, verify nothing duplicates.
4. If you create a new file or directory, register it in the manifest (`manifest_add`).
5. Update the "What install.sh modifies" table in USAGE.md.
6. Add or extend `tests/test-process-mgmt.sh` if you change a flag's behaviour.
7. Add a line to `CHANGELOG.md` under `[Unreleased]`.

---

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
- **Don't** add CLI commands to the bridge server itself. All UX lives in `install.sh`.
- **Don't** persist state to disk by default. The in-memory + 30d TTL design is intentional. Add persistence only as opt-in.
- **Don't** make the install script chatty by default. `--check` is for verbose status; `install` should be ~10 lines of output.
- **Don't** rename or move files in `hooks/` without updating settings.json migration logic in install.sh.
- **Don't** edit the user's `~/.claude/CLAUDE.md` for any reason. We learned that lesson.
- **Don't** use external dependencies in `bridge-server.mjs`. Zero deps is a feature.

---

## Files in this repo, ranked by "how often you'll touch them"

| File | Frequency | Notes |
|---|---|---|
| `bridge-server.mjs` | High | Most logic lives here. ~600 lines, single file by design. |
| `install.sh` | Medium | Every new file/dir/hook needs a line here. |
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
./install.sh                      # Install / re-install (idempotent)
./install.sh --uninstall          # Remove everything (manifest + hardcoded fallback)
./install.sh --check              # Status of all components
./install.sh --start              # Start bridge server (writes PID)
./install.sh --stop               # Graceful stop (SIGTERM, sends SSE close event)
./install.sh --restart            # Stop + start

curl -sf localhost:7400/health    # Server health + active session count
tail -f /tmp/claude-bridge-server.log # Server logs
cat /tmp/claude-bridge.pid            # Currently running bridge PID
ls /tmp/claude-bridge-*               # Per-session state files

claude mcp list                   # Verify bridge MCP is registered with Claude Code
claude mcp remove bridge          # Remove the MCP registration (uninstall does this)
```
