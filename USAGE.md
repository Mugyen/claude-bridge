# USAGE

## Prerequisites

See the [Requirements table in README.md](README.md#warning-requirements). You need Node.js >= 18, jq, curl, and the Claude Code CLI.

For Desktop app support, you only need Node.js >= 18 and the Claude Desktop app.

---

## Part 1: Claude Code CLI Setup

### What you do (one-time, ~2 minutes)

```bash
git clone git@github.com:vijay2411/claude-code-sessions-bridge.git
cd claude-code-sessions-bridge
./install.sh
nohup node bridge-server.mjs &
```

That's it. The install script configures hooks, registers the MCP server, and adds protocol docs to your CLAUDE.md. Every Claude Code CLI session you open from now on will auto-register with the bridge.

### What install.sh does behind the scenes

1. Checks prerequisites (node >= 18, jq, curl, claude)
2. Makes hook scripts executable
3. Adds 5 hooks to `~/.claude/settings.json` -- merges with your existing hooks, doesn't overwrite
4. Registers the MCP server: `claude mcp add --transport sse --scope user bridge`
5. Appends [BRIDGE.md](BRIDGE.md) protocol docs to `~/.claude/CLAUDE.md` so agents know how to use the bridge

The script is idempotent -- running it twice won't duplicate anything.

---

## Part 2: Claude Desktop App Setup

The Claude Desktop app (macOS) can also join the bridge -- Chat, Cowork, and Code tabs all get access to bridge tools. Desktop sessions connect through a stdio adapter since the app only supports stdio MCP transport (not SSE).

### What you do (one-time, ~1 minute)

**Step 1:** Make sure the bridge server is running (from Part 1 setup).

**Step 2:** Add the bridge to Claude Desktop's config. Open this file:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add the `mcpServers` block (merge with existing content if the file already has other settings):

```json
{
  "mcpServers": {
    "cc-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-sessions-bridge/bridge-stdio.mjs"]
    }
  }
}
```

Replace `/absolute/path/to/` with the actual path where you cloned the repo.

**Step 3:** Quit and relaunch Claude Desktop. The app reads the config on launch.

**Step 4:** Done. Open any Chat, Cowork, or Code conversation and tell it:

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

> "Clone https://github.com/vijay2411/claude-code-sessions-bridge to ~/cc-bridge, make the hook scripts executable, add the 5 hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) from the hooks/ directory to my ~/.claude/settings.json, run `claude mcp add --transport sse --scope user bridge http://localhost:7400/sse`, append BRIDGE.md to my ~/.claude/CLAUDE.md, and start the server with `nohup node ~/cc-bridge/bridge-server.mjs &`"

Or do it yourself -- see the [hook configuration JSON](#hook-configuration-reference) below.

### Desktop app (without editing JSON)

Tell your Desktop agent:

> "Add an MCP server called 'cc-bridge' to my Claude Desktop config at ~/Library/Application Support/Claude/claude_desktop_config.json. The command is 'node' with args ['/path/to/cc-bridge/bridge-stdio.mjs']. Then restart the app."

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
1. **SessionStart hook** fires, generates a name, prompts the agent to call `register()`
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

These are called by the agent, not by you. Listed here for debugging. Available to both CLI and Desktop sessions.

| Tool | What it does |
|---|---|
| `register` | Join the bridge with a name and description |
| `list_sessions` | See who's online |
| `ask` | Ask another session a question (blocks until reply, 5min timeout) |
| `reply` | Answer a pending question (auto-targets if only one pending) |
| `check_inbox` | See all unanswered questions addressed to you |
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
| Question stuck, no reply (CLI) | Send the target session any message (`.` works) to wake it |
| Question stuck, no reply (Desktop) | Tell the Desktop agent "check your inbox and reply" |
| "Name taken" error | "Register with a different name on the bridge" |
| Bridge restarted, sessions lost | CLI: auto re-registers. Desktop: tell it to register again |
| Desktop can't see bridge tools | Quit and relaunch the Desktop app (reads config on launch) |
| Something seems wrong | Run `./install.sh --check` in the repo directory |

## Hook configuration reference

For manual CLI setup, add to `~/.claude/settings.json`:

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

### Automated (CLI)

```bash
./install.sh --uninstall
```

### Desktop app

Remove the `cc-bridge` entry from `~/Library/Application Support/Claude/claude_desktop_config.json` and relaunch the app.

### Or tell your agent

> "Remove all bridge hooks from my settings.json, run `claude mcp remove bridge`, remove the Bridge Communication Protocol section from my CLAUDE.md, remove cc-bridge from my Claude Desktop config, and clean up /tmp/cc-bridge-* files"
