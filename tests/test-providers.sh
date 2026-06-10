#!/bin/bash
# Provider-dispatch tests. Fake binaries on PATH; NEVER touches real tunnel state.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$DIR")"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"; pkill -f "[f]ake-tunnel-sleeper" 2>/dev/null || true' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

# Isolation: every run uses a scratch HOME + scratch tunnel state + port 7497.
export HOME="$WORK/home"; mkdir -p "$HOME/.claude"
export CC_BRIDGE_PORT=7497
export CC_BRIDGE_TUNNEL_PID="$WORK/tunnel.pid"
export CC_BRIDGE_TUNNEL_URL="$WORK/tunnel.url"
export CC_BRIDGE_TUNNEL_LOG="$WORK/tunnel.log"
export CC_BRIDGE_TUNNEL_PROVIDER="$WORK/tunnel.provider"
export CC_BRIDGE_SPOKE_PIPE_PID="$WORK/pipe.pid"
export CC_BRIDGE_SPOKE_PIPE_PORT="$WORK/pipe.port"
export CC_BRIDGE_SPOKE_PIPE_TICKET="$WORK/pipe.ticket"
export CC_BRIDGE_NO_AUTOINSTALL=1
export PATH="$WORK/bin:$PATH"; mkdir -p "$WORK/bin"

# ── Case 1: stop-share kills the recorded PID, verifies death, clears ALL state files
sleep 300 & SLEEPER=$!
echo "$SLEEPER" > "$WORK/tunnel.pid"
echo "https://example.test" > "$WORK/tunnel.url"
echo "cloudflared-quick" > "$WORK/tunnel.provider"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
sleep 0.5
if kill -0 "$SLEEPER" 2>/dev/null; then bad "stop-share: tunnel process still alive"; kill -9 "$SLEEPER"; else ok "stop-share: tunnel process killed"; fi
[ ! -f "$WORK/tunnel.pid" ] && [ ! -f "$WORK/tunnel.url" ] && [ ! -f "$WORK/tunnel.provider" ] \
  && ok "stop-share: state files cleared" || bad "stop-share: state files remain"

echo ""; echo "test-providers: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
