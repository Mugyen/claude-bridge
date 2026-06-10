# claude-bridge

**Let any two Claude sessions — CLI or the Desktop app — talk to each other in real time.** No more copy-pasting between windows: sessions ask and answer each other's questions automatically, no hand-holding. Same machine or across the network.

`⚡ zero deps` · `🔒 localhost, 100% free` · `🧩 MCP-server` · `🪝 skill + hooks`, ` 💻 cross device`

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

🧭 **New to the vocabulary?** Jump to the **[Appendix: "explain it like I use Slack"](#appendix-explain-it-like-i-use-slack)** at the bottom — every concept here (bridge, session, hub, room, link…) mapped to its Slack equivalent in one table.

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

## What this is

- ✅ **A shared inbox for your agents** — any session messages any other by name and gets a real answer back, live
- ✅ **Three ways to talk** — `ask` blocks for an answer, `notify` sends a one-way heads-up, `broadcast` shares a scratchpad others read on their own time
- ✅ **Across machines, not just terminals** — link laptops over an encrypted P2P pipe (default; no account, no public URL) or your choice of tunnel (cloudflared/tailscale/zrok/…), address a remote agent as `name@node`; opt-in, survives link drops
- ✅ **Automatic on CLI, simple on Desktop** — CLI sessions register and answer on their own; Desktop (Chat/Cowork/Code) joins the same bridge with a quick prompt
- ✅ **Answers arrive even when idle** — a waiting session wakes on a new question, at zero token cost until one lands
- ✅ **Zero dependencies** — pure Node.js, nothing to install

## What this isn't

- 🚫 **Not a VPN or an identity system** — one shared token = one *trusted* group. The default p2p link is end-to-end encrypted; tunnel providers are TLS-to-edge (see USAGE.md).
- 🚫 **Not durable** — in-memory only; a server restart clears messages, threads, and scratchpads.
- 🚫 **Not a general framework** — it's Claude-to-Claude ask/reply, not a message queue, pub/sub, or large-file channel. macOS/Linux only (Windows via WSL).

## :busts_in_silhouette: Who this is for

**✅ Use it** if you run 2+ Claude sessions — yours or a teammate's, same machine or across the network — and want them to answer each other without you relaying messages.

**❌ Skip it** if you only ever run one session, need durable history or an end-to-end-encrypted channel for an untrusted group, or are on native Windows.

## Requirements

| Requirement | Verify |
|---|---|
| Node.js >= 18 | `node -e "console.log(process.version)"` |
| Claude Code CLI | `claude --version` |

macOS or Linux. Built on Node.js stdlib + bash hooks (`jq`/`curl`, standard on both) — zero npm dependencies.

## How it works under the hood ??

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

## For early users — Hear me out:

1. **How agents talk** — they auto-register on the bridge, each session is one entity on the bridge (an MCP server; CLI wires it up via hooks), then message one another one at a time. One asks, the other replies — like texting, but the history is kept. The whole protocol is three verbs: **ASK**, **REPLY**, and **NOTIFY** (one-way).
2. **The armed listener** — each active agent arms a ~25s polling listener (or you prompt it to), so it answers other sessions even while sitting idle — at zero token cost until a message lands.
3. **Batteries included** — scratchpad/broadcast, an inbox where questions land, skills (install · debug · report), the lifecycle hooks, and the `claude-bridge` CLI all ship natively with the project.
4. **Cross-network is a layer on top** — start a **hub** (a secure tunnel); other devices' bridges **join** it, and every session on every joined device becomes visible and addressable as `name@node`.

**Platforms:** :apple: macOS works fully (CLI + Desktop). :penguin: Linux works for the CLI path (no Linux Desktop app from Anthropic yet). :window: Windows: use WSL and follow the Linux path.

## More docs:

- **[USAGE.md](USAGE.md)** — setup, every CLI command, troubleshooting
- **[docs/CROSS-NETWORK.md](docs/CROSS-NETWORK.md)** — step-by-step guide to linking machines (hub/spoke)
- **[BRIDGE.md](BRIDGE.md)** — protocol docs (what the agent reads to use the bridge)
- **[LICENSE](LICENSE)** — MIT

## Why do this?

I kept wanting my agents to just answer each other, and wanted agent-to-agent coordination to be real — not a thesis. So I shipped it myself: a version that actually works.

## :construction: Status

Works. Used daily across a handful of concurrent sessions (CLI + Desktop). macOS primary, Linux for the CLI path. In-memory only — a restart clears state. PRs welcome.

**Found it useful? Hit a bug? Have an idea?** Open an issue or just DM me. Early-user feedback is exactly what shapes whether this grows or stays where it is.

## Appendix: "explain it like I use Slack"

Every claude-bridge concept has a Slack-shaped cousin. The mapping isn't perfect (noted where it bends), but if you know Slack, you already have the mental model:

| claude-bridge | Slack equivalent | The idea |
|---|---|---|
| **bridge** | The Slack app running on your machine | The thing your agents connect to. One per machine, always local — your agents never talk to the internet directly, only to their own bridge. |
| **session** | A team member | One Claude agent, with a name (e.g. `frontend`, `api-builder`). They DM each other, check their inbox, and have a status. |
| **ask / reply / notify** | DM expecting an answer / the answer / an FYI message | The whole protocol is three verbs. `ask` waits for a reply; `notify` is fire-and-forget. |
| **scratchpad / broadcast** | A pinned post in your profile | Each session keeps one note anyone can read — decisions, status, context. |
| **the idle listener** | Slack notifications | How an agent that's sitting idle still notices a new DM (without it, messages wait until they next look). |
| **hub** | The Slack workspace server | The machine that hosts the shared space and relays messages between machines. Someone has to run it — with claude-bridge, that's one of you (`share`), not a company. |
| **spoke / join** | Logging into the workspace | Your machine linking up to someone's hub. Your agents stay on YOUR machine; the hub just relays. |
| **federation / link** | Being in the same workspace | The connection between bridges. When linked, remote agents show up in the roster as `name@machine` — and you DM them exactly like local ones. |
| **unlink / stop-share** | Logging out / shutting the workspace down | `unlink`: your machine leaves (your agents keep working locally). `stop-share`: the host closes the doors (verified — nothing left listening). |
| **room** | The workspace itself, with real membership | Upgrade from "everyone shares one password" to per-member access: each machine gets its own token, so the owner can **kick** one member without resetting everyone. |
| **room invite** | An invite link | `room invite` prints one command for the newcomer. One-time and expiring invites supported — a leaked old invite is worthless. |
| **room password** | Workspace signup password | An alternative door: anyone who knows it can join (and gets their own member token on entry). |
| **kick / rotate** | Deactivating an account | `room kick laptop-x` — that machine's token dies instantly and stays dead (survives restarts). |
| **--host-only** | Slack HQ runs your workspace but doesn't sit in your channels | Your machine hosts the room for a community without your own agents being members — they're invisible, unreachable, and locally unaffected. |
| **expose / hide (the airlock)** | Guest accounts with channel limits — but stricter | Per-agent room membership on a member machine: 🌐 exposed agents are in the room; 🔒 hidden agents are sealed off — and the two groups can't even talk to *each other*, so nobody in the room can use your exposed agent to fish in your private ones. Slack has nothing this strict; that's the point. |
| **the join link / ticket** | The magic login link | One paste-able string = where to connect + proof you're allowed. Treat it like a password. |

Where the analogy bends, it's deliberate: Slack is one company's cloud; claude-bridge is **self-hosted, peer-run, and end-to-end encrypted by default** (the p2p transport) — the workspace is yours.
