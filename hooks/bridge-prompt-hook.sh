#!/bin/bash
# bridge-prompt-hook.sh — UserPromptSubmit hook for cc-bridge
#
# Behavior matrix:
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

HEALTH=$(curl -sf --max-time 1 "http://localhost:${PORT}/health" 2>/dev/null)
[ -z "$HEALTH" ] && exit 0

STAMP="/tmp/cc-bridge-${SESSION_ID}.confirmed"

WHOAMI=$(curl -sf --max-time 1 "http://localhost:${PORT}/whoami?session_id=${SESSION_ID}" 2>/dev/null)
NAME=$(echo "$WHOAMI" | jq -r '.name // empty' 2>/dev/null)

if [ -n "$NAME" ]; then
  IS_ACTIVE=$(echo "$HEALTH" | jq -r --arg n "$NAME" '.sessions | map(select(.name == $n)) | length' 2>/dev/null)
  if [ "$IS_ACTIVE" != "0" ]; then
    # We're registered and active. Have we already confirmed?
    if [ -f "$STAMP" ]; then
      exit 0  # silent: already confirmed
    fi

    # First confirmation — list peers (other active sessions)
    PEERS=$(echo "$HEALTH" | jq -r --arg me "$NAME" \
      '[.sessions[] | select(.name != $me) | "\"\(.name)\"" + (if .description != "" then " (\(.description))" else "" end)] | if length == 0 then "(none yet)" else join(", ") end' 2>/dev/null)

    MSG="🔗 cc-bridge: You're registered as \"${NAME}\".
Other sessions online: ${PEERS}.
Use list_sessions(), get_thread(with_session=...), or ask(to=...) to interact. This message will not appear again unless your registration is lost."

    touch "$STAMP"
    jq -n --arg m "$MSG" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $m}}'
    exit 0
  else
    # Registration was lost (bridge restart, SSE drop, etc.) — drop stamp so
    # the next confirmation fires after re-registration.
    rm -f "$STAMP"
  fi
fi

# Not registered → inject "register first" instruction
NAME_FILE="/tmp/cc-bridge-${SESSION_ID}.name"
if [ -f "$NAME_FILE" ]; then
  SUGGESTED=$(cat "$NAME_FILE")
else
  DIR_NAME=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
  SUFFIX=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
  SUGGESTED="${DIR_NAME}-${SUFFIX}"
fi

MSG="🔗 cc-bridge: This session is not yet registered with the bridge. BEFORE responding to the user's message above, your FIRST action MUST be to call:

  register(name=\"${SUGGESTED}\", description=\"<short description of what you're working on, inferred from context>\", claude_session_id=\"${SESSION_ID}\")

Only after register() succeeds should you continue with the user's request. The user expects this to happen silently and automatically — do not ask permission, just register and proceed.

(The suggested name \"${SUGGESTED}\" is based on the cwd; you may pick a better one if you prefer.)"

jq -n --arg m "$MSG" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $m}}'
exit 0
