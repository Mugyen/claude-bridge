#!/bin/bash
# Tests ./install.sh --start | --stop | --restart on a non-default port so we
# don't disturb the real bridge.

set -u
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=7404
export CC_BRIDGE_PORT="$PORT"

PASS=0
FAIL=0
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }

cleanup() { lsof -ti:"$PORT" 2>/dev/null | xargs kill 2>/dev/null; rm -f /tmp/claude-bridge.pid; }
trap cleanup EXIT

cleanup

# Start
OUT=$("$REPO_DIR/install.sh" --start 2>&1)
sleep 1
if echo "$OUT" | grep -q "Bridge started"; then
  pass "--start launches the bridge"
else
  fail "--start did not report success (got: $OUT)"
fi

if curl -sf --max-time 1 "http://localhost:$PORT/health" >/dev/null 2>&1; then
  pass "health endpoint responds after --start"
else
  fail "health endpoint did not respond after --start"
fi

if [ -f /tmp/claude-bridge.pid ]; then
  pass "PID file written"
else
  fail "PID file not written"
fi

# Start again (idempotent — should detect already-running)
OUT=$("$REPO_DIR/install.sh" --start 2>&1)
if echo "$OUT" | grep -q "already running"; then
  pass "--start is idempotent (detects already-running)"
else
  fail "--start did not detect already-running (got: $OUT)"
fi

# EADDRINUSE regression (P1): a second server launched directly on the busy port
# must EXIT, not become a headless orphan that never binds and never dies.
node "$REPO_DIR/bridge-server.mjs" >> /tmp/claude-bridge-eaddr-test.log 2>&1 &
dup_pid=$!
sleep 2
dup_state=$(ps -o state= -p "$dup_pid" 2>/dev/null | tr -d ' ')
case "$dup_state" in
  ""|Z*) pass "second server on a busy port exits instead of orphaning (EADDRINUSE handled)" ;;
  *)     fail "second server still alive on busy port (state=$dup_state) — orphan leak"; kill "$dup_pid" 2>/dev/null ;;
esac
wait "$dup_pid" 2>/dev/null
rm -f /tmp/claude-bridge-eaddr-test.log

# Stop
OUT=$("$REPO_DIR/install.sh" --stop 2>&1)
sleep 1
if echo "$OUT" | grep -q "Bridge stopped"; then
  pass "--stop reports success"
else
  fail "--stop did not report success (got: $OUT)"
fi

if curl -sf --max-time 1 "http://localhost:$PORT/health" >/dev/null 2>&1; then
  fail "health endpoint still responds after --stop"
else
  pass "health endpoint stops responding after --stop"
fi

# Restart on a clean state
OUT=$("$REPO_DIR/install.sh" --restart 2>&1)
sleep 1
if curl -sf --max-time 1 "http://localhost:$PORT/health" >/dev/null 2>&1; then
  pass "--restart leaves the bridge running"
else
  fail "--restart did not leave the bridge running (got: $OUT)"
fi

# Final stop for cleanup
"$REPO_DIR/install.sh" --stop >/dev/null 2>&1

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
