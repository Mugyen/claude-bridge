#!/bin/bash
# bridge-start-hook.sh — SessionStart hook for claude-bridge
#
# Auto-generates a session name, stores it, and instructs Claude to register.
# No env vars needed — uses session_id from stdin to key the temp file.
#
# Requires: jq, curl

PORT="${CC_BRIDGE_PORT:-7400}"

# Read hook input from stdin
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')

[ -z "$SESSION_ID" ] && exit 0

# Check if bridge MCP is registered — cache for other hooks
MCP_FILE="/tmp/claude-bridge-${SESSION_ID}.mcp"
if claude mcp list 2>/dev/null | grep -q "bridge"; then
  echo "yes" > "$MCP_FILE"
else
  echo "no" > "$MCP_FILE"
  exit 0
fi

# A background Monitor (idle-listener) dies with the old process on a
# restart/resume, but its /tmp stamp survives. If this session had it armed
# ("on"), flip the stamp to "rearm" so the PostToolUse hook re-nudges the agent
# to start a fresh Monitor on its next tool call (with the correctly-resolved
# name). "off" (user-disabled) and absent (never armed) are left untouched.
MONITOR_FILE="${CC_BRIDGE_WAKE_DIR:-/tmp/claude/cc-bridge}/${SESSION_ID}.monitor"
# Back-compat: an "on" flag from the previous build may still be at the old path.
if [ ! -f "$MONITOR_FILE" ] && [ -f "/tmp/claude-bridge-${SESSION_ID}.monitor" ]; then
  mkdir -p "$(dirname "$MONITOR_FILE")" 2>/dev/null
  mv "/tmp/claude-bridge-${SESSION_ID}.monitor" "$MONITOR_FILE" 2>/dev/null
fi
if [ "$(cat "$MONITOR_FILE" 2>/dev/null)" = "on" ]; then
  echo "rearm" > "$MONITOR_FILE"
fi

# Check if bridge is running — if not, skip silently. Use the UNGATED /health/ping:
# the full /health is TOKEN-GATED when sharing is on (hub OR spoke), so a `-sf`
# probe of /health returns 401 and would make this hook wrongly conclude "bridge
# down" and skip the registration nudge — which is exactly what stops sessions
# auto-registering once a token is present (lesson #26).
if ! curl -sf --max-time 1 "http://localhost:${PORT}/health/ping" > /dev/null 2>&1; then
  exit 0
fi

NAME_FILE="/tmp/claude-bridge-${SESSION_ID}.name"

# If resuming and name file exists, reuse the existing name
if [ -f "$NAME_FILE" ]; then
  BRIDGE_NAME=$(cat "$NAME_FILE")
  echo ""
  echo "🔗 claude-bridge: Reconnecting as \"${BRIDGE_NAME}\""
  echo "→ Call register(name=\"${BRIDGE_NAME}\", description=\"what you're working on\", claude_session_id=\"${SESSION_ID}\") to rejoin the bridge."
  echo "  IMPORTANT: pass claude_session_id exactly as shown — it lets the hook find your registered name if you rename later."
  echo "→ Then call list_sessions() to see who else is connected."
  echo ""
  exit 0
fi

# Generate a unique session name: directory-name + 4 random hex chars
# Or use CC_BRIDGE_SESSION env var if set (for friendly names)
if [ -n "${CC_BRIDGE_SESSION:-}" ]; then
  BRIDGE_NAME="$CC_BRIDGE_SESSION"
else
  DIR_NAME=$(basename "${CWD:-$PWD}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
  SUFFIX=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
  BRIDGE_NAME="${DIR_NAME}-${SUFFIX}"
fi

# Store for PostToolUse hook to read
echo "$BRIDGE_NAME" > "$NAME_FILE"

# Print into Claude's context — Claude will see this and act on it
echo ""
echo "🔗 claude-bridge: Your default session name is \"${BRIDGE_NAME}\""
echo "→ Call register(name=\"${BRIDGE_NAME}\", description=\"brief description of your current task\", claude_session_id=\"${SESSION_ID}\") as your FIRST action."
echo "  IMPORTANT: pass claude_session_id exactly as shown — it lets the hook find your registered name even if you later rename."
echo "  You may pick a different friendly name if you prefer (e.g. \"frontend\"); just call register again with the new name and the same claude_session_id."
echo "→ Then call list_sessions() to see who else is connected."
echo "→ If other sessions are connected, call read_scratchpad() to check for shared context."
echo ""

exit 0
