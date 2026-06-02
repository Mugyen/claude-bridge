#!/bin/bash
# bridge-stop-hook.sh — Stop hook for claude-bridge
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

# Resolve canonical name (same logic as PostToolUse hook)
WHOAMI=$(curl -sf --max-time 1 "http://localhost:${PORT}/whoami?session_id=${SESSION_ID}" 2>/dev/null)
SESSION=$(echo "$WHOAMI" | jq -r '.name // empty' 2>/dev/null)

if [ -z "$SESSION" ]; then
  NAME_FILE="/tmp/claude-bridge-${SESSION_ID}.name"
  [ -f "$NAME_FILE" ] || exit 0
  SESSION=$(cat "$NAME_FILE")
fi
[ -z "$SESSION" ] && exit 0

# Any pending questions? If so, block and feed them back (highest priority).
PENDING=$(curl -sf --max-time 1 "http://localhost:${PORT}/pending?session=${SESSION}" 2>/dev/null)
if [ -n "$PENDING" ]; then
  # `decision: block` is the documented way to keep the model running with `reason`
  # as additional context.
  jq -n --arg r "$PENDING" '{decision: "block", reason: $r}'
  exit 0
fi

# ── Arm-enforcement (lesson #18, now enforced not just nudged) ────────────────
# An ENGAGED session (it asked or replied) that has NOT armed its idle-listener
# would silently miss any question arriving while it sits idle. The advisory
# PostToolUse nudge is reliably skipped by ASKERS — it arrives bundled with the
# answer they were waiting on, so the model treats it as FYI. At Stop the answer
# is already delivered, so this lands cleanly, and `decision: block` MAKES the
# agent act. Loop-safe: block at most ONCE per engagement episode (.armblocked
# marker, set here, cleared by the PostToolUse hook on the next ask/reply).
# Respects the .monitor stamp: "on" = already armed, "off" = user-disabled.
ENGAGED_FILE="/tmp/claude-bridge-${SESSION_ID}.engaged"
MONITOR_FILE="/tmp/claude-bridge-${SESSION_ID}.monitor"
ARMBLOCK_FILE="/tmp/claude-bridge-${SESSION_ID}.armblocked"
MONITOR_STATE=$(cat "$MONITOR_FILE" 2>/dev/null)
if [ -f "$ENGAGED_FILE" ] && [ "$MONITOR_STATE" != "on" ] && [ "$MONITOR_STATE" != "off" ] && [ ! -f "$ARMBLOCK_FILE" ]; then
  touch "$ARMBLOCK_FILE"
  INTERVAL="${CC_BRIDGE_MONITOR_INTERVAL:-25}"
  REASON="🔗 claude-bridge: You engaged on the bridge (asked or replied) but have NOT armed your idle-listener — so any question that arrives while you sit idle will be MISSED until the user pokes you. Arm it NOW before finishing:

→ Call the Monitor tool with persistent: true, description: \"incoming bridge messages for ${SESSION}\", and this exact command. Arm only ONE — if a bridge monitor is already running for this session, TaskStop it first:

prev=\"\"
while true; do
  out=\$(curl -sf \"http://localhost:${PORT}/pending?claude_session_id=${SESSION_ID}&peek=1\" 2>/dev/null || true)
  if [ -n \"\$out\" ]; then
    ids=\$(printf '%s' \"\$out\" | grep -o 'id: [a-z0-9-]*' | sort)
    if [ \"\$ids\" != \"\$prev\" ]; then
      printf '%s\\n' \"\$out\" | grep -E 'Question from|NEW QUESTION|NOTICE from|id:'
      prev=\"\$ids\"
    fi
  fi
  sleep ${INTERVAL}
done

This costs ZERO tokens while your inbox is empty — the loop only wakes you when a NEW message id appears; then call check_inbox().
The instant the Monitor is running, run:  echo on > ${MONITOR_FILE}
Then tell the user one line, e.g. \"Armed bridge idle-listener (polling ${INTERVAL}s).\"
(If you genuinely don't want it:  echo off > ${MONITOR_FILE}  to disable auto-arm for this session.)"
  jq -n --arg r "$REASON" '{decision: "block", reason: $r}'
  exit 0
fi

exit 0
