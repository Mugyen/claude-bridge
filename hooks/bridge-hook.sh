#!/bin/bash
# bridge-hook.sh — PostToolUse hook for cc-bridge
#
# Checks the bridge for pending questions addressed to this session and feeds
# them into Claude's context as `additionalContext` (the only mechanism by which
# PostToolUse hook output reaches the model — plain stdout is silent).
#
# Reads session_id from hook input (JSON on stdin). Resolves canonical session
# name via the bridge's /whoami endpoint, falling back to the local name file.

PORT="${CC_BRIDGE_PORT:-7400}"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

# Helper: emit a PostToolUse JSON output that injects $1 as additionalContext
emit_context() {
  local msg="$1"
  jq -n --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
}

# Resolve canonical name. Bridge is the source of truth.
WHOAMI=$(curl -sf --max-time 1 "http://localhost:${PORT}/whoami?session_id=${SESSION_ID}" 2>/dev/null)
SESSION=$(echo "$WHOAMI" | jq -r '.name // empty' 2>/dev/null)

if [ -z "$SESSION" ]; then
  NAME_FILE="/tmp/cc-bridge-${SESSION_ID}.name"
  if [ -f "$NAME_FILE" ]; then
    SESSION=$(cat "$NAME_FILE")
  fi
fi

# Not registered yet — prompt registration with claude_session_id.
if [ -z "$SESSION" ]; then
  HEALTH=$(curl -sf --max-time 1 "http://localhost:${PORT}/health" 2>/dev/null)
  if [ -n "$HEALTH" ]; then
    DIR_NAME=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
    SUFFIX=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
    SUGGESTED="${DIR_NAME}-${SUFFIX}"
    MSG="🔗 cc-bridge: This session needs to register (or re-register) with claude_session_id.
Your claude_session_id is: ${SESSION_ID}
→ If you ALREADY registered under a name in this conversation, call register() AGAIN with the SAME name plus claude_session_id=\"${SESSION_ID}\". This refreshes the bridge mapping without changing your identity.
→ Otherwise, register fresh: register(name=\"${SUGGESTED}\", description=\"<what you're working on>\", claude_session_id=\"${SESSION_ID}\")
IMPORTANT: pass claude_session_id exactly as shown so the bridge can find you later."
    emit_context "$MSG"
  fi
  exit 0
fi

# Self-heal: if bridge no longer lists us, re-register.
HEALTH=$(curl -sf --max-time 1 "http://localhost:${PORT}/health" 2>/dev/null)
if [ -n "$HEALTH" ]; then
  IS_REGISTERED=$(echo "$HEALTH" | jq -r --arg n "$SESSION" '.sessions | map(select(.name == $n)) | length' 2>/dev/null)
  if [ "$IS_REGISTERED" = "0" ]; then
    MSG="🔗 cc-bridge: Your registration was lost (likely an SSE reconnect or bridge restart).
→ Call register(name=\"${SESSION}\", description=\"...\", claude_session_id=\"${SESSION_ID}\") to reconnect."
    emit_context "$MSG"
    exit 0
  fi
fi

# Pending questions for this session?
PENDING=$(curl -sf --max-time 1 "http://localhost:${PORT}/pending?session=${SESSION}" 2>/dev/null)
[ -z "$PENDING" ] && exit 0

emit_context "$PENDING"
exit 0
