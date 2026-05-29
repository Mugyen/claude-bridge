#!/bin/bash
# bridge-hook.sh — PostToolUse hook for claude-bridge
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
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# Skip if bridge MCP is not registered (session predates install or MCP removed).
# Seed the cache lazily for sessions that started before SessionStart could run
# (mid-session installs). Cost: one `claude mcp list` call the first time the
# hook fires in such a session, then cached for the rest of it.
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

# Helper: emit a PostToolUse JSON output that injects $1 as additionalContext
emit_context() {
  local msg="$1"
  jq -n --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
}

# Resolve canonical name. Bridge is the source of truth.
WHOAMI=$(curl -sf --max-time 1 "http://localhost:${PORT}/whoami?session_id=${SESSION_ID}" 2>/dev/null)
SESSION=$(echo "$WHOAMI" | jq -r '.name // empty' 2>/dev/null)

if [ -z "$SESSION" ]; then
  NAME_FILE="/tmp/claude-bridge-${SESSION_ID}.name"
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
    MSG="🔗 claude-bridge: This session needs to register (or re-register) with claude_session_id.
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
    MSG="🔗 claude-bridge: Your registration was lost (likely an SSE reconnect or bridge restart).
→ Call register(name=\"${SESSION}\", description=\"...\", claude_session_id=\"${SESSION_ID}\") to reconnect."
    emit_context "$MSG"
    exit 0
  fi
fi

# ── Assemble the context to inject: pending questions, plus a one-time nudge to
#    arm the idle-listener once this session starts asking/replying. ───────────
MSG=""

# Pending questions for this session?
PENDING=$(curl -sf --max-time 1 "http://localhost:${PORT}/pending?session=${SESSION}" 2>/dev/null)
[ -n "$PENDING" ] && MSG="$PENDING"

# Auto-arm the idle-listener. Once a session engages by asking or replying, it
# should keep listening so it can answer questions that land while it sits idle
# (the PostToolUse/Stop hooks only fire during active work, never when dormant).
# The Monitor tool is the only primitive that can wake a dormant agent, so we
# nudge the agent to arm it. State file holds the auto-run setting:
#   absent → eligible   on → agent armed it   off → user disabled
# CRITICAL: the hook does NOT write "on" — the AGENT writes it only once it has
# actually armed the Monitor. So while the file is absent/"rearm", the hook
# re-nudges until the listener is genuinely up. A nudge the agent ignores is
# retried, instead of being silently lost forever. Stamp states:
#   absent → eligible (nudge on ask/reply)   on → armed   off → user disabled
#   rearm  → was armed before a restart/resume; re-nudge on ANY tool call so the
#            listener comes back even if the session doesn't ask/reply again.
MONITOR_FILE="/tmp/claude-bridge-${SESSION_ID}.monitor"
MONITOR_STATE=$(cat "$MONITOR_FILE" 2>/dev/null)
NUDGE_MONITOR=0
case "$MONITOR_STATE" in
  on|off) ;;                                  # armed, or user-disabled → stay quiet
  rearm)  NUDGE_MONITOR=1 ;;                   # resumed while armed → re-arm on any tool
  *) case "$TOOL" in mcp__bridge__ask|mcp__bridge__reply) NUDGE_MONITOR=1 ;; esac ;;
esac
if [ "$NUDGE_MONITOR" = 1 ]; then
      INTERVAL="${CC_BRIDGE_MONITOR_INTERVAL:-25}"
      NUDGE="🔗 claude-bridge: You're now active on the bridge. Arm your idle-listener so you can answer questions that arrive while you sit idle — without it, a dormant session never sees new questions until the user pokes it. (This reminder repeats on every ask/reply until you actually arm it.)

→ Call the Monitor tool NOW with persistent: true, description: \"incoming bridge messages for ${SESSION}\", and this exact command:

prev=\"\"
while true; do
  out=\$(curl -sf \"http://localhost:${PORT}/pending?session=${SESSION}&peek=1\" 2>/dev/null || true)
  if [ -n \"\$out\" ]; then
    ids=\$(printf '%s' \"\$out\" | grep -o 'id: [a-z0-9-]*' | sort)
    if [ \"\$ids\" != \"\$prev\" ]; then
      printf '%s\\n' \"\$out\" | grep -E 'Question from|NEW QUESTION|NOTICE from|id:'
      prev=\"\$ids\"
    fi
  fi
  sleep ${INTERVAL}
done

This costs ZERO tokens while your inbox is empty — the loop runs in the shell and only wakes you when a NEW message id appears.
When it wakes you, call check_inbox() to read what arrived — a question to answer, or a 📨 NOTICE to simply take in (notices appear in the notices list; do NOT reply to them).
IMPORTANT: the instant the Monitor is running, run this so the reminder stops:  echo on > ${MONITOR_FILE}
Then tell the user one line, e.g. \"Armed bridge idle-listener (polling ${INTERVAL}s).\"
To CLOSE it later (user says \"stop the bridge listener\"): TaskStop the monitor, then run  echo off > ${MONITOR_FILE}  to disable auto-run for this session.
To RE-ENABLE: run  rm -f ${MONITOR_FILE}  then arm it again (or just ask/reply once more)."
  if [ -n "$MSG" ]; then
    MSG="${MSG}
${NUDGE}"
  else
    MSG="$NUDGE"
  fi
fi

[ -z "$MSG" ] && exit 0
emit_context "$MSG"
exit 0
