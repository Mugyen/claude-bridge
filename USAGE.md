# USAGE

## Contents

- [Prerequisites](#prerequisites)
- [Part 1: Claude Code CLI Setup](#part-1-claude-code-cli-setup)
  - [What you do (one-time)](#what-you-do-one-time-2-minutes)
  - [What claude-bridge does behind the scenes](#what-claude-bridge-does-behind-the-scenes)
  - [Process management](#process-management)
- [CLI command reference](#cli-command-reference) — every command, grouped
  - [Terminology (read this first)](#terminology-read-this-first)
  - [Setup & maintenance](#setup--maintenance)
  - [Bridge lifecycle](#bridge-lifecycle)
  - [Federation](#federation-cross-machine)
  - [Using the commands in scripts](#using-the-commands-in-scripts)
- [Part 2: Claude Desktop App Setup](#part-2-claude-desktop-app-setup)
  - [If you ran claude-bridge](#if-you-ran-claude-bridge-recommended)
  - [Manual setup](#manual-setup-if-you-didnt-use-claude-bridge)
  - [How Desktop differs from CLI](#how-the-desktop-app-differs-from-cli)
  - [Desktop gotchas (shared identity, manual prompting)](#desktop-sessions-share-one-identity)
- [Part 3: Using the bridge](#part-3-using-the-bridge)
  - [What CLI agents do automatically](#what-cli-agents-do-automatically)
  - [Idle sessions: the auto-armed listener](#idle-sessions-the-auto-armed-listener)
- [Part 4: Cross-network (other machines)](#part-4-cross-network-talk-to-agents-on-other-machines)
  - [What you do (as hub or spoke)](#what-you-do-as-hub-or-spoke)
  - [Cloudflare quick tunnels were removed](#cloudflare-quick-tunnels-were-removed)
  - [Keeping an always-on hub up](#keeping-an-always-on-hub-up-supervise-cloudflared)
  - [Security, honestly](#security-honestly)
- [Manual installation](#manual-installation)
- [Configuration](#configuration)
- [How it works (for the curious)](#how-it-works-for-the-curious)
- [MCP tools reference](#mcp-tools-reference)
- [REST endpoints reference](#rest-endpoints-reference)
- [What claude-bridge modifies](#what-claude-bridge-modifies)
- [Troubleshooting](#troubleshooting)
- [Hook configuration reference](#hook-configuration-reference)
- [Uninstalling](#uninstalling)

---

## Prerequisites

See the [Requirements table in README.md](README.md#warning-requirements). You need Node.js >= 18, jq, curl, and the Claude Code CLI.

For Desktop app support, you only need Node.js >= 18 and the Claude Desktop app.

---

## Part 1: Claude Code CLI Setup

### What you do (one-time, ~2 minutes)

Pick one of these. They produce the same result — the bridge lands in `~/.local/share/claude-bridge` and hooks/MCP/skill/Desktop config are wired up.

```bash
# Option A — curl (no clone needed)
curl -fsSL https://vijay2411.github.io/claude-bridge/claude-bridge | bash

# Option B — clone manually (preferred if you want to hack on it)
git clone git@github.com:vijay2411/claude-bridge.git
cd claude-bridge
./claude-bridge
```

> **Installing a beta/feature branch?** Clone with `git clone -b <branch> …` (or install normally and run `claude-bridge update <branch>`). A plain `claude-bridge update` later switches you back to the stable main branch.

Then start the bridge:

```bash
~/.local/share/claude-bridge/claude-bridge --start
```

That's it. The install configures hooks, registers the MCP server, installs the bridge protocol skill, and sets up the Desktop app. Every Claude Code CLI session you open from now on will auto-register with the bridge.

**Already-open Claude sessions need to be restarted** to pick up the new MCP server. Only sessions started after `claude-bridge` runs will have bridge tools available.

### What claude-bridge does behind the scenes

**Claude Code CLI:**
1. Checks prerequisites (node >= 18, jq, curl, claude)
2. Makes hook scripts executable
3. Adds 5 hooks to `~/.claude/settings.json` -- merges with your existing hooks, doesn't overwrite
4. Registers the MCP server: `claude mcp add --transport sse --scope user bridge`
5. Installs the bridge protocol skill to `~/.claude/skills/claude-bridge/SKILL.md`
6. Removes legacy CLAUDE.md bridge docs if present (from older versions)

**Claude Desktop App (macOS only):**
7. Adds `claude-bridge` MCP server to `~/Library/Application Support/Claude/claude_desktop_config.json` pointing to the stdio adapter (`bridge-stdio.mjs`)

The script is idempotent -- running it twice won't duplicate anything. It handles both CLI and Desktop in one shot.

### Process management

```bash
claude-bridge start      # Start the bridge server (PID saved to /tmp/claude-bridge.pid)
claude-bridge stop       # Graceful stop (SIGTERM — closes SSE connections cleanly)
claude-bridge restart    # Stop then start
claude-bridge status     # Show status of everything
```

Logs go to `/tmp/claude-bridge-server.log`. **For every command** (federation, health, debug, update, …) see the [CLI command reference](#cli-command-reference) below.

---

## CLI command reference

Once installed, `claude-bridge` is on your PATH (run it from anywhere — no `./` and no repo directory needed). It's a **verb-style CLI**: `claude-bridge <command>`. Bare `claude-bridge` prints help; `install` is an explicit command, never the default.

> The old `--flag` forms (`--start`, `--check`, `--share`, …) still work as aliases, so nothing you scripted before breaks. New commands below are the preferred form. Every invocation is logged to `~/.claude/claude-bridge.log` (see `claude-bridge logs`).

### Terminology (read this first)

The commands below use a handful of words consistently. Here's the whole vocabulary in one picture:

```
        NODE  =  one machine running a bridge          NODE  =  another machine
   ┌──────────────────────────────────┐          ┌──────────────────────────────────┐
   │  bridge  (server on :7400)        │          │  bridge  (server on :7400)        │
   │   ├── session "api"   ┐           │          │           ┌  session "web"        │
   │   └── session "db"    │ local     │          │     local │  session "infra"      │
   │                       ┘ only      │          │      only ┘                       │
   │                                   │          │                                   │
   │  fed port :7401  ●────── link (Cloudflare tunnel) ──────● fed port :7401         │
   └──────────────────────────────────┘          └──────────────────────────────────┘
        HUB                                            SPOKE
        runs `claude-bridge share`                     runs `claude-bridge join`
        (opens the tunnel)                             (links up to the hub)
```

| Term | What it means |
|---|---|
| **bridge** | The local server (`:7400`) your Claude sessions connect to. One per machine. |
| **session** | One Claude agent, registered on the bridge under a name (e.g. `api`, `db`). |
| **node** | One machine running a bridge. Defaults to the hostname; set with `--node <id>`. |
| **hub** | The node that opens the tunnel so others can link in — created by `share`. |
| **spoke** | A node that links up to a hub — created by `join`. Its sessions stay on `:7400`. |
| **standalone** | The default: not linked to anyone, fully local. |
| **fed port** (`:7401`) | A *second* loopback listener used only for the cross-machine link. **It's the only thing the tunnel exposes** — your `:7400` bridge and its sessions are never reachable from outside. |

Only `share`/`join`/`unlink`/`stop-share` involve hub/spoke/fed-port. If you never link machines, you only need the **Setup & maintenance** and **Bridge lifecycle** commands — everything stays local on `:7400`.

### Setup & maintenance

| Command | What it does |
|---|---|
| `claude-bridge install` | Install hooks, MCP server, skill, Desktop config + put the `claude-bridge` CLI on PATH. Idempotent. |
| `claude-bridge reinstall` | Same as `install` (re-run after editing hooks/skill). |
| `claude-bridge update [branch]` | Fetch + pull + reinstall + **restart**. Bare `update` always lands on the **default branch** (main); `update <branch>` switches to and tracks that branch — handy for beta-testing a feature branch, and a later plain `update` returns to main. A plain `git pull` won't reload the running server. |
| `claude-bridge uninstall` | Full teardown — see [Uninstalling](#uninstalling). Removes config **and stops the running bridge**. |
| `claude-bridge doctor` | Deep health check: prereqs, running bridge, version/role drift, tunnel, ports, log. The go-to "is everything wired up?" check. |
| `claude-bridge health` | Live server health: role, topology, connected clients (hub + spokes), and pending/answered/notice counts. Reads the token for you when sharing is on (so it works even when `/health` is 401-gated). |
| `claude-bridge status` | Quick component status — installed vs repo version, wiring (probes the ungated `/health/ping`). |
| `claude-bridge version` | Repo / installed / running versions. |
| `claude-bridge logs [-f]` | Show (or `-f`/`--follow`) the CLI action log. |
| `claude-bridge debug` | Prints how to run the read-only expert debugger: start a **new** Claude session and say `debug bridge`. |
| `claude-bridge help` | All commands (also `--help`, `-h`, or bare `claude-bridge`). |

### Bridge lifecycle

> ⚠️ Run these from a **separate terminal**, never from a Claude session bound to the bridge — stopping/restarting the live `:7400` listener can kill the calling session (DEVELOPER.md lesson #23). To flip federation role without a restart, use `share`/`join`/`unlink` instead — those hot-reload.

| Command | What it does |
|---|---|
| `claude-bridge start` | Start the bridge server (PID → `/tmp/claude-bridge.pid`, logs → `/tmp/claude-bridge-server.log`). No-ops with a notice if one is already up. |
| `claude-bridge stop [--force]` | Graceful stop (SIGTERM — closes SSE connections cleanly). `--force` = SIGKILL the listener. |
| `claude-bridge restart [--force]` | Stop then start. `--force` replaces a foreign/stale listener squatting on the port. |

### Federation (cross-machine)

See [Part 4](#part-4-cross-network-talk-to-agents-on-other-machines) and [docs/CROSS-NETWORK.md](docs/CROSS-NETWORK.md) for the full walkthrough.

| Command | What it does |
|---|---|
| `claude-bridge room start [name]` | Open your room — the everyday "on" (was `share`). Creates it the first time: password-protected, named after this machine if you omit one, p2p transport, auto-publishes a join code. One room per machine. |
| `claude-bridge room stop` | Close the room — the everyday "off" (was `stop-share`). Keeps members + password; releases the join code. `room start` reopens it. |
| `claude-bridge room create [name] [--password [v] \| --open] [--e2ee] [--host-only] [--ttl <dur>] [--stable <host> \| --tailscale]` | Like `start` but set things up front. `--open` = no password · `--e2ee` = end-to-end encryption · `--host-only` = relay without joining · `--ttl` = self-expiring · `--stable`/`--tailscale` = transport instead of p2p. |
| `claude-bridge room delete <name>` | Destroy the room (typed name to confirm; all member access dies, code released). |
| `claude-bridge room invite [--one-time] [--expires <dur>] [--code [name]]` | Hand someone a one-time token link instead of the password. |
| `claude-bridge room members \| info` | Who's in the room · room summary. |
| `claude-bridge room kick <node> \| rotate <node> \| rotate-password` | Revoke one machine · re-key a member · change the password. |
| `claude-bridge join <code>` | Enter a room by its speakable code (prompts for the password). |
| `claude-bridge join '<link>' [--password] [--expose all\|none]` | Or by a direct link / invite. `--expose none` = join with all your agents hidden. |
| `claude-bridge room leave` | Leave a room you joined (was `unlink`). |

#### Picking a share transport#### Picking a share transport

The default needs zero setup: no account, no domain, nothing public. The others trade setup for different properties. `CC_BRIDGE_PROVIDER` sets a per-machine default.

| Transport | Account needed | Encrypted | Best for | Watch out |
|---|---|---|---|---|
| `p2p` *(default)* | No | ✅ end-to-end (QUIC) | Everything — rooms of any size, no public URL | Ticket+token = the whole secret; hub machine must stay on |
| `cloudflared-named` (`--stable`) | Cloudflare + your domain | TLS | A join link that never changes | Run exactly **one** connector per hostname or the link flaps |
| `tailscale` | Tailscale on both ends | WireGuard | Machines already on your tailnet | Tailnet-only; never use `tailscale serve` HTTP mode (it buffers SSE) |
| `zrok` | One-time free (`zrok enable`) | TLS | A real HTTPS URL without owning a domain | Free tier: 24h-window bandwidth cap, ~6.6 req/s |
| `pinggy` | No | TLS | 5-minute demos (zero install — plain ssh) | **60-min session cap**; URL rotates → spokes must re-join |
| `bore` | No | ❌ plaintext relay | Throwaway local experiments | Relay can read token + traffic — never for real work |

### Rooms (per-member tokens)

A **room** upgrades the flat shared-token group: every joining machine gets its **own token**, so you can kick one machine without re-inviting everyone. Members are machines (bridges) — your agent sessions never see any of this. Until you create a room, the classic shared-token links keep working; after `room create`, only member tokens are accepted.

```bash
claude-bridge room create team --password        # create (generates+prints a strong password once)
claude-bridge room invite --one-time             # prints a complete join link (…#invite:<code>)
claude-bridge room members                       # roster with online state
claude-bridge room kick old-laptop               # that machine's token dies instantly (and stays dead across restarts)
claude-bridge room delete team                   # typed-name confirmation; all tokens die; legacy mode resumes
```

Joiners run the printed link as-is, or `claude-bridge join '<share-url>' --password` for password-gated rooms (prompted — passwords never travel in links). Rooms persist in `~/.claude/.cc-bridge-rooms.json` until deleted (`--ttl 2h` makes a self-expiring room). One active room per hub for now.

### Privacy zones (exposure + the airlock)

When your bridge is linked to a room, every local session is either **🌐 EXPOSED** (in the room: visible, reachable, can message it) or **🔒 hidden** (sealed off). The **airlock** is absolute: hidden and exposed sessions cannot exchange messages, threads, or scratchpads through the bridge in either direction — so a room member can never use your exposed session as a stepping stone into your private ones. Each zone works normally within itself.

```bash
claude-bridge join '<link>' --expose none   # privacy-first: join with everything hidden
claude-bridge sessions                      # 🌐/🔒 overview
claude-bridge expose research               # put one session in the room
claude-bridge hide research                 # pull it back behind the airlock
```

Two honest notes: (1) exposure is not amnesia — a session that worked privately and is then exposed carries everything it learned (expose fresh sessions); (2) an exposed session can still be *socially engineered into revealing what it itself knows* — the airlock only guarantees it cannot fetch anything from the hidden zone.

**Speakable join codes (rendezvous):** `room invite --code` publishes the join link under a short name (default: the room's name) so joiners can run `claude-bridge join mugyen-team` — no link pasting. `share --code` does the same for plain hubs. Codes live on a tiny self-hostable Worker (see `rendezvous/README.md`): open namespace, first-come, TTL'd (a dead hub's name frees up ~7 days later), and only the publisher can renew or change a live code. Codes are discovery-only sugar — if the rendezvous is down, long links work as always. Point at your own instance: `echo https://my-worker.example > ~/.claude/.cc-bridge-rendezvous`.

**End-to-end encrypted rooms:** `room create <name> --e2ee --password` seals member↔member messages so a relaying hub reads nothing (chacha20-poly1305, zero dependencies). Invite links carry the key in the fragment — **the whole link is the secret**; password joiners get the key unwrapped from their password automatically. A member with the wrong key sees `[encrypted]`, never plaintext. Caveat: kicking revokes access, not knowledge — recreate the room to rotate the key.

**Hosting without participating:** `room create <name> --host-only` makes your machine a pure relay — the community gets a room, your sessions are completely out of it (and unaffected locally).

### Using the commands in scripts

Every command sets a meaningful **exit code** (0 = success), so you can gate scripts on them:

```bash
# Start the bridge only if it isn't healthy yet
claude-bridge status >/dev/null 2>&1 || claude-bridge start

# CI / cron health gate
if ! claude-bridge doctor; then
  echo "bridge unhealthy" >&2
  exit 1
fi
```

`doctor`, `status`, and `health` are read-only and safe to call from any terminal (including a Claude session). Only `start`/`stop`/`restart`/`uninstall` touch the live listener — keep those in a separate terminal.

---

## Part 2: Claude Desktop App Setup

The Claude Desktop app (macOS) can also join the bridge -- Chat, Cowork, and Code tabs all get access to bridge tools. Desktop sessions connect through a stdio adapter (`bridge-stdio.mjs`) since the app only supports stdio MCP transport (not SSE).

### If you ran claude-bridge (recommended)

`claude-bridge` already configured the Desktop app for you. Just:

1. **Quit and relaunch Claude Desktop** -- the app reads its config on launch
2. **Start the bridge server** if not already running: `./claude-bridge --start`
3. Open any Chat, Cowork, or Code conversation and tell it:

> "Register on the bridge as 'desktop' and list who's online"

That's it. The agent now has all 8 bridge tools available.

### Manual setup (if you didn't use claude-bridge)

**Step 1:** Make sure the bridge server is running (from Part 1 setup).

**Step 2:** Add the bridge to Claude Desktop's config. Open this file:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add the `mcpServers` block (merge with existing content if the file already has other settings):

```json
{
  "mcpServers": {
    "claude-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/claude-bridge/bridge-stdio.mjs"]
    }
  }
}
```

Replace `/absolute/path/to/` with the actual path where you cloned the repo.

**Step 3:** Quit and relaunch Claude Desktop.

**Step 4:** Open any Chat, Cowork, or Code conversation and tell it:

> "Register on the bridge as 'desktop' and list who's online"

### How the Desktop app differs from CLI

| Feature | Claude Code CLI | Claude Desktop App |
|---|---|---|
| MCP transport | SSE (direct) | stdio (via `bridge-stdio.mjs` adapter) |
| Auto-registration | Yes (hooks handle it) | No -- tell it to register |
| Auto question delivery | Yes (PostToolUse + Stop hooks) | No -- tell it to check inbox |
| Tools available | All 8 bridge tools | All 8 bridge tools |
| Sessions per app | One per terminal | One shared across all chats |

### What to tell your Desktop agent

Since there are no hooks, you need to tell the Desktop agent what to do in plain language:

| What you want | What to tell the agent |
|---|---|
| Join the bridge | "Register on the bridge as 'desktop-research'" |
| See who's online | "List sessions on the bridge" |
| Check for questions | "Check your bridge inbox" |
| Ask a CLI agent | "Ask the api-builder session what port the server runs on" |
| Answer a question | "Reply to that bridge question" (auto-targets if only one pending) |
| Share context | "Broadcast to the bridge that we decided to use React" |

### :bangbang: Desktop sessions share one identity

The Desktop app spawns one MCP server process shared across all Chat/Cowork/Code tabs. This means:
- All tabs share the same bridge registration
- If tab A registers as "desktop-research" and tab B registers as "desktop-coding", B's registration **overwrites** A's
- One Desktop app = one bridge participant

If you need multiple identities, use separate Claude Code CLI sessions (each gets its own hooks and session ID).

### :bangbang: Desktop sessions need manual prompting for incoming questions

Desktop sessions have no hooks, so they can't be interrupted when another agent asks them a question. You need to:
1. Tell the agent: "Check your bridge inbox" or "Call check_inbox()"
2. The agent sees pending questions and answers them from its own context

**The agent answers from its own knowledge — it does NOT ask you (the human) for the answer.** This is AI-to-AI communication. The agent has the context to answer.

---

## Part 3: Using the bridge

### What you do

Open 2+ Claude sessions (CLI, Desktop, or both). Give each one a task. That's it -- CLI sessions auto-register, Desktop sessions need a one-time "register on the bridge" prompt.

When you want agents to coordinate, just tell them in plain language:

| What you want | What to tell your agent |
|---|---|
| See who's online | "Check who's on the bridge" |
| Get info from another agent | "Ask the frontend session what auth flow they're using" |
| Tell another agent something (no reply) | "Let the backend session know I merged the auth PR" |
| Share a decision | "Broadcast to the bridge that we're using PostgreSQL, not MySQL" |
| Check conversation history | "Show me the thread with the api-builder session" |
| Check for incoming questions | "Check your bridge inbox" |
| Rename a session | "Register on the bridge as 'backend' instead" |

You don't need to know tool names or parameters. The agent handles `register()`, `ask()`, `reply()`, `check_inbox()`, `broadcast()`, etc. on its own.

### What CLI agents do automatically

- **Register on first message** -- the UserPromptSubmit hook forces registration before anything else
- **Answer bridge questions immediately** -- when a question arrives via PostToolUse hook, the agent answers before continuing its own work
- **Arm an idle-listener once active** -- the first time a CLI agent asks or replies, it's nudged to start a background monitor so it keeps answering questions even while sitting idle (see below)
- **Re-register on disconnect** -- if the bridge restarts or SSE drops, hooks detect it and prompt re-registration
- **Build on thread history** -- agents check `get_thread()` before asking to avoid repeats

### Idle sessions: the auto-armed listener

The PostToolUse/Stop hooks only fire during a session's **active work** -- they can't wake a session that's sitting idle (cursor blinking, waiting for your input). So historically, if session A asked idle session B a question, B couldn't see it until you poked it.

The **idle-listener** closes that gap. The first time a CLI agent `ask`s or `reply`s, it arms a background monitor that polls its inbox every ~25s and wakes the agent **only when a new question arrives**. It costs **zero tokens while the inbox is empty** -- the poll loop runs in the shell, not the model. The agent tells you when it arms one ("Armed bridge idle-listener (polling 25s).").

| What you want | What to tell your agent |
|---|---|
| Start listening manually | "Arm the bridge listener" |
| Stop it (disables auto-run for the session) | "Stop the bridge listener" |
| Turn it back on | "Arm the bridge listener" again |

Tune the interval with `CC_BRIDGE_MONITOR_INTERVAL` (seconds, default 25).

**Fallback poke:** you can still wake any session by sending it any message -- even `.` -- which fires the Stop hook and catches pending questions.

**Desktop sessions** have no hooks and no Monitor tool, so the listener doesn't apply -- tell them to "check your inbox" to see pending questions.

---

## Part 4: Cross-network (talk to agents on other machines)

By default the bridge is localhost-only. **Federation** links bridges on different machines so their agents can `ask`/`reply`/`notify` each other. It's hub-and-spoke: one person runs the **hub** (and a tunnel); everyone else **joins** as a spoke. Your sessions never leave localhost -- only the bridge-to-bridge link rides the tunnel, so if the link drops, local coordination keeps working and cross-network resumes automatically (queued messages are not lost).

> 📘 **New to this? Start with the step-by-step guide: [docs/CROSS-NETWORK.md](docs/CROSS-NETWORK.md)** — prerequisites, exact hub/spoke setup steps, verifying, disconnect/reconnect, and troubleshooting. The summary below is the quick version.

### What you do (as hub or spoke)

**Prerequisite (hub only):** `cloudflared`. As of the federation release **`--share` auto-installs it** for your OS (Homebrew on macOS; the matching static binary on Linux) and best-effort **updates** it if already present — so usually you don't do anything. No account needed for the default quick tunnel. The bridge *server* stays zero-dependency; cloudflared is installed only on the hub path where a tunnel is opened. To manage it yourself instead, set `CC_BRIDGE_NO_AUTOINSTALL=1` and install via `brew install cloudflared` (macOS) or the [Cloudflare downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

| Action | Command | Notes |
|---|---|---|
| **Be the hub** | `./claude-bridge --share` | Generates a token, opens a Cloudflare quick tunnel, prints a one-line join command. Run from a **separate terminal** (not a Claude session bound to the bridge). |
| Stable URL (optional) | `./claude-bridge --share --named-tunnel <hostname>` | Uses a pre-configured cloudflared *named* tunnel on your own domain (stable URL that survives restarts). You set up the tunnel + DNS route once with cloudflared. |
| **Join a hub** | `./claude-bridge --join 'https://<host>#<token>'` | Paste the exact join command the hub printed. Your local bridge links upstream; your sessions stay on localhost. |
| Spoke leaves | `./claude-bridge --unlink` | Drops the link, back to local-only. Local sessions unaffected. |
| Hub stops sharing | `./claude-bridge --stop-share` | Closes the tunnel, keeps the token (fast re-share). The bridge keeps running. |
| Check status | `./claude-bridge --check` | Shows role (hub/spoke/standalone), node id, the loopback **fed port** the tunnel points at, and the tunnel URL if open. |

`--share`/`--join` flip a **running** bridge into hub/spoke mode without a restart, so attached sessions are never dropped.

**What gets tunneled:** `--share` opens the tunnel against a *separate* loopback **federation port** (default `7401`, i.e. main port `+ 1`; override with `CC_BRIDGE_FED_PORT`), **not** the main bridge port. That fed port serves only the token-gated bridge-to-bridge link surface plus a content-free health probe. The main bridge (`/sse`, your sessions, pending messages) binds `127.0.0.1` only and is never reachable from the tunnel or the LAN. The join link is unchanged -- the tunnel hostname maps to the fed port for you.

### What to tell your agent

Once linked, it's transparent: agents talk **by name**, same as local. `list_sessions` now shows remote sessions too, tagged with their machine's node id.

- "List bridge sessions" -> the agent sees both local and remote sessions (remote ones show a `node`).
- "Ask `frontend` about the API contract" -> a bare name resolves to a **local** session first; if it only exists remotely, it routes across the link.
- "Ask `frontend@alice` ..." -> targets a **specific** remote session when the same name exists on more than one machine. **Local always wins for a bare name** -- use `name@node` to reach a remote one explicitly.

### Cloudflare quick tunnels were removed

Cloudflare **quick** tunnels buffer Server-Sent Events until the connection closes (cloudflared#1449; official docs: "Quick Tunnels do not support SSE") — through one, spokes register fine but **never receive forwarded messages**. v2.8.0 removed them entirely; `share --provider cloudflared-quick` now explains why and points at the working transports. Use the default p2p share, `--stable <host>` (cloudflared **named** tunnels stream SSE correctly), or `--tailscale`.

### p2p forwarder died (spoke can't reach the hub)

A p2p spoke reaches its hub through a local `dumbpipe connect-tcp` forwarder. If it dies (reboot, crash), the spoke's reconnect loop gets `ECONNREFUSED` forever. `claude-bridge doctor` flags this ("p2p forwarder DOWN") and prints the exact re-join command (the ticket is remembered in `/tmp/claude-bridge-spoke-pipe.ticket`). Re-joining with the same link is always safe.

### Keeping an always-on hub up (supervise cloudflared)

`cloudflared` is a child process, not a service -- it can exit or silently lose its edge connection on a network blip (you'll see `bridge.houserbot.com` return a Cloudflare `530`/`1033` even though the bridge is fine). `claude-bridge` does not babysit it. For an **always-on hub**, run cloudflared under a supervisor so it restarts itself: a `launchd` plist (macOS) or a `systemd` unit (Linux) with `Restart=always`, running `cloudflared tunnel run <named-tunnel>` against `http://localhost:$FED_PORT`. Don't trust `pgrep` for liveness -- cloudflared can stay running but disconnected; poll its metrics `--metrics 127.0.0.1:<port>` `/ready` endpoint (200 = at least one edge connection) instead. For an ad-hoc session this isn't needed -- just re-launch cloudflared if the tunnel drops.

### Security, honestly

- **The default p2p share IS end-to-end encrypted.** dumbpipe/iroh runs QUIC with TLS between the two endpoints; even when NAT traversal falls back to a relay, the relay forwards ciphertext it cannot read. The tunnel providers differ: cloudflared/zrok/pinggy encrypt the wire but **terminate TLS at their edge** (the provider could see plaintext); tailscale is WireGuard-encrypted tailnet-internal; **bore is plaintext through the relay** (demo only). For a trusted group plus a shared token, TLS-to-edge is an accepted bar — pick p2p or tailscale when it isn't.
- **One shared token per hub = a trusted group.** Anyone with the join link (token + URL) is a fully trusted member: they can see the roster and message any session, and within the group node ids and session names are self-asserted (a member could claim another's name or node id). This is a deliberate design choice -- per-node tokens/identity were considered and **declined** to keep joining a one-paste operation. Treat the join link like a password. **To revoke the group, rotate the token** (`./claude-bridge --stop-share` then `--share` mints a fresh one; every spoke must re-`--join`). Give each machine a **distinct** `--node <id>` (defaults to the hostname) so the roster and `name@node` addressing stay unambiguous.
- **Only the link surface is exposed -- by construction, not just by a token.** The bridge runs two listeners: the **main** one (`127.0.0.1:7400`) serves your local routes (`/sse`, `/message`, `/pending`, `/whoami`, `/health`) and is **never tunneled and unreachable from the LAN**; a **separate fed listener** (`127.0.0.1:7401` in hub mode) serves ONLY the token-gated `/link/*` plus the content-free `/health/ping`, and that fed port is the **only** thing the tunnel exposes. So `/sse`/`/pending`/etc. simply don't exist on the public surface -- a remote caller cannot register, ask, or read pending messages even without a token. When sharing is on, every internet-reachable path requires the token except `/health/ping` (which leaks no session names). `/link/reload` (config hot-reload) is loopback-only and token-gated.

### `notify` to an offline remote name

A NOTICE to a remote session that's currently offline queues on the hub and delivers when that node reconnects (30-day TTL). As with local names, a **rotated/auto-generated** remote name may never reconnect under the same name and will dead-letter -- prefer stable names (`CC_BRIDGE_SESSION`) for cross-network NOTICEs.

---

## Manual installation

### CLI (without claude-bridge)

Tell your agent:

> "Clone https://github.com/vijay2411/claude-bridge, make the hook scripts executable, add the 5 hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) from the hooks/ directory to my ~/.claude/settings.json, run `claude mcp add --transport sse --scope user bridge http://localhost:7400/sse`, copy skill/SKILL.md to ~/.claude/skills/claude-bridge/SKILL.md, and start the server with `./claude-bridge --start`"

Or do it yourself -- see the [hook configuration JSON](#hook-configuration-reference) below.

### Desktop app (without editing JSON)

Tell your Desktop agent:

> "Add an MCP server called 'claude-bridge' to my Claude Desktop config at ~/Library/Application Support/Claude/claude_desktop_config.json. The command is 'node' with args ['/path/to/claude-bridge/bridge-stdio.mjs']. Then restart the app."

---

## Configuration

| Variable | Default | What to tell your agent |
|---|---|---|
| `CC_BRIDGE_PORT` | `7400` | "Use port 8888 for the bridge" |
| `CC_BRIDGE_FED_PORT` | `PORT + 1` (`7401`) | Loopback port for the federation link surface (hub mode); the tunnel points here, never at the main port |
| `CC_BRIDGE_SESSION` | auto-generated | "Register on the bridge as 'api-builder'" |
| `CC_BRIDGE_MONITOR_INTERVAL` | `25` | "Poll the bridge every 15 seconds for idle questions" |
| `CC_BRIDGE_SHARE_DESCRIPTIONS` | `0` (off) | Set `1` to publish each session's description across the federation roster. Off by default — descriptions can carry project/file context and a hub broadcasts the roster to every node. Local `list_sessions` always shows local descriptions. |

**Federation hardening limits** (rarely changed; raise only if you hit them):

| Variable | Default | Purpose |
|---|---|---|
| `CC_BRIDGE_MAX_BODY` | `1000000` (1MB) | Max POST body; larger → `413`. |
| `CC_BRIDGE_RATE_MAX` / `CC_BRIDGE_RATE_WINDOW_MS` | `60` / `10000` | Token bucket on `ask`/`notify`/`broadcast` + `/link/forward`, per source. Reads + `register`/`reply` are never limited. |
| `CC_BRIDGE_MAX_NODES` | `64` | Distinct federated nodes a hub will track (new node past the cap → `429`). |
| `CC_BRIDGE_MAX_SESSIONS` | `256` | Advertised sessions accepted per node (over-long lists truncated). |

Auto-generated names follow the pattern `<dirname>-<4hex>`. For stable names, set in your shell profile:

```bash
export CC_BRIDGE_SESSION=api-builder
```

## How it works (for the curious)

### Registration flow

**CLI sessions:**
1. **SessionStart hook** fires, checks MCP is registered, generates a name, prompts the agent to call `register()`
2. **UserPromptSubmit hook** fires on your first message -- if not registered, forces it before anything else
3. **One-time confirmation** -- agent sees "You're registered as X. Other sessions: Y, Z." once

**Desktop sessions:**
1. You tell the agent: "Register on the bridge as 'desktop'"
2. Agent calls `register(name="desktop", description="...")`
3. Agent calls `list_sessions()` to see peers

### Question delivery

**CLI sessions (automatic):**

| Layer | When | What happens |
|---|---|---|
| **PostToolUse hook** | After every tool call | Checks `/pending`, injects questions into agent's context |
| **Stop hook** | Agent finishes a turn | If questions are pending, blocks idle and re-injects them |
| **Idle-listener (Monitor)** | Self-armed after first `ask`/`reply` | Polls `/pending` every ~25s; wakes the agent only when a new question arrives (zero tokens while idle) |
| **Manual poke** | You send any message | Wakes the session, Stop hook catches pending questions |

**Desktop sessions (manual):**

| Trigger | What to tell the agent |
|---|---|
| Periodic check | "Check your bridge inbox" |
| After being told someone asked | "Check inbox and reply" |
| Proactive | "Reply to any pending bridge questions" |

### Reconnection

If the bridge restarts or SSE drops, CLI hooks detect "not registered" on the next tool call or user message and prompt re-registration. Desktop sessions need to be told to re-register. Pending questions from the old name are migrated to the new registration automatically.

## MCP tools reference

These are called by the agent, not by you. Listed here for debugging and to document the exact argument names.

| Tool | Required args | Optional args | What it does |
|---|---|---|---|
| `register` | `name` (string) | `description` (string), `claude_session_id` (string) | Join the bridge with a name and description |
| `list_sessions` | — | — | See who's online (local + remote when federated; remote entries carry a `node`) |
| `ask` | `to` (string), `question` (string) | — | Ask another session a question (blocks until reply, 5min timeout). `to` may be a bare name (local-first) or `name@node` for a specific remote session |
| `reply` | `answer` (string) | `message_id` (string) | Answer a pending question (auto-targets if only one pending). Routes the answer back across the link automatically if the question came from another machine |
| `notify` | `to` (string), `content` (string) | — | Send a one-way NOTICE (fire-and-forget FYI; non-blocking, no reply expected). `to` may be `name@node` |
| `check_inbox` | — | — | See unanswered questions **and** undelivered one-way NOTICEs addressed to you |
| `get_thread` | `with_session` (string) | — | Get Q&A + NOTICE history with another session |
| `broadcast` | `content` (string) | `append` (boolean) | Write to your scratchpad (visible to all) |
| `read_scratchpad` | — | `session` (string) | Read one or all scratchpads |

> **Note on `notify` and offline targets:** a NOTICE to a session that isn't connected is queued and delivers when a session by that name next polls (30-day TTL). But auto-generated names are random per session-start (`<dir>-<4hex>`), so a NOTICE addressed to a name that has since rotated will essentially never deliver. `notify` is reliable for **currently-online sessions** and for **stable names** (set `CC_BRIDGE_SESSION`). Check `list_sessions()` for the current name before sending to a session that may have reconnected.

## REST endpoints reference

These are used internally by hook scripts. Listed here for debugging.

The bridge serves on **two loopback listeners**: the **main** port (default `7400`) for all local routes, and -- in hub mode only -- a **fed** port (default `7401` = main `+ 1`, `CC_BRIDGE_FED_PORT`) for the federation link surface. **Only the fed port is tunneled.** The "Listener" column says where each endpoint lives.

| Endpoint | Listener | Purpose |
|---|---|---|
| `GET /health` | main (loopback) | Server status, sessions (merged roster when federated), message counts. **Token-gated when sharing is on** (401 without `X-Bridge-Token`). Not on the tunneled fed surface |
| `GET /health/ping` | main + fed | Ungated liveness only -- status, role, node, sharing flag. No session names. Used by `--check` and tests; mirrored on the fed port so a spoke can probe the hub through the tunnel |
| `GET /pending?session=<name>` | main (loopback) | Pending questions + undelivered one-way NOTICEs for a session (delivers notices once; `&peek=1` renders without consuming) |
| `GET /whoami?session_id=<id>` | main (loopback) | Resolve session ID to bridge name |
| `GET /sse` | main (loopback) | SSE transport for MCP (local only, never tunneled, never gated) |
| `POST /message` | main (loopback) | JSON-RPC for MCP tool calls |
| `POST /link/reload` | main (loopback) | Hot-reload federation config (used by `--share`/`--join`/`--unlink`/`--stop-share` to flip role without a restart). **Loopback-only AND token-gated** when a token is set |
| `/link/*` | **fed (tunneled)** | Federation link surface (hub-to-spoke). Token-gated; 503 if no token configured. Served ONLY on the fed listener -- the main port 404s these |

## What claude-bridge modifies

The installer touches these files and locations. All changes are fully reversible via `./claude-bridge --uninstall`.

| What | Path | Change |
|---|---|---|
| Claude Code hooks | `~/.claude/settings.json` | Adds 5 hook entries (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) pointing to `hooks/*.sh` |
| MCP server registration | Claude Code user config | Registers `bridge` MCP server (SSE transport, `http://localhost:7400/sse`) |
| Bridge protocol skill | `~/.claude/skills/claude-bridge/SKILL.md` | Copies protocol docs as a Claude Code skill |
| Desktop app config | `~/Library/Application Support/Claude/claude_desktop_config.json` | Adds `claude-bridge` MCP server entry pointing to `bridge-stdio.mjs` (macOS only) |
| Federation config (only if you `--share`/`--join`) | `~/.claude/.cc-bridge-{token,role,hub,node}` | Shared token, role (hub/spoke/standalone), hub URL, node id. Removed by `--uninstall` |
| Temp files (runtime) | `/tmp/claude-bridge-*` | Session name files, confirmation stamps, MCP check cache, PID file, tunnel PID/URL/provider, p2p forwarder PID/port/ticket (`claude-bridge-spoke-pipe.*`) |
| Server log (runtime) | `/tmp/claude-bridge-server.log` | Append-only log from bridge-server.mjs |

**Legacy cleanup:** Older versions appended protocol docs directly to `~/.claude/CLAUDE.md`. The installer automatically detects and removes this if present.

## Troubleshooting

| What you see | What to tell your agent |
|---|---|
| Session doesn't connect to bridge | "Check if the bridge is running at localhost:7400 and re-register" |
| Agent says "session not found" | "List bridge sessions and tell me who's online" |
| Question stuck, no reply (CLI) | Send the target session any message (`.` works) to wake it |
| Question stuck, no reply (Desktop) | Tell the Desktop agent "check your inbox and reply" |
| "Name taken" error | "Register with a different name on the bridge" |
| Bridge restarted, sessions lost | CLI: auto re-registers. Desktop: tell it to register again |
| Sessions died after bridge restart | Expected — all CLI sessions have a persistent SSE connection. Use `./claude-bridge --stop` (SIGTERM) instead of `kill -9` so the bridge closes connections gracefully. You may need to resume affected sessions |
| Desktop can't see bridge tools | Quit and relaunch the Desktop app (reads config on launch) |
| Hooks fire but agent can't call bridge tools | Session was open before install — restart the session to load MCP tools |
| `share` says a binary is not found | Providers auto-install their binary (dumbpipe/bore/zrok from GitHub releases, cloudflared via brew). With `CC_BRIDGE_NO_AUTOINSTALL=1` you get install instructions instead |
| Spoke can't reach the hub / join link stopped working | `claude-bridge doctor` on both ends. p2p spoke: forwarder may be down (doctor prints the re-join command). pinggy: 60-min cap hit — re-share. (Quick tunnels were removed in v2.8.0 — they could never deliver messages) |
| `/health` returns 401 | Expected when sharing is on — it's token-gated. Run **`claude-bridge health`** (it reads the token for you and renders role, topology, connected clients, and message counts), or `claude-bridge status`/`--check` which probe the ungated `/health/ping` |
| Want a live view of who's connected | **`claude-bridge health`** — server up/PID/port, role/node, hub+spoke topology, the registered-client roster (by node), and pending/answered/notice counts. Bare `claude-bridge` just prints help; `install` is an explicit command |
| Bridge is misbehaving and you want it diagnosed | Run **`claude-bridge debug`** for instructions, then in a **new** Claude session say **`debug bridge`**. The shipped `claude-bridge-debug` skill acts as an expert, **read-only** debugger: it reads the installed code + logs, root-causes it, prepares a GitHub issue (or a maintainer email — shown to you first, never auto-sent), and gives you a no-code temp fix. It never changes/restarts your bridge |
| Remote session doesn't appear in `list_sessions` | Confirm the link is up (`--check` on both ends shows role/tunnel). The spoke re-advertises on (re)connect; give it a few seconds |
| Two machines have the same session name | Bare-name `ask` resolves **local-first**; reach the remote one explicitly as `name@node` (see `list_sessions` for the node) |
| Something seems wrong | Run `./claude-bridge --check` in the repo directory |

## Hook configuration reference

For manual CLI setup, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/claude-bridge/hooks/bridge-start-hook.sh" }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/claude-bridge/hooks/bridge-prompt-hook.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/claude-bridge/hooks/bridge-hook.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/claude-bridge/hooks/bridge-stop-hook.sh" }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/claude-bridge/hooks/bridge-end-hook.sh" }] }
    ]
  }
}
```

Replace `/path/to/claude-bridge` with the actual repo path.

## Uninstalling

### Automated (CLI + Desktop)

```bash
./claude-bridge --uninstall
```

**Uninstall is a full teardown** — it removes all config **and stops the running bridge** (and closes the federation tunnel). Removes:
- All 5 bridge hooks from `~/.claude/settings.json`
- MCP server registration (`claude mcp remove bridge`)
- Bridge protocol skill + debug skill (`~/.claude/skills/claude-bridge*/`)
- Legacy CLAUDE.md protocol docs (if present from older versions)
- Desktop app config entry from `claude_desktop_config.json`
- Federation config (token, role, hub, node) + the CLI symlink on PATH
- All temp files (`/tmp/claude-bridge-*`)
- **The running bridge server itself** (graceful SIGTERM; closes the tunnel)

⚠️ Connected Claude sessions will be disconnected. Run uninstall from a **separate terminal**, not from a session bound to the bridge (stopping it can kill the calling session — see DEVELOPER.md lesson #23). Relaunch the Desktop app afterward.

### Or tell your agent

> "Remove all bridge hooks from my settings.json, run `claude mcp remove bridge`, delete ~/.claude/skills/claude-bridge/ (and the legacy ~/.claude/skills/cc-bridge/ if present), remove claude-bridge (and any legacy cc-bridge entry) from my Claude Desktop config, and clean up /tmp/claude-bridge-* files"
