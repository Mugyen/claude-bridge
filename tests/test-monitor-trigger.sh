#!/bin/bash
# Verify the PostToolUse hook auto-arms the idle-listener correctly.
#
# Trigger: the hook nudges the agent to arm a background Monitor after the
# session engages by calling ask or reply. The per-session state file
# /tmp/claude-bridge-${SESSION_ID}.monitor records the auto-run setting:
#   absent → eligible (nudge on ask/reply)   on → armed (agent wrote it)
#   off → user disabled   rearm → was armed before a restart/resume; SessionStart
#   sets this so the PostToolUse hook re-arms on the NEXT tool call (any tool).
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

# ── Case 10: 'rearm' state (resumed while armed) → re-nudge on ANY tool call ──
#    (not just ask/reply) so the listener comes back after a restart/resume.
echo "rearm" > "$MONITOR_FILE"
OUT=$(run "mcp__bridge__list_sessions")
if echo "$OUT" | grep -q "idle-listener" && [ "$(cat "$MONITOR_FILE")" = "rearm" ]; then
  pass "rearm + non-engaging tool → re-nudges (any tool), stays 'rearm' until agent arms"
else
  fail "rearm should re-nudge on any tool: output='$OUT' state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi

# ── Case 11: 'rearm' goes silent once the agent actually arms (writes 'on') ──
echo "on" > "$MONITOR_FILE"
OUT=$(run "mcp__bridge__list_sessions")
if [ -z "$OUT" ]; then
  pass "after agent arms (on), a non-engaging tool is silent"
else
  fail "armed state should be silent on any tool: output='$OUT'"
fi

# ── Case 12: SessionStart flips 'on' → 'rearm' (the resume fix) ──────────────
#    bridge-start-hook runs `claude mcp list` directly, so stub it as present.
START_STUB=$(mktemp -d)
cat > "$START_STUB/claude" <<'EOF'
#!/bin/sh
case "$1 $2" in
  "mcp list") echo "bridge: SSE → http://localhost:7499/sse"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$START_STUB/claude"
echo "on" > "$MONITOR_FILE"
input_for noop | PATH="$START_STUB:$PATH" "$REPO_DIR/hooks/bridge-start-hook.sh" >/dev/null 2>&1
if [ "$(cat "$MONITOR_FILE")" = "rearm" ]; then
  pass "SessionStart flips armed 'on' → 'rearm' so a resumed session re-arms"
else
  fail "SessionStart should flip on→rearm: state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi
# 'off' (user-disabled) must survive a SessionStart untouched
echo "off" > "$MONITOR_FILE"
input_for noop | PATH="$START_STUB:$PATH" "$REPO_DIR/hooks/bridge-start-hook.sh" >/dev/null 2>&1
if [ "$(cat "$MONITOR_FILE")" = "off" ]; then
  pass "SessionStart leaves user-disabled 'off' untouched"
else
  fail "SessionStart should not touch 'off': state='$(cat "$MONITOR_FILE" 2>/dev/null)'"
fi
rm -rf "$START_STUB"

# ── Stop-hook arm-enforcement (lesson #18 enforced) ──────────────────────────
# An engaged-but-unarmed session is blocked ONCE per engagement at turn-end so an
# asker can't silently skip arming. Runs without a live bridge (name from .name,
# /pending empty); enforcement keys purely on the marker files.
STOP_HOOK="$REPO_DIR/hooks/bridge-stop-hook.sh"
ENGAGED_FILE="/tmp/claude-bridge-${FAKE_ID}.engaged"
ARMBLOCK_FILE="/tmp/claude-bridge-${FAKE_ID}.armblocked"
stop_run() { printf '{"session_id":"%s"}' "$FAKE_ID" | "$STOP_HOOK" 2>&1; }

# Case 13: engaged + unarmed + no prior block → blocks to arm + marks .armblocked
rm -f "$MONITOR_FILE" "$ARMBLOCK_FILE"; touch "$ENGAGED_FILE"
OUT=$(stop_run)
if echo "$OUT" | grep -q '"decision"' && echo "$OUT" | grep -q "idle-listener" && [ -f "$ARMBLOCK_FILE" ]; then
  pass "Stop: engaged + unarmed → blocks turn-end to arm + sets .armblocked"
else
  fail "Stop should block engaged+unarmed: output='$OUT' armblock=$([ -f "$ARMBLOCK_FILE" ] && echo y || echo n)"
fi

# Case 14: second Stop in the SAME episode (.armblocked present) → no re-block (loop-safe)
OUT=$(stop_run)
[ -z "$OUT" ] && pass "Stop: second stop same episode → no re-block (loop-safe)" || fail "Stop should not re-block same episode: '$OUT'"

# Case 15: armed (on) → no block
rm -f "$ARMBLOCK_FILE"; echo on > "$MONITOR_FILE"
OUT=$(stop_run)
[ -z "$OUT" ] && pass "Stop: engaged but armed (on) → no block" || fail "Stop should not block when armed: '$OUT'"

# Case 16: disabled (off) → no block
echo off > "$MONITOR_FILE"
OUT=$(stop_run)
[ -z "$OUT" ] && pass "Stop: engaged but disabled (off) → no block" || fail "Stop should not block when off: '$OUT'"

# Case 17: not engaged → no block
rm -f "$MONITOR_FILE" "$ENGAGED_FILE" "$ARMBLOCK_FILE"
OUT=$(stop_run)
[ -z "$OUT" ] && pass "Stop: not engaged → no block" || fail "Stop should not block an unengaged session: '$OUT'"

# Case 18: PostToolUse ask/reply sets .engaged + clears .armblocked (re-enables enforcement)
rm -f "$MONITOR_FILE" "$ENGAGED_FILE"; touch "$ARMBLOCK_FILE"
run "mcp__bridge__reply" >/dev/null 2>&1
if [ -f "$ENGAGED_FILE" ] && [ ! -f "$ARMBLOCK_FILE" ]; then
  pass "PostToolUse ask/reply marks .engaged + clears .armblocked (re-arms Stop enforcement)"
else
  fail "reply should set engaged + clear armblock: engaged=$([ -f "$ENGAGED_FILE" ] && echo y || echo n) armblock=$([ -f "$ARMBLOCK_FILE" ] && echo y || echo n)"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
