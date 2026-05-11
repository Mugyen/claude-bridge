# DEVELOPER.md

Working notes for whoever maintains cc-bridge next — including future-me. This is the file you read **before** changing anything non-trivial.

---

## What this project is, in one paragraph

cc-bridge is a localhost-only message broker that lets multiple Claude sessions (Claude Code CLI + Claude Desktop app) talk to each other in real time. It runs one Node.js server (`bridge-server.mjs`) on port 7400 with two transports: MCP-over-SSE for CLI sessions, and MCP-over-stdio (via `bridge-stdio.mjs` adapter) for the Desktop app. Five shell hooks plug into Claude Code's lifecycle to auto-register sessions, inject pending questions, and clean up on exit. State is in-memory with a 30-day TTL.

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
                                                ├── /tmp/cc-bridge-*  (session name files, MCP cache, stamps, PID)
                                                ├── /tmp/cc-bridge-server.log
                                                └── In-memory state (messages, threads, scratchpads — 30d TTL)

~/.claude/settings.json                       — 5 hooks point to hooks/*.sh
~/.claude/skills/cc-bridge/SKILL.md            — protocol docs (loaded on-demand by Claude)
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
| SessionEnd | Session ends | Clean up `/tmp/cc-bridge-${SESSION_ID}.*` files |

### MCP tool list

`register`, `list_sessions`, `ask`, `reply`, `check_inbox`, `get_thread`, `broadcast`, `read_scratchpad` — 8 tools, defined in `bridge-server.mjs` TOOLS array (lines ~135–230).

---

## Hard-learned lessons (DO NOT redo these)

### 1. `os.tmpdir()` on macOS returns a per-user directory, NOT `/tmp`
`/var/folders/.../T/` — so if the bridge writes its PID there but install.sh reads `/tmp/cc-bridge.pid`, the file is invisible to the script. **Always hardcode `/tmp/cc-bridge.pid`** (and other shared files) so the server, hooks, and install.sh agree.

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
If you install cc-bridge mid-session, hooks fire (settings.json is hot-loaded) but MCP tools aren't available (MCP connects at session start). Hooks now check `/tmp/cc-bridge-${SESSION_ID}.mcp` written by SessionStart — if MCP isn't registered, they exit silently. Otherwise they'd spam every tool call telling the agent to call `register()` when the tool doesn't exist.

### 14. The "MCP installed" check via `claude mcp list` is slow (~1s)
Run it ONCE per session in SessionStart and cache the result. Other hooks just read the cache.

### 15. Uninstall does NOT stop the bridge server
Intentional — the server may have active sessions from other users/contexts. Uninstall removes config files and the PID file, but the running process stays. Users must `./install.sh --stop` explicitly (or `lsof -ti:7400 | xargs kill`). The reinstall path handles this gracefully: `--start` reports failure if port is busy, and you can investigate with `--check`.

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

## Release checklist

Before tagging a release:

1. [ ] Bump `package.json` `version`
2. [ ] Bump version string in `bridge-server.mjs` startup banner
3. [ ] Run `./install.sh --uninstall` then `./install.sh` then `./install.sh --check` — all green
4. [ ] Restart bridge with `./install.sh --restart`, verify health endpoint
5. [ ] Test the broadcast crash repro (see "End-to-end test" below) — must NOT crash
6. [ ] Update README "Status" section if non-trivial new features
7. [ ] Update USAGE.md if any user-facing flag/command changed
8. [ ] Update this DEVELOPER.md if you learned anything new
9. [ ] One squash commit per logical change, descriptive message

---

## How to test changes

### Quick smoke (after any change)

```bash
./install.sh --restart
./install.sh --check
curl -sf http://localhost:7400/health | jq
```

All three must succeed. `--check` should show green for hooks, MCP, skill, Desktop config, and bridge running.

### End-to-end test (after server changes)

Free the test port, then run this Node script — it connects via SSE, calls register(), broadcasts with good and bad inputs, and verifies the server stays alive.

```bash
lsof -ti:7402 | xargs kill 2>/dev/null; sleep 1
CC_BRIDGE_PORT=7402 node bridge-server.mjs &
sleep 2

node --input-type=module -e '
import http from "node:http";
const PORT = 7402;
const responses = new Map();
let sid;
await new Promise((resolve) => {
  http.get(`http://localhost:${PORT}/sse`, (res) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk.toString();
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) {
        const dm = p.match(/^data: (.+)$/m); if (!dm) continue;
        const data = dm[1];
        const sm = data.match(/session=([a-f0-9-]+)/);
        if (sm && !sid) { sid = sm[1]; resolve(); continue; }
        try { const j = JSON.parse(data); if (j.id != null) responses.set(j.id, j); } catch {}
      }
    });
  });
});
let nextId = 1;
async function call(name, args) {
  const id = nextId++;
  const body = JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}});
  await new Promise((res,rej) => {
    const req = http.request(`http://localhost:${PORT}/message?session=${sid}`,{method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},()=>res());
    req.on("error",rej); req.write(body); req.end();
  });
  for (let i=0;i<60;i++) { if (responses.has(id)) return JSON.parse(responses.get(id).result.content[0].text); await new Promise(r => setTimeout(r, 100)); }
  throw new Error("timeout: "+name);
}

// add new tests here as features grow
console.log("register:", (await call("register",{name:"t",description:"t"})).ok ? "PASS" : "FAIL");
console.log("broadcast bad arg:", (await call("broadcast",{message:"x"})).error ? "PASS" : "FAIL");
console.log("broadcast empty:",   (await call("broadcast",{})).error ? "PASS" : "FAIL");
console.log("broadcast good:",    (await call("broadcast",{content:"hi"})).ok ? "PASS" : "FAIL");
console.log("server still up:",   (await fetch(`http://localhost:${PORT}/health`).then(r=>r.json())).status === "ok" ? "PASS" : "FAIL");
process.exit(0);
'

lsof -ti:7402 | xargs kill 2>/dev/null
```

### Graceful shutdown test

```bash
CC_BRIDGE_PORT=7402 node bridge-server.mjs &
SERVER_PID=$!
sleep 1
curl -sf -N --max-time 10 http://localhost:7402/sse > /tmp/sse-test.log 2>&1 &
SSE_PID=$!
sleep 1
kill $SERVER_PID  # SIGTERM
sleep 2
grep "event: close" /tmp/sse-test.log && echo "PASS: close event sent" || echo "FAIL"
```

---

## When you add a new tool

1. Add the schema to `TOOLS` array in `bridge-server.mjs`
2. Add a case to `executeTool` switch
3. **Validate every required arg** — `if (typeof args.X !== "string") return { error: "..." }`. The broadcast crash taught us this.
4. Update the tool table in `USAGE.md` (Required args / Optional args / What it does)
5. Update `skill/SKILL.md` if agents need new instructions for it
6. Add a smoke test to the end-to-end script above

---

## When you add a new hook

1. Add the script to `hooks/`
2. Add an entry to `HOOK_MAP` in `install.sh`
3. The script MUST exit 0 on bridge-down (the install assumes hooks are resilient)
4. The script MUST check `/tmp/cc-bridge-${SESSION_ID}.mcp` and exit silently if "no" — this is the anti-spam pattern
5. Update the hook count in `check_hooks()` (currently expects 5)
6. Update USAGE.md hook configuration reference

---

## When you change install.sh

1. **Test the full round-trip** — uninstall (with whatever was there), reinstall, check. All steps must succeed cleanly.
2. **Test from a clean state** — `rm -rf` the relevant artifacts, then install.
3. **Test idempotency** — run install twice, verify nothing duplicates.
4. If you create a new file or directory, register it in the manifest (`manifest_add`).
5. Update the "What install.sh modifies" table in USAGE.md.

---

## Frequent TODOs (work that's perpetually almost-worth-doing)

- [ ] **Bridge logs**: rotate `/tmp/cc-bridge-server.log` — currently grows unbounded.
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
| `DEVELOPER.md` | Medium | Update when you learn something. THAT'S THIS FILE. |
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
tail -f /tmp/cc-bridge-server.log # Server logs
cat /tmp/cc-bridge.pid            # Currently running bridge PID
ls /tmp/cc-bridge-*               # Per-session state files

claude mcp list                   # Verify bridge MCP is registered with Claude Code
claude mcp remove bridge          # Remove the MCP registration (uninstall does this)
```
