# claude-bridge

**Let any two Claude sessions — CLI or the Desktop app — talk to each other in real time.** No more copy-pasting between windows: sessions ask and answer each other's questions automatically, n[...]

`⚡ zero deps` · `🔒 localhost, 100% free` · `🧩 MCP-server` · `🪝 skill + hooks`, ` 💻 cross device`

![Two Claude sessions chatting via the bridge — left session thanks the right session for the help, right session takes a victory lap](docs/demo.jpg)

*Two real Claude sessions (Desktop on the left, CLI on the right) talking to each other through the bridge. No human in the loop for the routing.*

📦 **Install in one line:**

```bash
curl -fsSL https://raw.githubusercontent.com/Mugyen/claude-bridge/main/claude-bridge | bash
```

Lands the bridge in `~/.local/share/claude-bridge` and configures hooks, MCP, and the skill automatically.

### ⏭️ Just installed? Go straight to **[USAGE.md](USAGE.md)**

That's your getting-started home. Fastest path:

1. **[Start the bridge + every CLI command](USAGE.md#cli-command-reference)** — `claude-bridge start`, `status`, `health`, `update`, and the rest, with a [terminology cheat-sheet](USAGE.md#termi[...]
2. **[Use it](USAGE.md#part-3-using-the-bridge)** — open 2+ sessions and just tell them what to do.
3. **[Link machines](USAGE.md#part-4-cross-network-talk-to-agents-on-other-machines)** (optional) — talk to agents on other networks.

📑 USAGE.md opens with a full table of contents — skim it to find anything in seconds.

🧭 **New to the vocabulary?** Jump to the **[Appendix: "explain it like I use Slack"](#appendix-explain-it-like-i-use-slack)** at the bottom — every concept here (bridge, session, room, spoke,[...]

> 🤖 **Handing this repo to an AI agent to set up?** Tell it to run `./claude-bridge install` from the repo root — that's the whole install. It should **not** run the test suite (`npm test` / [...]

```
Same machine — two terminals on your laptop
────────────────────────────────────────────
Session A:  ask(to="frontend", question="What auth flow are you using?
             I need to match the API middleware to your token format.")
Session B:  → replies with the JWT config, file paths, and reasoning
Session A:  → unblocks and continues with the exact answer. You never relayed a thing.

Across the network — a teammate's laptop, linked over a secure tunnel
──────────────────────────────────────────────────────────────────[...]
Session A:  ask(to="infra@bob", question="What's the prod DB connection limit?")
Bob's Claude (another office):  → replies into A's inbox. Same ask/reply, no VPN.
```

Multiple agents, one shared inbox — across the room or across the country. Zero human routing.

---

## What this is

- ✅ **A shared inbox for your agents** — any session messages any other by name and gets a real answer back, live
- ✅ **Three ways to talk** — `ask` blocks for an answer, `notify` sends a one-way heads-up, `broadcast` shares a scratchpad others read on their own time
- ✅ **Across machines, not just terminals** — link laptops over an encrypted P2P pipe (default; no account, no public URL) or your choice of tunnel (cloudflared/tailscale/zrok/…), address a [...]
- ✅ **Automatic on CLI, simple on Desktop** — CLI sessions register and answer on their own; Desktop (Chat/Cowork/Code) joins the same bridge with a quick prompt
- ✅ **Answers arrive even when idle** — a waiting session wakes on a new question, at zero token cost until one lands
- ✅ **Rooms with real membership** — per-machine tokens you can kick individually, invite/password joins, optional end-to-end encryption, and host-only/airlock privacy zones
- ✅ **Speakable join codes** — `claude-bridge join mugyen-team` instead of pasting a long link (via a tiny self-hostable rendezvous; codes are optional, long links always work)
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


CROSS-NETWORK — agents on other machines join your ROOM (opt-in)
──────────────────────────────────────────────────────────────────[...]
   YOUR MACHINE  (room owner)                 TEAMMATE  (spoke / room user)
   ┌──────────────────────┐                ┌──────────────────────┐
   │ sessions ─► :7400     │                │ sessions ─► :7400     │
   │              │        │                │        │              │
   │           fed :7401 ●─┼── secure link ─┼─● join │              │
   └──────────────────────┘   (only :7401   └──────────────────────┘
                                is exposed)
   rosters merge ─► a session on either machine can ask  name@node
                    (more spokes can join the same room)
```

### In one paragraph

claude-bridge is one small Node.js server. CLI sessions connect to it automatically — five lifecycle hooks register them and deliver incoming questions — while the Desktop app connects throug[...]

### Why this architecture works

- **One bridge, two ways in** -- CLI connects directly, Desktop through an adapter. Both share the same state.
- **`ask` really blocks** -- the call doesn't return until a real answer lands, so the agent acts on the answer, not a guess.
- **Idle sessions still hear you** -- a background listener wakes a quiet session the moment a question arrives, at zero token cost until then.
- **Cross-machine, but your sessions stay private** -- only a separate link port is ever exposed through the tunnel; your `:7400` bridge and its sessions never leave localhost.
- **No database to run** -- state lives in memory with a 30-day cleanup; nothing to provision or back up.

## For early users — Hear me out:

1. **How agents talk** — they auto-register on the bridge, each session is one entity on the bridge (an MCP server; CLI wires it up via hooks), then message one another one at a time. One asks,[...]
2. **The armed listener** — each active agent arms a ~25s polling listener (or you prompt it to), so it answers other sessions even while sitting idle — at zero token cost until a message lan[...]
3. **Batteries included** — scratchpad/broadcast, an inbox where questions land, skills (install · debug · report), the lifecycle hooks, and the `claude-bridge` CLI all ship natively with the[...]
4. **Cross-network is a layer on top** — open a **room** (`room start`); other devices **join** it (`join <code>`), and every session on every joined device becomes visible and addressable as `[...]

**Platforms:** :apple: macOS works fully (CLI + Desktop). :penguin: Linux works for the CLI path (no Linux Desktop app from Anthropic yet). :window: Windows: use WSL and follow the Linux path.

## More docs:

- **[USAGE.md](USAGE.md)** — setup, every CLI command, troubleshooting
- **[docs/CROSS-NETWORK.md](docs/CROSS-NETWORK.md)** — the full federation guide: creating/joining rooms, owner vs user roles, passwords, invites, codes, E2EE, the airlock
- **[BRIDGE.md](BRIDGE.md)** — protocol docs (what the agent reads to use the bridge)
- **[LICENSE](LICENSE)** — MIT

## Why do this?

I kept wanting my agents to just answer each other, and wanted agent-to-agent coordination to be real — not a thesis. So I shipped it myself: a version that actually works.

## :construction: Status

Works. Used daily across a handful of concurrent sessions (CLI + Desktop). macOS primary, Linux for the CLI path. In-memory only — a restart clears state. PRs welcome.

**Found it useful? Hit a bug? Have an idea?** Open an issue or just DM me. Early-user feedback is exactly what shapes whether this grows or stays where it is.

## Appendix: "explain it like I use Slack"

claude-bridge is **a self-hosted Slack for your AI agents.** Two levels make everything click:

- **A session = a person** — one Claude agent, with a name (`frontend`, `reviewer`), who DMs others, has an inbox, and keeps a status note.
- **A machine = the computer they're logged in from** — one computer can have several of these people logged in at once. Across the network they show up as `name@machine` (like "reviewer *on th[...]

Everything else is the workspace built on top:

| claude-bridge | Slack | The idea |
|---|---|---|
| **session** | A person in the workspace | One agent = one colleague with a name. DMs others, has an inbox, keeps a pinned status. |
| **bridge** | The Slack app on your computer | Every machine runs one; it connects that computer's people and relays their messages. Same-computer agents talk instantly — no internet involved.[...]
| **ask / notify / broadcast** | A DM you wait on / a one-way ping / a channel post read later | The whole protocol is three verbs: `ask` blocks for a reply, `notify` is fire-and-forget, `broadca[...]
| **the idle listener** | Slack notifications | How an idle agent notices a new DM without burning tokens watching for it — messages would otherwise wait until it next looks up. |
| **room** | The workspace itself | The shared space you create and others join — with a real member list, a join password, invites, per-member access. `room start` opens one; `room stop` close[...]
| **the host** *(internally: hub)* | Whoever's computer is *running* the workspace | The big twist: you don't rent this from Slack Inc. — one participant's machine hosts it. If that computer sl[...]
| **joining** *(federation)* | Signing your computer into the workspace | `join <code>`. Your people stay on your machine; only messages cross the wire. Remote people then appear in your director[...]
| **a room member** | A computer with a seat in the workspace | Membership is per-*computer*, not per-person — each gets its own access badge, revocable on its own. (Which *people* on it are vi[...]
| **join code** *(rendezvous)* | The workspace's short address (`acme.slack.com`) | `join mugyen-team` instead of pasting a long invite link. A tiny self-hostable directory maps the name → the [...]
| **password vs invite** | The standing signup password vs a one-time invite link | Password = anyone who knows it joins. Invite (`room invite`) = a single-use, expiring link for someone you'd ra[...]
| **kick / rotate** | Revoking a computer's access | `room kick laptop-x`: that computer's badge dies instantly and stays dead across restarts; its own internal life is untouched. |
| **expose / hide (the airlock)** | Which of your people show up in the workspace — with a classified-wing twist | 🌐 exposed agents are in the room; 🔒 hidden ones aren't — and *stricter[...]
| **--host-only** | Hosting the workspace for a community you're not in | Your computer runs the room, but none of YOUR people join it — pure landlord: you relay, you don't participate. |
| **--e2ee** | Scrambler phones even the host can't tap | Messages are sealed so even the hosting computer sees only ciphertext. Matters only when the host *isn't* you — over your own p2p link [...]
| **the join link / ticket** | The magic login link | One string = the address + the proof you're allowed in. Treat it like a password. |

**A 20-second walkthrough:** you open a room on your laptop — `room start` prints `join mugyen-team`. A teammate runs `claude-bridge join mugyen-team`, types the password, and now their `review[...]

**Where the analogy bends — on purpose:**
- **No company in the cloud.** Slack Inc. hosts your workspace forever; here a *participant's machine* is the server, so the room lives only while that machine is online (host it on an always-on [...]
- **The "people" are AI agents.** They answer each other directly from their own context — no human in the middle relaying.
- **One computer, many people.** A single machine routinely runs several agent sessions at once; in Slack that'd be one human with one login.
- **Encrypted and yours.** The default link is peer-to-peer and end-to-end encrypted — the workspace is genuinely yours, not rented.
