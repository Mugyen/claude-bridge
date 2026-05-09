# USAGE

## Prerequisites

See the [Requirements table in README.md](README.md#warning-requirements). You need Node.js >= 18, jq, curl, and the Claude Code CLI.

## Setup

### What you do (one-time, ~2 minutes)

```bash
git clone git@github.com:vijay2411/claude-code-sessions-bridge.git
cd claude-code-sessions-bridge
./install.sh
nohup node bridge-server.mjs &
```

That's it. You're done. The install script configures hooks, registers the MCP server, and adds protocol docs to your CLAUDE.md. Every Claude Code session you open from now on will auto-register with the bridge.

### What install.sh does behind the scenes

1. Checks prerequisites (node >= 18, jq, curl, claude)
2. Makes hook scripts executable
3. Adds 5 hooks to `~/.claude/settings.json` -- merges with your existing hooks, doesn't overwrite
4. Registers the MCP server: `claude mcp add --transport sse --scope user bridge`
5. Appends [BRIDGE.md](BRIDGE.md) protocol docs to `~/.claude/CLAUDE.md` so agents know how to use the bridge

The script is idempotent -- running it twice won't duplicate anything.

## Using the bridge

### What you do

Open 2+ Claude Code sessions. Give each one a task. That's it -- they auto-register on your first message and can talk to each other.

When you want agents to coordinate, just tell them in plain language:

| What you want | What to tell your agent |
|---|---|
| See who's online | "Check who's on the bridge" |
| Get info from another agent | "Ask the frontend session what auth flow they're using" |
| Share a decision | "Broadcast to the bridge that we're using PostgreSQL, not MySQL" |
| Check conversation history | "Show me the thread with the api-builder session" |
| Rename a session | "Register on the bridge as 'backend' instead" |

You don't need to know tool names or parameters. The agent handles `register()`, `ask()`, `reply()`, `broadcast()`, etc. on its own.

### What the agents do automatically

- **Register on first message** -- the UserPromptSubmit hook forces registration before anything else
- **Answer bridge questions immediately** -- when a question arrives via PostToolUse hook, the agent answers before continuing its own work
- **Re-register on disconnect** -- if the bridge restarts or SSE drops, hooks detect it and prompt re-registration
- **Build on thread history** -- agents check `get_thread()` before asking to avoid repeats

### :bangbang: Known limitation: idle sessions

If session B is **sitting idle** (cursor blinking, waiting for your input) and session A asks it a question, B **cannot see the question** until it wakes up. This is a Claude Code harness limitation -- there is no way to inject context into a truly idle session.

**The workaround:** Send session B any message -- even just `.` or `reply`. The Stop hook fires and catches the pending question. The agent will answer it before doing anything else.

The Stop hook covers ~95% of cases (it fires when an agent finishes a turn). The only gap is when a session has been completely idle for a while and a new question arrives after that.

## Manual installation

If you prefer not to run install scripts, tell your agent:

> "Clone https://github.com/vijay2411/claude-code-sessions-bridge to ~/cc-bridge, make the hook scripts executable, add the 5 hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) from the hooks/ directory to my ~/.claude/settings.json, run `claude mcp add --transport sse --scope user bridge http://localhost:7400/sse`, append BRIDGE.md to my ~/.claude/CLAUDE.md, and start the server with `nohup node ~/cc-bridge/bridge-server.mjs &`"

Or do it yourself -- see the [hook configuration JSON](#hook-configuration-reference) below.

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

1. **SessionStart hook** fires, generates a name, prompts the agent to call `register()`
2. **UserPromptSubmit hook** fires on your first message -- if not registered, forces it before anything else
3. **One-time confirmation** -- agent sees "You're registered as X. Other sessions: Y, Z." once

### Question delivery

| Layer | When | What happens |
|---|---|---|
| **PostToolUse hook** | After every tool call | Checks `/pending`, injects questions into agent's context |
| **Stop hook** | Agent finishes a turn | If questions are pending, blocks idle and re-injects them |
| **Manual poke** | You send any message | Wakes the session, Stop hook catches pending questions |

### Reconnection

If the bridge restarts or SSE drops, hooks detect "not registered" on the next tool call or user message and prompt re-registration. Pending questions from the old name are migrated to the new registration automatically.

## MCP tools reference

These are called by the agent, not by you. Listed here for debugging.

| Tool | What it does |
|---|---|
| `register` | Join the bridge with a name and description |
| `list_sessions` | See who's online |
| `ask` | Ask another session a question (blocks until reply, 5min timeout) |
| `reply` | Answer a pending question |
| `get_thread` | Get Q&A history with another session |
| `broadcast` | Write to your scratchpad (visible to all) |
| `read_scratchpad` | Read one or all scratchpads |

## REST endpoints reference

These are used internally by hook scripts. Listed here for debugging.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Server status, active sessions, message counts |
| `GET /pending?session=<name>` | Pending questions for a session |
| `GET /whoami?session_id=<id>` | Resolve session ID to bridge name |
| `GET /sse` | SSE transport for MCP |
| `POST /message` | JSON-RPC for MCP tool calls |

## Troubleshooting

| What you see | What to tell your agent |
|---|---|
| Session doesn't connect to bridge | "Check if the bridge is running at localhost:7400 and re-register" |
| Agent says "session not found" | "List bridge sessions and tell me who's online" |
| Question stuck, no reply | Send the target session any message (`.` works) to wake it |
| "Name taken" error | "Register with a different name on the bridge" |
| Bridge restarted, sessions lost | Sessions re-register automatically on next message |
| Something seems wrong | Run `./install.sh --check` in the repo directory |

## Hook configuration reference

For manual setup, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/cc-bridge/hooks/bridge-start-hook.sh" }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/cc-bridge/hooks/bridge-prompt-hook.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/cc-bridge/hooks/bridge-hook.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/cc-bridge/hooks/bridge-stop-hook.sh" }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/cc-bridge/hooks/bridge-end-hook.sh" }] }
    ]
  }
}
```

Replace `/path/to/cc-bridge` with the actual repo path.

## Uninstalling

### Automated

```bash
./install.sh --uninstall
```

### Or tell your agent

> "Remove all bridge hooks from my settings.json, run `claude mcp remove bridge`, remove the Bridge Communication Protocol section from my CLAUDE.md, and clean up /tmp/cc-bridge-* files"
