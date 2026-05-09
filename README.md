# cc-bridge

**Real-time Q&A between Claude Code sessions -- no copy-paste, no context switching, no human message routing.**

```
You (to Session A):  "Ask the frontend session what auth flow they're using"
You (to Session B):  "Build the login page"

                     ── meanwhile, behind the scenes ──

Session A:  ask(to="frontend", question="What auth flow are you implementing?
            I need to match the API middleware to your token format.")

Session B:  [sees bridge question, replies with JWT config, file paths, reasoning]

Session A:  [unblocks, continues with the exact config — you never touched it]
```

Two sessions. One question. Zero human involvement.

---

## ✨ What this is

- :bridge_at_night: **MCP server** that lets Claude Code sessions talk to each other via blocking ask/reply
- :robot: **Fully automatic** -- sessions register themselves, discover peers, and answer each other's questions
- :hook: **Hook-driven** -- 5 lifecycle hooks handle registration, question delivery, and cleanup without human intervention
- :thread: **Thread history with deduplication** -- agents build on prior answers, never re-ask the same question
- :mega: **Scratchpad broadcasting** -- agents share decisions and constraints proactively
- :adhesive_bandage: **Self-healing** -- dropped connections trigger automatic re-registration
- :package: **Zero dependencies** -- pure Node.js stdlib, no npm install needed

## ❌ What this isn't

- :no_entry_sign: Not a multi-machine or networked solution (localhost only)
- :no_entry_sign: Not persistent storage (in-memory, 30-day GC, lost on server restart)
- :no_entry_sign: Not a general MCP server framework
- :no_entry_sign: Not a message queue or pub/sub system
- :no_entry_sign: Not a replacement for shared files/git for large artifacts
- :no_entry_sign: Not Windows-compatible (uses /tmp, bash hooks)

## :muscle: Why this exists

You're running 2-5 Claude Code agents on the same codebase. They make conflicting decisions. They duplicate work. One blocks on a question only another can answer. You become the human message router -- copy-pasting between terminals, losing your own train of thought.

| Alternative | Limitation |
|---|---|
| Copy-paste between terminals | You become the bottleneck, context gets lost in translation |
| Shared CLAUDE.md file | Async only, no blocking Q&A, agents don't see updates mid-turn |
| Git commits as messages | Too slow, requires commit-push-pull per question |
| Worktrees with shared notes | No interruption mechanism, idle sessions never see updates |
| Custom scripts + file watchers | No blocking semantics, no thread history, no dedup |

I wanted my agents to talk to each other without me in the loop. So I built it.

## :busts_in_silhouette: Who this is for

### ✅ Use this if you:
- Run 2+ Claude Code sessions simultaneously on the same machine
- Want your agents to coordinate without you relaying messages
- Work on multi-component projects where one agent's decisions affect another
- Want blocking Q&A -- the asking agent waits for a real answer, not a stale file

### ❌ Don't use this if you:
- Only ever run one Claude Code session at a time
- Need cross-machine or team-wide collaboration
- Want persistent message history across server restarts
- Need Windows support

## :wrench: Tech stack

| Layer | Tech |
|---|---|
| Runtime | Node.js >= 18 |
| Server transport | MCP over SSE + HTTP REST |
| Hook integration | Bash (jq + curl) |
| IPC | /tmp files (name files, stamp files) |
| Dependencies | None (Node.js stdlib only) |
| State | In-memory (30-day GC) |

## :warning: Requirements

| Requirement | Why | How to verify |
|---|---|---|
| Node.js >= 18 | Uses `node:` imports, `crypto.randomUUID` | `node -e "console.log(process.version)"` |
| jq | Hook scripts parse JSON | `jq --version` |
| curl | Hook scripts call bridge endpoints | `curl --version` |
| Claude Code CLI | Hooks + MCP registration | `claude --version` |
| macOS or Linux | Uses /tmp for IPC, bash for hooks | `uname` |

## :brain: How it works under the hood

### Big picture

```
Session A (Claude Code)        cc-bridge (:7400)           Session B (Claude Code)
───────────────────────        ─────────────────           ───────────────────────

SessionStart hook ──────────→  (bridge running)  ←──────── SessionStart hook
  auto-registers                  MCP over SSE       auto-registers

You: "build the API"           7 MCP tools:            You: "build the frontend"
Agent works, calls tools       register, ask,          Agent works, calls tools
                               reply, list_sessions,
                               get_thread, broadcast,
                               read_scratchpad

ask(to="B", question) ──────→ queue question ──────────→ PostToolUse hook fires
  (blocks, waiting)            messages Map              sees question, injects
                               ┌──────────┐              into agent's context
                               │ question │
                               │ (no ans) │
                               └──────────┘
                                                         B reads Q, calls reply()
                               ┌──────────┐
                               │ question │  ←────────── reply(id, answer)
                               │ answer ✓ │
                               └──────────┘
  ←──── answer returned ──────
  (continues work)

If B is going idle:            Stop hook ───────────────→ blocks idle, re-injects Q
                               {"decision":"block"}       B wakes up, answers
```

### In one paragraph

cc-bridge runs a single Node.js HTTP server speaking two protocols. MCP over SSE provides tools (ask, reply, register, broadcast) that agents call directly. Plain HTTP REST serves bash hook scripts that handle auto-registration and question delivery. When agent A calls `ask()`, the server queues the question and blocks A's tool call for up to 5 minutes. B's hooks discover the question and inject it into B's context. B calls `reply()`, which unblocks A instantly.

### Why this architecture works

- **Single server, two protocols** -- bash hooks can't speak MCP, so they use REST. Both read/write the same in-memory state.
- **Blocking `ask()` with server-side long-poll** -- the asking agent's tool call simply doesn't return until the answer arrives.
- **Stop hook catches the idle gap** -- fires right before an agent goes idle, covering ~95% of delivery cases.
- **In-memory state with 30-day GC** -- no persistence layer to manage, no database dependency.
- **25s SSE keepalive pings** -- prevents Claude Code's MCP client from dropping idle connections.

## :book: More

- **[USAGE.md](USAGE.md)** -- setup (what you do vs what to tell your agent), troubleshooting
- **[BRIDGE.md](BRIDGE.md)** -- protocol docs (what the agent reads to know how to use the bridge)
- **[LICENSE](LICENSE)** -- MIT

## :construction: Status

Works. Built and battle-tested across 2-5 concurrent sessions daily. macOS primary, Linux should work (untested). In-memory only -- server restart loses state. PRs welcome.
