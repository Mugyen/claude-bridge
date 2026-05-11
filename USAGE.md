# USAGE

## Prerequisites

See the [Requirements table in README.md](README.md#warning-requirements). You need Node.js >= 18, jq, curl, and the Claude Code CLI.

For Desktop app support, you only need Node.js >= 18 and the Claude Desktop app.

---

## Part 1: Claude Code CLI Setup

### What you do (one-time, ~2 minutes)

Pick one of these. They produce the same result — the bridge lands in `~/.local/share/claude-bridge` and hooks/MCP/skill/Desktop config are wired up.

```bash
# Option A — curl (no clone needed)
curl -fsSL https://vijay2411.github.io/claude-bridge/install.sh | bash

# Option B — clone manually (preferred if you want to hack on it)
git clone git@github.com:vijay2411/claude-bridge.git
cd claude-bridge
./install.sh
```

Then start the bridge:

```bash
~/.local/share/claude-bridge/install.sh --start
```

That's it. The install configures hooks, registers the MCP server, installs the bridge protocol skill, and sets up the Desktop app. Every Claude Code CLI session you open from now on will auto-register with the bridge.

**Already-open Claude sessions need to be restarted** to pick up the new MCP server. Only sessions started after `install.sh` runs will have bridge tools available.

### What install.sh does behind the scenes

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
./install.sh --start      # Start the bridge server (PID saved to /tmp/claude-bridge.pid)
./install.sh --stop       # Graceful stop (SIGTERM — closes SSE connections cleanly)
./install.sh --restart    # Stop then start
./install.sh --check      # Show status of everything
```

Logs go to `/tmp/claude-bridge-server.log`.

---

## Part 2: Claude Desktop App Setup

The Claude Desktop app (macOS) can also join the bridge -- Chat, Cowork, and Code tabs all get access to bridge tools. Desktop sessions connect through a stdio adapter (`bridge-stdio.mjs`) since the app only supports stdio MCP transport (not SSE).

### If you ran install.sh (recommended)

`install.sh` already configured the Desktop app for you. Just:

1. **Quit and relaunch Claude Desktop** -- the app reads its config on launch
2. **Start the bridge server** if not already running: `./install.sh --start`
3. Open any Chat, Cowork, or Code conversation and tell it:

> "Register on the bridge as 'desktop' and list who's online"

That's it. The agent now has all 8 bridge tools available.

### Manual setup (if you didn't use install.sh)

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
| Share a decision | "Broadcast to the bridge that we're using PostgreSQL, not MySQL" |
| Check conversation history | "Show me the thread with the api-builder session" |
| Check for incoming questions | "Check your bridge inbox" |
| Rename a session | "Register on the bridge as 'backend' instead" |

You don't need to know tool names or parameters. The agent handles `register()`, `ask()`, `reply()`, `check_inbox()`, `broadcast()`, etc. on its own.

### What CLI agents do automatically

- **Register on first message** -- the UserPromptSubmit hook forces registration before anything else
- **Answer bridge questions immediately** -- when a question arrives via PostToolUse hook, the agent answers before continuing its own work
- **Re-register on disconnect** -- if the bridge restarts or SSE drops, hooks detect it and prompt re-registration
- **Build on thread history** -- agents check `get_thread()` before asking to avoid repeats

### :bangbang: Known limitation: idle sessions

If session B is **sitting idle** (cursor blinking, waiting for your input) and session A asks it a question, B **cannot see the question** until it wakes up. This is a Claude Code harness limitation -- there is no way to inject context into a truly idle session.

**The workaround:** Send session B any message -- even just `.` or `reply`. The Stop hook fires and catches the pending question. The agent will answer it before doing anything else.

The Stop hook covers ~95% of cases (it fires when an agent finishes a turn). The only gap is when a session has been completely idle for a while and a new question arrives after that.

This applies to **Desktop sessions too** -- since they have no hooks at all, you must tell them to "check your inbox" for them to see pending questions.

---

## Manual installation

### CLI (without install.sh)

Tell your agent:

> "Clone https://github.com/vijay2411/claude-bridge, make the hook scripts executable, add the 5 hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) from the hooks/ directory to my ~/.claude/settings.json, run `claude mcp add --transport sse --scope user bridge http://localhost:7400/sse`, copy skill/SKILL.md to ~/.claude/skills/claude-bridge/SKILL.md, and start the server with `./install.sh --start`"

Or do it yourself -- see the [hook configuration JSON](#hook-configuration-reference) below.

### Desktop app (without editing JSON)

Tell your Desktop agent:

> "Add an MCP server called 'claude-bridge' to my Claude Desktop config at ~/Library/Application Support/Claude/claude_desktop_config.json. The command is 'node' with args ['/path/to/claude-bridge/bridge-stdio.mjs']. Then restart the app."

---

## Configuration

| Variable | Default | What to tell your agent |
|---|---|---|
| `CC_BRIDGE_PORT` | `7400` | "Use port 8888 for the bridge" |
| `CC_BRIDGE_SESSION` | auto-generated | "Register on the bridge as 'api-builder'" |

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
| `list_sessions` | — | — | See who's online |
| `ask` | `to` (string), `question` (string) | — | Ask another session a question (blocks until reply, 5min timeout) |
| `reply` | `answer` (string) | `message_id` (string) | Answer a pending question (auto-targets if only one pending) |
| `check_inbox` | — | — | See all unanswered questions addressed to you |
| `get_thread` | `with_session` (string) | — | Get Q&A history with another session |
| `broadcast` | `content` (string) | `append` (boolean) | Write to your scratchpad (visible to all) |
| `read_scratchpad` | — | `session` (string) | Read one or all scratchpads |

## REST endpoints reference

These are used internally by hook scripts. Listed here for debugging.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Server status, active sessions, message counts |
| `GET /pending?session=<name>` | Pending questions for a session |
| `GET /whoami?session_id=<id>` | Resolve session ID to bridge name |
| `GET /sse` | SSE transport for MCP |
| `POST /message` | JSON-RPC for MCP tool calls |

## What install.sh modifies

The installer touches these files and locations. All changes are fully reversible via `./install.sh --uninstall`.

| What | Path | Change |
|---|---|---|
| Claude Code hooks | `~/.claude/settings.json` | Adds 5 hook entries (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) pointing to `hooks/*.sh` |
| MCP server registration | Claude Code user config | Registers `bridge` MCP server (SSE transport, `http://localhost:7400/sse`) |
| Bridge protocol skill | `~/.claude/skills/claude-bridge/SKILL.md` | Copies protocol docs as a Claude Code skill |
| Desktop app config | `~/Library/Application Support/Claude/claude_desktop_config.json` | Adds `claude-bridge` MCP server entry pointing to `bridge-stdio.mjs` (macOS only) |
| Temp files (runtime) | `/tmp/claude-bridge-*` | Session name files, confirmation stamps, MCP check cache, PID file |
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
| Sessions died after bridge restart | Expected — all CLI sessions have a persistent SSE connection. Use `./install.sh --stop` (SIGTERM) instead of `kill -9` so the bridge closes connections gracefully. You may need to resume affected sessions |
| Desktop can't see bridge tools | Quit and relaunch the Desktop app (reads config on launch) |
| Hooks fire but agent can't call bridge tools | Session was open before install — restart the session to load MCP tools |
| Something seems wrong | Run `./install.sh --check` in the repo directory |

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
./install.sh --uninstall
```

Removes:
- All 5 bridge hooks from `~/.claude/settings.json`
- MCP server registration (`claude mcp remove bridge`)
- Bridge protocol skill (`~/.claude/skills/claude-bridge/`)
- Legacy CLAUDE.md protocol docs (if present from older versions)
- Desktop app config entry from `claude_desktop_config.json`
- All temp files (`/tmp/claude-bridge-*`)

Relaunch the Desktop app after uninstalling. Stop the bridge server separately: `./install.sh --stop`.

### Or tell your agent

> "Remove all bridge hooks from my settings.json, run `claude mcp remove bridge`, delete ~/.claude/skills/claude-bridge/ (and the legacy ~/.claude/skills/cc-bridge/ if present), remove claude-bridge (and any legacy cc-bridge entry) from my Claude Desktop config, and clean up /tmp/claude-bridge-* files"
