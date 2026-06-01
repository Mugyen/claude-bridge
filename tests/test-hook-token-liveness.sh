#!/bin/bash
# Regression: hooks must probe liveness via the UNGATED /health/ping, never the
# token-gated /health. When sharing is on (a token is present — hub OR spoke), a
# `curl -sf /health` returns 401, which used to make the hooks conclude "bridge
# down" and silently bail → sessions stopped auto-registering AND stopped getting
# the idle-listener (Monitor) nudge. This starts a TOKEN-BEARING bridge and
# asserts the SessionStart / UserPromptSubmit / PostToolUse hooks still emit their
# register nudges. (lesson #26)

set -u
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=7409; FED=$((PORT+1))
TMP=$(mktemp -d)
SID="HOOKTOK-$$"
PASS=0; FAIL=0
pass(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
fail(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
cleanup(){ [ -n "${BRIDGE_PID:-}" ] && kill "$BRIDGE_PID" 2>/dev/null; rm -rf "$TMP" /tmp/claude-bridge-${SID}.*; }
trap cleanup EXIT

lsof -ti:$PORT -ti:$FED 2>/dev/null | xargs kill 2>/dev/null; sleep 0.3

# Token present ⇒ sharing on ⇒ /health is gated. role=hub so it binds locally only.
printf '%s' "tok-hooktest-123" > "$TMP/token"; printf hub > "$TMP/role"; : > "$TMP/hub"; printf testnode > "$TMP/node"
CC_BRIDGE_PORT=$PORT CC_BRIDGE_FED_PORT=$FED \
  CC_BRIDGE_TOKEN_FILE="$TMP/token" CC_BRIDGE_ROLE_FILE="$TMP/role" \
  CC_BRIDGE_HUB_FILE="$TMP/hub" CC_BRIDGE_NODE_FILE="$TMP/node" \
  node "$REPO_DIR/bridge-server.mjs" >/dev/null 2>&1 &
BRIDGE_PID=$!
sleep 1.5

# Sanity: sharing on → /health 401, /health/ping open.
curl -sf -m2 "http://localhost:$PORT/health" >/dev/null 2>&1 \
  && fail "/health should be 401 when sharing on" || pass "/health is token-gated (the trap the hooks must avoid)"
curl -sf -m2 "http://localhost:$PORT/health/ping" >/dev/null 2>&1 \
  && pass "/health/ping is open (what the hooks now use)" || fail "/health/ping should be open"

echo yes > "/tmp/claude-bridge-${SID}.mcp"   # MCP registered ⇒ skip the `claude mcp list` call

OUT=$(echo "{\"session_id\":\"$SID\",\"cwd\":\"/tmp/demoproj\",\"source\":\"startup\"}" | CC_BRIDGE_PORT=$PORT "$REPO_DIR/hooks/bridge-start-hook.sh" 2>&1)
echo "$OUT" | grep -q "register(" \
  && pass "SessionStart emits the register nudge against a token-bearing bridge" \
  || fail "SessionStart silently bailed (token bridge): '$OUT'"

OUT=$(echo "{\"session_id\":\"$SID\"}" | CC_BRIDGE_PORT=$PORT "$REPO_DIR/hooks/bridge-prompt-hook.sh" 2>&1)
echo "$OUT" | grep -q "register(" \
  && pass "UserPromptSubmit emits the register instruction against a token-bearing bridge" \
  || fail "UserPromptSubmit silently bailed (token bridge): '$OUT'"

OUT=$(echo "{\"session_id\":\"$SID\",\"tool_name\":\"Read\"}" | CC_BRIDGE_PORT=$PORT "$REPO_DIR/hooks/bridge-hook.sh" 2>&1)
echo "$OUT" | grep -q "register(" \
  && pass "PostToolUse emits a register nudge against a token-bearing bridge" \
  || fail "PostToolUse silently bailed (token bridge): '$OUT'"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
