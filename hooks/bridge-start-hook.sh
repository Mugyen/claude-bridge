#!/bin/bash
# bridge-start-hook.sh — SessionStart hook for cc-bridge
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
MCP_FILE="/tmp/cc-bridge-${SESSION_ID}.mcp"
if claude mcp list 2>/dev/null | grep -q "bridge"; then
  echo "yes" > "$MCP_FILE"
else
  echo "no" > "$MCP_FILE"
  exit 0
fi

# Check if bridge is running — if not, skip silently
if ! curl -sf --max-time 1 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
  exit 0
fi

NAME_FILE="/tmp/cc-bridge-${SESSION_ID}.name"

# If resuming and name file exists, reuse the existing name
if [ -f "$NAME_FILE" ]; then
  BRIDGE_NAME=$(cat "$NAME_FILE")
  echo ""
  echo "🔗 cc-bridge: Reconnecting as \"${BRIDGE_NAME}\""
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
echo "🔗 cc-bridge: Your default session name is \"${BRIDGE_NAME}\""
echo "→ Call register(name=\"${BRIDGE_NAME}\", description=\"brief description of your current task\", claude_session_id=\"${SESSION_ID}\") as your FIRST action."
echo "  IMPORTANT: pass claude_session_id exactly as shown — it lets the hook find your registered name even if you later rename."
echo "  You may pick a different friendly name if you prefer (e.g. \"frontend\"); just call register again with the new name and the same claude_session_id."
echo "→ Then call list_sessions() to see who else is connected."
echo "→ If other sessions are connected, call read_scratchpad() to check for shared context."
echo ""

exit 0
