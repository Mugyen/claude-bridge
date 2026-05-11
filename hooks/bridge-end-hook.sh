#!/bin/bash
# bridge-end-hook.sh — SessionEnd hook for cc-bridge
#
# Cleans up the temp files when a session ends.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

[ -z "$SESSION_ID" ] && exit 0

rm -f "/tmp/cc-bridge-${SESSION_ID}.name" "/tmp/cc-bridge-${SESSION_ID}.confirmed" "/tmp/cc-bridge-${SESSION_ID}.mcp"

exit 0
