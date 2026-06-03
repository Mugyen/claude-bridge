# claude-bridge

**Let any two Claude sessions — CLI or the Desktop app — talk to each other in real time.** No more copy-pasting between windows: sessions ask and answer each other's questions automatically, no hand-holding. Same machine or across the network.

`⚡ zero deps` · `🔒 localhost-first` · `🧩 MCP-based` · `🪝 skill + hooks`

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

- ✅ **A shared inbox for your agents** — any session messages any other by name and gets a real answer back, live
- ✅ **Three ways to talk** — `ask` blocks for an answer, `notify` sends a one-way heads-up, `broadcast` shares a scratchpad others read on their own time
- ✅ **Across machines, not just terminals** — link laptops over a secure tunnel and address a remote agent as `name@node`; opt-in, and survives link drops
- ✅ **Automatic on CLI, simple on Desktop** — CLI sessions register and answer on their own; Desktop (Chat/Cowork/Code) joins the same bridge with a quick prompt
- ✅ **Answers arrive even when idle** — a waiting session wakes on a new question, at zero token cost until one lands
- ✅ **Zero dependencies** — pure Node.js, nothing to install

## ❌ What this isn't

- 🚫 **Not encrypted end-to-end** — cross-network is TLS-in-transit + a shared token, for a *trusted* group. Not a VPN.
- 🚫 **Not durable** — in-memory only; a server restart clears messages, threads, and scratchpads.
- 🚫 **Not a general framework** — it's Claude-to-Claude ask/reply, not a message queue, pub/sub, or large-file channel. macOS/Linux only (Windows via WSL).

## :busts_in_silhouette: Who this is for

**✅ Use it** if you run 2+ Claude sessions — yours or a teammate's, same machine or across the network — and want them to answer each other without you relaying messages.

**❌ Skip it** if you only ever run one session, need durable history or an end-to-end-encrypted channel for an untrusted group, or are on native Windows.

## :warning: Requirements

| Requirement | Verify |
|---|---|
| Node.js >= 18 | `node -e "console.log(process.version)"` |
| Claude Code CLI | `claude --version` |

macOS or Linux. Built on Node.js stdlib + bash hooks (`jq`/`curl`, standard on both) — zero npm dependencies.

## :brain: How it works under the hood

### Big picture

```
LOCAL — every session connects to its own machine's bridge
──────────────────────────────────────────────────────────
  CLI session A ┐
  CLI session B ┤──►   bridge :7400   ◄──  Desktop (Chat/Cowork/Code)
  (auto-register│      • shared inbox  ← questions land here
   via hooks)   │      • thread history + scratchpads
                └───   ask · reply · notify — all by name


CROSS-NETWORK — bridges link hub-and-spoke over a secure tunnel (opt-in)
────────────────────────────────────────────────────────────────────────
      YOUR MACHINE  (hub)                      TEAMMATE  (spoke)
   ┌──────────────────────┐                ┌──────────────────────┐
   │ sessions ─► :7400     │                │ sessions ─► :7400     │
   │              │        │                │        │              │
   │           fed :7401 ●─┼── secure tunnel ┼─● join │              │
   └──────────────────────┘   (only :7401   └──────────────────────┘
                               is exposed)
   rosters merge ─► a session on either machine can ask  name@node
                    (more spokes can join the same hub)
```

### In one paragraph

claude-bridge is one small Node.js server. CLI sessions connect to it automatically — five lifecycle hooks register them and deliver incoming questions — while the Desktop app connects through a tiny adapter and checks its inbox on request. Everyone shares the same inbox, threads, and scratchpads. Link two machines and a second bridge joins over a secure tunnel: a remote agent is just another name in the roster (`name@node`), reached with the exact same `ask`/`reply`. The link is opt-in, and if it drops, local coordination keeps working and queued cross-network messages deliver on reconnect.

### Why this architecture works

- **One bridge, two ways in** -- CLI connects directly, Desktop through an adapter. Both share the same state.
- **`ask` really blocks** -- the call doesn't return until a real answer lands, so the agent acts on the answer, not a guess.
- **Idle sessions still hear you** -- a background listener wakes a quiet session the moment a question arrives, at zero token cost until then.
- **Cross-machine, but your sessions stay private** -- only a separate link port is ever exposed through the tunnel; your `:7400` bridge and its sessions never leave localhost.
- **No database to run** -- state lives in memory with a 30-day cleanup; nothing to provision or back up.

## :wave: For early users — the whole thing in four points

1. **How agents talk** — they auto-register on the bridge, each session is one entity on the bridge (an MCP server; CLI wires it up via hooks), then message one another one at a time. One asks, the other replies — like texting, but the history is kept. The whole protocol is three verbs: **ASK**, **REPLY**, and **NOTIFY** (one-way).
2. **The armed listener** — each active agent arms a ~25s polling listener (or you prompt it to), so it answers other sessions even while sitting idle — at zero token cost until a message lands.
3. **Batteries included** — scratchpad/broadcast, an inbox where questions land, skills (install · debug · report), the lifecycle hooks, and the `claude-bridge` CLI all ship natively with the project.
4. **Cross-network is a layer on top** — start a **hub** (a secure tunnel); other devices' bridges **join** it, and every session on every joined device becomes visible and addressable as `name@node`.

**Platforms:** :apple: macOS works fully (CLI + Desktop). :penguin: Linux works for the CLI path (no Linux Desktop app from Anthropic yet). :window: Windows: use WSL and follow the Linux path.

## :book: More

- **[USAGE.md](USAGE.md)** — setup, every CLI command, troubleshooting
- **[docs/CROSS-NETWORK.md](docs/CROSS-NETWORK.md)** — step-by-step guide to linking machines (hub/spoke)
- **[BRIDGE.md](BRIDGE.md)** — protocol docs (what the agent reads to use the bridge)
- **[LICENSE](LICENSE)** — MIT

## :muscle: Why this exists

I kept wanting my agents to just answer each other, and wanted agent-to-agent coordination to be real — not a thesis. So I shipped it myself: a version that actually works.

## :construction: Status

Works. Used daily across a handful of concurrent sessions (CLI + Desktop). macOS primary, Linux for the CLI path. In-memory only — a restart clears state. PRs welcome.

**Found it useful? Hit a bug? Have an idea?** Open an issue or just DM me. Early-user feedback is exactly what shapes whether this grows or stays where it is.
