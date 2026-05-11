#!/bin/bash
# bridge-stop-hook.sh — Stop hook for cc-bridge
#
# Fires when Claude finishes responding (about to go idle). If there are pending
# bridge questions for this session, blocks the stop and feeds the question back
# into Claude so it replies before truly going idle.
#
# Without this, Claude finishes a turn → idle → no PostToolUse fires →
# pending question sits in the queue until the user pokes the session.

PORT="${CC_BRIDGE_PORT:-7400}"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

[ -z "$SESSION_ID" ] && exit 0

# Skip if bridge MCP is not registered (session predates install or MCP removed)
MCP_FILE="/tmp/cc-bridge-${SESSION_ID}.mcp"
if [ -f "$MCP_FILE" ] && [ "$(cat "$MCP_FILE")" = "no" ]; then
  exit 0
fi

# Resolve canonical name (same logic as PostToolUse hook)
WHOAMI=$(curl -sf --max-time 1 "http://localhost:${PORT}/whoami?session_id=${SESSION_ID}" 2>/dev/null)
SESSION=$(echo "$WHOAMI" | jq -r '.name // empty' 2>/dev/null)

if [ -z "$SESSION" ]; then
  NAME_FILE="/tmp/cc-bridge-${SESSION_ID}.name"
  [ -f "$NAME_FILE" ] || exit 0
  SESSION=$(cat "$NAME_FILE")
fi
[ -z "$SESSION" ] && exit 0

# Any pending questions?
PENDING=$(curl -sf --max-time 1 "http://localhost:${PORT}/pending?session=${SESSION}" 2>/dev/null)
[ -z "$PENDING" ] && exit 0

# Block stop and feed the question to Claude. The JSON `decision: block` form is
# the documented way to keep the model running with `reason` as additional context.
jq -n --arg r "$PENDING" '{decision: "block", reason: $r}'
exit 0
