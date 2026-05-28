#!/bin/bash
# Verify the PostToolUse hook auto-arms the idle-listener correctly.
#
# Trigger: the hook nudges the agent to arm a background Monitor ONLY after the
# session engages by calling ask or reply — and only once. The per-session state
# file /tmp/claude-bridge-${SESSION_ID}.monitor records the auto-run setting:
#   absent → eligible    on → armed (don't re-nudge)    off → user disabled
#
# These run WITHOUT a live bridge: the hook resolves its name from the .name
# fallback file (the bridge /whoami call fails), and /pending returns nothing,
# so the only possible output is the arm-listener nudge itself.

set -u
# Point at a port with no bridge so name resolution falls back to the .name file
# and the self-heal / pending branches stay quiet — isolates the arm-nudge logic
# from any live bridge on the default 7400.
export CC_BRIDGE_PORT=7499
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAKE_ID="MONITOR-TEST-$$"
MCP_FILE="/tmp/claude-bridge-${FAKE_ID}.mcp"
NAME_FILE="/tmp/claude-bridge-${FAKE_ID}.name"
MONITOR_FILE="/tmp/claude-bridge-${FAKE_ID}.monitor"
HOOK="$REPO_DIR/hooks/bridge-hook.sh"

PASS=0
FAIL=0
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
trap "rm -f /tmp/claude-bridge-${FAKE_ID}.*" EXIT

# MCP present so the hook doesn't short-circuit; .name lets it resolve a session
# name without a running bridge.
echo "yes" > "$MCP_FILE"
echo "monitortest" > "$NAME_FILE"

# Build hook input JSON for a given tool name.
input_for() { printf '{"session_id":"%s","tool_name":"%s"}' "$FAKE_ID" "$1"; }

run() { input_for "$1" | "$HOOK" 2>&1; }

# ── Case 1: register does NOT trigger (only ask/reply do) ────────────────────
rm -f "$MONITOR_FILE"
OUT=$(run "mcp__bridge__register")
if [ -z "$OUT" ] && [ ! -f "$MONITOR_FILE" ]; then
  pass "register → no nudge, no state file"
else
  fail "register should not arm: output='$OUT' state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi

# ── Case 2: list_sessions does NOT trigger ───────────────────────────────────
rm -f "$MONITOR_FILE"
OUT=$(run "mcp__bridge__list_sessions")
if [ -z "$OUT" ] && [ ! -f "$MONITOR_FILE" ]; then
  pass "list_sessions → no nudge, no state file"
else
  fail "list_sessions should not arm: output='$OUT'"
fi

# ── Case 3: reply (state absent) → nudges, but the HOOK does NOT write state ──
#    (the agent writes "on" only once it actually arms; see case 5)
rm -f "$MONITOR_FILE"
OUT=$(run "mcp__bridge__reply")
if echo "$OUT" | grep -q "idle-listener" && echo "$OUT" | grep -q "Monitor" \
   && [ ! -f "$MONITOR_FILE" ]; then
  pass "reply (eligible) → nudges to arm Monitor, hook leaves state unwritten"
else
  fail "reply should nudge without writing state: output='$OUT' state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi

# ── Case 4: reply AGAIN while still un-armed → re-nudges (not lost forever) ──
OUT=$(run "mcp__bridge__reply")
if echo "$OUT" | grep -q "idle-listener" && [ ! -f "$MONITOR_FILE" ]; then
  pass "reply (still un-armed) → re-nudges until the agent actually arms it"
else
  fail "reply should re-nudge while un-armed: output='$OUT' state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi

# ── Case 5: agent armed it (wrote "on") → reply → silent ─────────────────────
echo "on" > "$MONITOR_FILE"
OUT=$(run "mcp__bridge__reply")
if [ -z "$OUT" ] && [ "$(cat "$MONITOR_FILE" 2>/dev/null)" = "on" ]; then
  pass "reply (agent armed, state='on') → silent, no re-nudge"
else
  fail "reply when armed should be silent: output='$OUT'"
fi

# ── Case 6: ask (state="off", user disabled) → silent, stays off ─────────────
echo "off" > "$MONITOR_FILE"
OUT=$(run "mcp__bridge__ask")
if [ -z "$OUT" ] && [ "$(cat "$MONITOR_FILE" 2>/dev/null)" = "off" ]; then
  pass "ask (disabled) → silent, state stays 'off' (no re-arm)"
else
  fail "ask when disabled should be silent: output='$OUT' state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi

# ── Case 7: re-enabled (file removed) → ask nudges again ─────────────────────
rm -f "$MONITOR_FILE"
OUT=$(run "mcp__bridge__ask")
if echo "$OUT" | grep -q "idle-listener" && [ ! -f "$MONITOR_FILE" ]; then
  pass "ask (re-enabled) → nudges to arm Monitor again"
else
  fail "ask should nudge after re-enable: output='$OUT' state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi

# ── Case 8: the emitted command names this session and the poll interval ─────
rm -f "$MONITOR_FILE"
OUT=$(CC_BRIDGE_MONITOR_INTERVAL=42 run "mcp__bridge__reply")
if echo "$OUT" | grep -q "session=monitortest" && echo "$OUT" | grep -q "sleep 42" \
   && echo "$OUT" | grep -q "echo on > $MONITOR_FILE"; then
  pass "nudge embeds session name, interval, and the 'echo on' arm-confirm step"
else
  fail "nudge should embed name + interval + arm-confirm: output='$OUT'"
fi

# ── Case 9: the armed Monitor command wakes on NOTICEs and PEEKS (no consume) ─
rm -f "$MONITOR_FILE"
OUT=$(run "mcp__bridge__reply")
if echo "$OUT" | grep -q "NOTICE from" && echo "$OUT" | grep -q "peek=1"; then
  pass "arm command greps 'NOTICE from' and peeks (peek=1) so it doesn't consume notices"
else
  fail "arm command should grep NOTICE from + use peek=1: output='$OUT'"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
