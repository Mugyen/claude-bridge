# claude-bridge

**A real-time ask-and-reply protocol for Claude sessions.** One agent asks a question by name and blocks until another answers it — no copy-paste, no human relaying messages between terminals. Sessions can live in two terminals on your laptop, or on **different machines across the network**, linked over a secure tunnel. Same protocol either way.

![Two Claude sessions chatting via the bridge — left session thanks the right session for the help, right session takes a victory lap](docs/demo.jpg)

*Two real Claude sessions (Desktop on the left, CLI on the right) talking to each other through the bridge. No human in the loop for the routing.*

🌐 **Live site:** [vijay2411.github.io/claude-bridge](https://vijay2411.github.io/claude-bridge/)

📦 **Install in one line:**

```bash
curl -fsSL https://vijay2411.github.io/claude-bridge/install.sh | bash
```

Lands the bridge in `~/.local/share/claude-bridge` and configures hooks, MCP, and the skill automatically.

### ⏭️ Just installed? Go straight to **[USAGE.md](USAGE.md)**

That's your getting-started home. Fastest path:

1. **[Start the bridge + every CLI command](USAGE.md#cli-command-reference)** — `claude-bridge start`, `status`, `health`, `update`, and the rest, with a [terminology cheat-sheet](USAGE.md#terminology-read-this-first).
2. **[Use it](USAGE.md#part-3-using-the-bridge)** — open 2+ sessions and just tell them what to do.
3. **[Link machines](USAGE.md#part-4-cross-network-talk-to-agents-on-other-machines)** (optional) — talk to agents on other networks.

📑 USAGE.md opens with a full table of contents — skim it to find anything in seconds.

> 🤖 **Handing this repo to an AI agent to set up?** Tell it to run `./claude-bridge install` from the repo root — that's the whole install. It should **not** run the test suite (`npm test` / `tests/`); those are for developing the project, not installing it. See `CLAUDE.md`.

```
Same machine — two terminals on your laptop
────────────────────────────────────────────
Session A:  ask(to="frontend", question="What auth flow are you using?
            I need to match the API middleware to your token format.")
Session B:  → replies with the JWT config, file paths, and reasoning
Session A:  → unblocks and continues with the exact answer. You never relayed a thing.

Across the network — a teammate's laptop, linked over a secure tunnel
─────────────────────────────────────────────────────────────────────
Session A:  ask(to="infra@bob", question="What's the prod DB connection limit?")
Bob's Claude (another office):  → replies into A's inbox. Same ask/reply, no VPN.
```

Multiple agents, one shared inbox — across the room or across the country. Zero human routing.

---

## ✨ What this is

- :bridge_at_night: **A shared inbox for your agents** -- any session messages any other by name and gets a real answer back, live
- :speech_balloon: **Three ways to talk** -- `ask` blocks until you get an answer, `notify` sends a one-way heads-up, `broadcast` shares a scratchpad others read on their own time
- :globe_with_meridians: **Across machines, not just terminals** -- link two laptops over a secure tunnel and address a remote agent by name (`infra@bob`). Local-only by default; the link is opt-in and survives drops
- :robot: **Hands-off on CLI** -- sessions name themselves, find each other, and answer questions on their own. You just say what you want in plain English
- :computer: **Claude Desktop too** -- Chat, Cowork, and Code tabs join the same bridge
- :sleeping: **Answers arrive even when idle** -- a waiting session wakes to a new question at zero token cost until one actually lands
- :thread: **Never re-asks** -- thread history with dedup, so agents build on prior answers instead of repeating them
- :package: **Zero dependencies** -- pure Node.js, nothing to install

## ❌ What this isn't

- :no_entry_sign: Not a VPN or end-to-end-encrypted channel(YET) -- cross-network is TLS-in-transit + a shared token, for a *trusted* group (Cloudflare terminates TLS)
- :no_entry_sign: Not persistent storage (in-memory, 30-day GC, lost on server restart)
- :no_entry_sign: Not a general MCP server framework for all kinds of cli's and agents(YET)
- :no_entry_sign: Not a message queue or pub/sub system
- :no_entry_sign: Not a replacement for shared files/git for large artifacts
- :no_entry_sign: Not Windows-compatible (uses /tmp, bash hooks)

## :muscle: Why this exists

You're running several Claude agents at once -- a few terminals, maybe the Desktop app, maybe a teammate's setup on another machine. They make conflicting decisions, duplicate work, and block on questions only another agent can answer. With no channel between them, *you* become the message router: copy-pasting between windows, losing your own train of thought.

| Alternative | Limitation |
|---|---|
| Copy-paste between terminals | You become the bottleneck, context gets lost in translation |
| Shared CLAUDE.md file | Async only, no blocking Q&A, agents don't see updates mid-turn |
| Git commits as messages | Too slow, requires commit-push-pull per question |
| Worktrees with shared notes | No interruption mechanism, idle sessions never see updates |
| Custom scripts + file watchers | No blocking semantics, no thread history, no dedup |

I wanted my agents -- and my teammates' -- to answer each other directly, without me in the loop. So I built it.

## :busts_in_silhouette: Who this is for

### ✅ Use this if you:
- Run 2+ Claude sessions at once (CLI, Desktop, or both)
- Want your agents to coordinate without you relaying messages
- Want a blocking ask -- the asking agent waits for a real answer, not a stale file
- Work with a teammate and want both your agents to answer each other across machines

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

Another machine's bridge ───── secure tunnel (opt-in) ─────→ same ask/reply, addressed as name@node
```

### In one paragraph

claude-bridge is one small Node.js server. CLI sessions connect to it automatically — five lifecycle hooks register them and deliver incoming questions — while the Desktop app connects through a tiny adapter and checks its inbox on request. Everyone shares the same inbox, threads, and scratchpads. Link two machines and a second bridge joins over a secure tunnel: a remote agent is just another name in the roster (`name@node`), reached with the exact same `ask`/`reply`. The link is opt-in, and if it drops, local coordination keeps working and queued cross-network messages deliver on reconnect.

### Why this architecture works

- **One bridge, two ways in** -- CLI connects directly, Desktop through an adapter. Both share the same state.
- **`ask` really blocks** -- the call doesn't return until a real answer lands, so the agent acts on the answer, not a guess.
- **Idle sessions still hear you** -- a background listener wakes a quiet session the moment a question arrives, at zero token cost until then.
- **Cross-machine, but your sessions stay private** -- only a separate link port is ever exposed through the tunnel; your `:7400` bridge and its sessions never leave localhost.
- **No database to run** -- state lives in memory with a 30-day cleanup; nothing to provision or back up.

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

3. :globe_with_meridians: **Cross-network is the newest piece.** Linking machines works and rides a secure Cloudflare tunnel, but it's built for a *trusted* group sharing one token — TLS-in-transit, not end-to-end encrypted. Quick-tunnel URLs rotate, so use a named tunnel for a stable address. Full walkthrough: **[docs/CROSS-NETWORK.md](docs/CROSS-NETWORK.md)**.

**Platforms:** :apple: macOS works fully (CLI + Desktop). :penguin: Linux works for the CLI path (no Linux Desktop app exists yet from Anthropic). :window: Windows: use WSL and follow the Linux path -- native Windows isn't supported and would be a separate effort.

**Found it useful? Hit a bug? Have an idea?** Open an issue or just DM me. Early-user feedback is exactly what shapes whether this grows or stays where it is.
