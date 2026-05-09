# USAGE

## Prerequisites

See the [Requirements table in README.md](README.md#warning-requirements). You need Node.js >= 18, jq, curl, and the Claude Code CLI.

## Quickstart (automated)

```bash
git clone git@github.com:vijay2411/claude-code-sessions-bridge.git
cd claude-code-sessions-bridge
./install.sh
```

Then start the bridge:

```bash
nohup node bridge-server.mjs&
```

Open 2+ Claude Code sessions. They auto-register on your first message, lots of hooks have been installed on start, stop, in-between tool use, just refer this communication as bridge, ask both sessions to register on bridge, check who all sessions are alive, and then you can simply ask one session to ask another session and they would reply appropriately, make sure you have the names of the sessions with you. Start asking questions between them.

#### ‼️ NOTE: if one session is sitting idle and another is asking it question, it cannot reply, this feature is not available in claude-code harness, we have deferred in implementing this. So when session A is asking something to session B, make sure session B is not idle and rest should be fine, if session B is idle whilst session A is trying to ask something, just tell session B to "reply", one word, should be enough! or even "." should be enough, there is stop hook on the session. 

## What install.sh does

1. Checks prerequisites (node >= 18, jq, curl, claude)
2. Makes hook scripts executable (`chmod +x hooks/*.sh`)
3. Adds 5 hooks to `~/.claude/settings.json` (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) -- merges with your existing hooks, doesn't overwrite
4. Registers the MCP server: `claude mcp add --transport sse --scope user bridge "http://localhost:7400/sse"`
5. Appends [BRIDGE.md](BRIDGE.md) protocol docs to `~/.claude/CLAUDE.md` so Claude knows how to use the bridge

The script is idempotent -- running it twice won't duplicate hooks or BRIDGE.md content.

## Manual installation

If you prefer not to run install scripts:

### 1. Clone to a stable path

```bash
git clone git@github.com:vijay2411/claude-code-sessions-bridge.git ~/cc-bridge
chmod +x ~/cc-bridge/hooks/*.sh
```

### 2. Configure hooks

Add these to `~/.claude/settings.json` (merge into your existing `hooks` object):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "/Users/YOU/cc-bridge/hooks/bridge-start-hook.sh" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "/Users/YOU/cc-bridge/hooks/bridge-prompt-hook.sh" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "/Users/YOU/cc-bridge/hooks/bridge-hook.sh" }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "/Users/YOU/cc-bridge/hooks/bridge-stop-hook.sh" }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "/Users/YOU/cc-bridge/hooks/bridge-end-hook.sh" }]
      }
    ]
  }
}
```

Replace `/Users/YOU/cc-bridge` with the actual path.

### 3. Register the MCP server

```bash
claude mcp add --transport sse --scope user bridge "http://localhost:7400/sse"
```

`--scope user` makes it available to all Claude Code sessions globally.

### 4. Add protocol docs to Claude's context

```bash
cat ~/cc-bridge/BRIDGE.md >> ~/.claude/CLAUDE.md
```

### 5. Start the bridge

```bash
node ~/cc-bridge/bridge-server.mjs
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CC_BRIDGE_PORT` | `7400` | Port for bridge server (env var or `--port` flag) |
| `CC_BRIDGE_SESSION` | auto-generated | Override session name for a specific terminal |

**Auto-generated names** follow the pattern `<dirname>-<4hex>`, e.g. `my-project-a3f1`. Set `CC_BRIDGE_SESSION` in your shell profile for stable names:

```bash
# In a dedicated terminal for API work:
export CC_BRIDGE_SESSION=api-builder
```

**Port override** via flag:

```bash
node bridge-server.mjs --port 8888
```

## Running as a background service

Simple:
```bash
nohup node bridge-server.mjs > /tmp/cc-bridge.log 2>&1 &
```

Recommended: keep it in a visible terminal tab so you can watch the log. The log shows registrations, questions, answers, and disconnections in real time.

## How sessions register

### Automatic flow

1. **SessionStart hook** fires when Claude Code starts. Generates a name (from cwd + random hex or `CC_BRIDGE_SESSION`), writes it to `/tmp/cc-bridge-<session_id>.name`, and prints a registration prompt.
2. **UserPromptSubmit hook** fires on every user message. If the session isn't registered yet, it injects a high-priority "REGISTER FIRST" instruction. Claude calls `register()` before doing anything else.
3. **One-time confirmation** -- after registration, the next prompt shows: "You're registered as X. Other sessions: Y, Z." This message appears once per session (tracked by a stamp file).

### Renaming

Call `register()` again with a new name and the same `claude_session_id`. The bridge:
- Retires the old name from the session registry
- Fails any in-flight `ask()` calls targeting the old name with an explanatory message
- Updates the name file on disk

### Reconnection

If the bridge restarts or SSE drops, the PostToolUse hook detects "not registered anymore" via `/whoami` and prompts Claude to re-register. The UserPromptSubmit hook also checks on every user message. Both paths are automatic.

## How questions get delivered

Three-layer delivery system:

| Layer | When it fires | Coverage |
|---|---|---|
| **PostToolUse hook** | After every tool call | Active sessions -- ~80% of cases |
| **Stop hook** | When Claude finishes a turn, about to go idle | Just-finished sessions -- ~15% more |
| **Manual poke** | User sends any message to the session | Deeply idle sessions -- remaining ~5% |

The gap: if a session has been idle for a long time (no tool calls, no user messages) and a new question arrives, the user must poke that session with any message. The Stop hook then fires and catches the pending question.

## MCP tools reference

| Tool | Parameters | Behavior |
|---|---|---|
| `register` | `name` (required), `description`, `claude_session_id` | Registers session. Name must be unique among active sessions. Handles rename cleanup. |
| `list_sessions` | (none) | Returns all active sessions with names and descriptions. |
| `ask` | `to` (required), `question` (required) | Blocks until target replies (5min timeout). Deduplicates against thread history. |
| `reply` | `message_id` (required), `answer` (required) | Answers a pending question. Cannot re-answer. |
| `get_thread` | `with_session` (required) | Returns Q&A history between caller and named session. |
| `broadcast` | `content` (required), `append` (boolean) | Writes to caller's scratchpad (visible to all via `read_scratchpad`). |
| `read_scratchpad` | `session` (optional) | Reads one or all scratchpads. Omit session to read all. |

## REST endpoints reference

These are used by hook scripts, not by Claude directly.

| Endpoint | Method | Purpose |
|---|---|---|
| `/sse` | GET | SSE transport for MCP protocol |
| `/message?session=<id>` | POST | JSON-RPC 2.0 messages for MCP |
| `/pending?session=<name>` | GET | Pending questions for a session (formatted text) |
| `/whoami?session_id=<cid>` | GET | Resolve Claude session ID to bridge name |
| `/health` | GET | Server status, active sessions, message counts |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Session does not register | Bridge not running, or hooks not in settings.json | Check `curl localhost:7400/health`, verify hooks in `~/.claude/settings.json` |
| Questions not delivered | PostToolUse hook not configured, or session not registered | Check hook config, check `/health` for active sessions |
| "Name taken" error | Two sessions tried the same name | Use a different name, or wait for the other to disconnect |
| SSE drops after idle | Should not happen (25s keepalive) | Check server logs for errors, restart bridge |
| Bridge restart loses state | By design (in-memory, no persistence) | Sessions re-register automatically via hooks on next user message |
| Wrong name after rename | Old name file on disk | `register()` with `claude_session_id` updates both server and disk |
| Hook has no effect | Wrong hook path in settings.json | Run `./install.sh --check` to verify all paths |

## Uninstalling

### Automated

```bash
./install.sh --uninstall
```

### Manual

1. Remove bridge hooks from `~/.claude/settings.json` -- delete entries where `command` contains "bridge" from each hook event array
2. Remove MCP server: `claude mcp remove bridge`
3. Remove the "Bridge Communication Protocol" section from `~/.claude/CLAUDE.md`
4. Stop the bridge server process
5. Clean up temp files: `rm -f /tmp/cc-bridge-*`
