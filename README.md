# claude-bridge

**Real-time Q&A between Claude sessions -- CLI agents, Desktop app, and Cowork -- no copy-paste, no context switching, no human message routing.**

![Two Claude sessions chatting via the bridge — left session thanks the right session for the help, right session takes a victory lap](docs/demo.jpg)

*Two real Claude sessions (Desktop on the left, CLI on the right) talking to each other through the bridge. No human in the loop for the routing.*

🌐 **Live site:** [vijay2411.github.io/claude-bridge](https://vijay2411.github.io/claude-bridge/)

📦 **Install in one line:**

```bash
curl -fsSL https://vijay2411.github.io/claude-bridge/claude-bridge | bash
```

Lands the bridge in `~/.local/share/claude-bridge` and configures hooks, MCP, and the skill automatically.

```
You (to CLI Session A):     "Ask the frontend session what auth flow they're using"
You (to CLI Session B):     "Build the login page"
You (to Desktop Chat):      "Check the bridge, see if anyone needs help"

                     ── meanwhile, behind the scenes ──

Session A:  ask(to="frontend", question="What auth flow are you implementing?
            I need to match the API middleware to your token format.")

Session B:  [sees bridge question, replies with JWT config, file paths, reasoning]

Desktop:   [calls check_inbox(), sees a question from Session A, replies]

Session A:  [unblocks, continues with the exact config — you never touched it]
```

Multiple agents. One bridge. Zero human involvement.

---

## ✨ What this is

- :bridge_at_night: **MCP server** that lets Claude sessions talk to each other — blocking ask/reply, one-way notices, and shared scratchpads
- :robot: **Fully automatic on CLI** -- sessions register themselves, discover peers, and answer each other's questions
- :computer: **Claude Desktop app support** -- Chat, Cowork, and Code tabs can join the bridge via stdio adapter
- :hook: **Hook-driven** -- 5 lifecycle hooks handle registration, question delivery, and cleanup on CLI
- :thread: **Thread history with deduplication** -- agents build on prior answers, never re-ask the same question
- :mega: **Scratchpad broadcasting** -- agents share decisions and constraints proactively
- :adhesive_bandage: **Self-healing** -- dropped connections trigger automatic re-registration
- :globe_with_meridians: **Optional cross-network linking** -- `--share`/`--join` links bridges on different machines over a Cloudflare tunnel; agents talk by name across machines, and local coordination survives a link drop
- :package: **Zero dependencies** -- pure Node.js stdlib, no npm install needed

## ❌ What this isn't

- :no_entry_sign: Not a VPN or end-to-end-encrypted channel -- cross-network is TLS-in-transit + a shared token, for a *trusted* group (Cloudflare terminates TLS)
- :no_entry_sign: Not persistent storage (in-memory, 30-day GC, lost on server restart)
- :no_entry_sign: Not a general MCP server framework
- :no_entry_sign: Not a message queue or pub/sub system
- :no_entry_sign: Not a replacement for shared files/git for large artifacts
- :no_entry_sign: Not Windows-compatible (uses /tmp, bash hooks)

## :muscle: Why this exists

You're running 2-5 Claude agents on the same codebase -- some in CLI, maybe one in the Desktop app. They make conflicting decisions. They duplicate work. One blocks on a question only another can answer. You become the human message router -- copy-pasting between terminals and chat windows, losing your own train of thought.

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
- Run 2+ Claude sessions simultaneously on the same machine (CLI, Desktop, or both)
- Want your agents to coordinate without you relaying messages
- Work on multi-component projects where one agent's decisions affect another
- Want blocking Q&A -- the asking agent waits for a real answer, not a stale file

### ❌ Don't use this if you:
- Only ever run one Claude session at a time
- Need a VPN-grade / end-to-end-encrypted channel for an untrusted group (cross-network is TLS-in-transit + a shared token)
- Want persistent message history across server restarts
- Need Windows support

## :wrench: Tech stack

| Layer | Tech |
|---|---|
| Runtime | Node.js >= 18 |
| Server transport | MCP over SSE (CLI) + stdio adapter (Desktop app) |
| Hook integration | Bash (jq + curl) -- CLI only |
| IPC | /tmp files (name files, stamp files) |
| Dependencies | None (Node.js stdlib only) |
| State | In-memory (30-day GC) |

## :warning: Requirements

| Requirement | Why | How to verify |
|---|---|---|
| Node.js >= 18 | Uses `node:` imports, `crypto.randomUUID` | `node -e "console.log(process.version)"` |
| jq | Hook scripts parse JSON (CLI only) | `jq --version` |
| curl | Hook scripts call bridge endpoints (CLI only) | `curl --version` |
| Claude Code CLI | Hooks + MCP registration (CLI setup) | `claude --version` |
| macOS or Linux | Uses /tmp for IPC, bash for hooks | `uname` |

## :brain: How it works under the hood

### Big picture

```
Claude Code CLI (A)            claude-bridge (:7400)       Claude Code CLI (B)
───────────────────            ─────────────────           ───────────────────
SessionStart hook ──────────→        MCP          ←──────── SessionStart hook
  auto-registers              over SSE (:7400/sse)           auto-registers

ask(to="B", question) ──────→ queue question ──────────→ PostToolUse hook
  (blocks, waiting)            messages Map              sees Q, injects context
                                                         B calls reply()
  ←──── answer returned ──────                           (auto or with ID)

                               ┌─────────────────┐
Claude Desktop App ────────────│  stdio adapter   │─── proxies to SSE ───→
  (Chat / Cowork / Code)       │ bridge-stdio.mjs │
  manual register + inbox      └─────────────────┘
```

### In one paragraph

claude-bridge runs a single Node.js HTTP server speaking MCP over SSE. Claude Code CLI sessions connect directly via SSE and get automatic registration/question delivery through 5 lifecycle hooks. The Claude Desktop app connects through a stdio adapter (`bridge-stdio.mjs`) that proxies MCP tool calls to the same bridge server. Desktop sessions have the same tools but no hooks -- they register manually and check their inbox on request. All sessions share the same bridge state: messages, threads, and scratchpads.

### Why this architecture works

- **Single server, two transports** -- CLI uses SSE directly, Desktop uses stdio-to-SSE adapter. Both hit the same bridge.
- **Blocking `ask()` with server-side long-poll** -- the asking agent's tool call doesn't return until the answer arrives.
- **Stop hook catches the idle gap** -- fires right before a CLI agent goes idle, covering ~95% of delivery cases.
- **`check_inbox()` for hookless clients** -- Desktop sessions (no hooks) can poll for questions in one call instead of checking every thread.
- **In-memory state with 30-day GC** -- no persistence layer to manage, no database dependency.

## :book: More

- **[USAGE.md](USAGE.md)** -- setup for CLI and Desktop app, troubleshooting
- **[docs/CROSS-NETWORK.md](docs/CROSS-NETWORK.md)** -- step-by-step guide to linking machines (hub/spoke, exact getting-started steps)
- **[BRIDGE.md](BRIDGE.md)** -- protocol docs (what the agent reads to know how to use the bridge)
- **[LICENSE](LICENSE)** -- MIT

## :construction: Status

Works. Used daily across 2-5 concurrent sessions (CLI + Desktop app). macOS primary, Linux should work (untested). In-memory only -- server restart loses state. PRs welcome.

## :wave: For early users — read this before you try it

Genuinely glad you're checking this out. It's a small thing I built for myself, putting it out in case it helps someone else. **Two honest caveats to set expectations:**

1. :arrows_counterclockwise: **Three ways to talk — pick the right one.** `ask` blocks until you get an answer; `notify` pushes a one-way FYI that expects no reply; `broadcast` writes a scratchpad others pull on their own time. (Early versions were ask/pull-only — one-way push via `notify` landed in v2.6.)

2. :sleeping: **Idle sessions are handled on CLI now.** A session that's been active auto-arms a background listener, so it can answer questions *and* receive notices even while sitting at a blinking cursor — at zero token cost while its inbox is empty. The old manual fix (send it any message, even `.`) still works as a fallback. Desktop has no hooks or listener, so Desktop sessions still check their inbox on request.

**Platforms:** :apple: macOS works fully (CLI + Desktop). :penguin: Linux works for the CLI path (no Linux Desktop app exists yet from Anthropic). :window: Windows: use WSL and follow the Linux path -- native Windows isn't supported and would be a separate effort.

**Found it useful? Hit a bug? Have an idea?** Open an issue or just DM me. Early-user feedback is exactly what shapes whether this grows or stays where it is.
