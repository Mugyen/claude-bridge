#!/bin/bash
# bridge-prompt-hook.sh — UserPromptSubmit hook for claude-bridge
#
# Behavior matrix:
#   - MCP not registered → silent (skip)
#   - Not registered yet → inject "register first" instruction
#   - Just became registered (no stamp file yet) → emit one-time confirmation,
#     listing this session's name + other active peers, then write a stamp file
#   - Already registered AND stamp exists → silent (no output)
#   - Was registered, but bridge says we're no longer active (restart, etc.)
#     → drop the stamp so the next confirmation fires after re-registration

PORT="${CC_BRIDGE_PORT:-7400}"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

# Skip if bridge MCP is not registered. Seed cache lazily for mid-session installs
# where SessionStart never ran.
MCP_FILE="/tmp/claude-bridge-${SESSION_ID}.mcp"
if [ ! -f "$MCP_FILE" ]; then
  if claude mcp list 2>/dev/null | grep -q "bridge"; then
    echo "yes" > "$MCP_FILE"
  else
    echo "no" > "$MCP_FILE"
    exit 0
  fi
fi
if [ "$(cat "$MCP_FILE")" = "no" ]; then
  exit 0
fi

# Liveness via the UNGATED ping. The full /health is token-gated when sharing is
# on (hub/spoke), so a -sf /health would 401 and wrongly suppress this hook —
# which is what stopped sessions auto-registering once a token was present
# (lesson #26). Registration state comes from /whoami (also ungated, keyed on
# session_id), not from scanning /health's session list.
curl -sf --max-time 1 "http://localhost:${PORT}/health/ping" >/dev/null 2>&1 || exit 0

STAMP="/tmp/claude-bridge-${SESSION_ID}.confirmed"

WHOAMI=$(curl -sf --max-time 1 "http://localhost:${PORT}/whoami?session_id=${SESSION_ID}" 2>/dev/null)
NAME=$(echo "$WHOAMI" | jq -r '.name // empty' 2>/dev/null)

if [ -n "$NAME" ]; then
  # Registered (the bridge knows this session_id). Confirm once.
  if [ -f "$STAMP" ]; then
    exit 0  # silent: already confirmed
  fi
  MSG="🔗 claude-bridge: You're registered as \"${NAME}\".
Use list_sessions() to see who else is online, get_thread(with_session=...), or ask(to=...) to interact. This message will not appear again unless your registration is lost."
  touch "$STAMP"
  jq -n --arg m "$MSG" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $m}}'
  exit 0
fi

# Not registered (the bridge doesn't know this session_id) — drop any stale stamp
# so the confirmation fires again after re-registration.
rm -f "$STAMP"

# Not registered → inject "register first" instruction
NAME_FILE="/tmp/claude-bridge-${SESSION_ID}.name"
if [ -f "$NAME_FILE" ]; then
  SUGGESTED=$(cat "$NAME_FILE")
else
  DIR_NAME=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
  SUFFIX=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
  SUGGESTED="${DIR_NAME}-${SUFFIX}"
fi

MSG="🔗 claude-bridge: This session is not yet registered with the bridge. BEFORE responding to the user's message above, your FIRST action MUST be to call:

  register(name=\"${SUGGESTED}\", description=\"<short description of what you're working on, inferred from context>\", claude_session_id=\"${SESSION_ID}\")

Only after register() succeeds should you continue with the user's request. The user expects this to happen silently and automatically — do not ask permission, just register and proceed.

(The suggested name \"${SUGGESTED}\" is based on the cwd; you may pick a better one if you prefer.)"

jq -n --arg m "$MSG" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $m}}'
exit 0
