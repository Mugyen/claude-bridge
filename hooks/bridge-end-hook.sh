#!/bin/bash
# bridge-end-hook.sh — SessionEnd hook for claude-bridge
#
# Cleans up the temp files when a session ends.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

[ -z "$SESSION_ID" ] && exit 0

WAKE_DIR="${CC_BRIDGE_WAKE_DIR:-/tmp/claude/cc-bridge}"
rm -f "/tmp/claude-bridge-${SESSION_ID}.name" "/tmp/claude-bridge-${SESSION_ID}.confirmed" "/tmp/claude-bridge-${SESSION_ID}.mcp" "/tmp/claude-bridge-${SESSION_ID}.monitor" "/tmp/claude-bridge-${SESSION_ID}.engaged" "/tmp/claude-bridge-${SESSION_ID}.armblocked" \
      "${WAKE_DIR}/${SESSION_ID}.monitor" "${WAKE_DIR}/${SESSION_ID}.wake"
# Legacy paths from the cc-bridge era — clean these up too
rm -f "/tmp/cc-bridge-${SESSION_ID}.name" "/tmp/cc-bridge-${SESSION_ID}.confirmed" "/tmp/cc-bridge-${SESSION_ID}.mcp"

exit 0
