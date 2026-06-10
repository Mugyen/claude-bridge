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

# Shared helper: start a throwaway bridge on 7497 with scratch fed-config files.
FED_ENV=(CC_BRIDGE_TOKEN_FILE="$HOME/.claude/.cc-bridge-token"
         CC_BRIDGE_ROLE_FILE="$HOME/.claude/.cc-bridge-role"
         CC_BRIDGE_HUB_FILE="$HOME/.claude/.cc-bridge-hub"
         CC_BRIDGE_NODE_FILE="$HOME/.claude/.cc-bridge-node")
start_test_bridge() {
  env "${FED_ENV[@]}" node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 &
  BRIDGE_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf --max-time 1 "http://localhost:7497/health/ping" >/dev/null 2>&1 && return 0
    sleep 0.3
  done
  echo "  ! test bridge failed to start"; return 1
}
stop_test_bridge() { kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null; }

# ── Case 2: share --provider cloudflared-quick uses the fake binary, records provider+URL
cat > "$WORK/bin/cloudflared" <<'FAKE'
#!/bin/bash
( sleep 1; echo "INF +-- https://fake-test.trycloudflare.com" >&2 )
exec sleep 300
FAKE
chmod +x "$WORK/bin/cloudflared"
start_test_bridge
"$REPO/claude-bridge" share --provider cloudflared-quick >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.provider" 2>/dev/null)" = "cloudflared-quick" ] \
  && ok "share: provider recorded" || bad "share: provider file wrong/missing (got: $(cat "$WORK/tunnel.provider" 2>/dev/null))"
grep -q "trycloudflare.com" "$WORK/tunnel.url" 2>/dev/null \
  && ok "share: URL extracted from fake" || bad "share: URL not extracted"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
stop_test_bridge

# ── Case 3: share --provider bore extracts bore.pub URL from fake
cat > "$WORK/bin/bore" <<'FAKE'
#!/bin/bash
( sleep 1; echo "2026-06-10 listening at bore.pub:34567" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/bore"
start_test_bridge
"$REPO/claude-bridge" share --provider bore >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "http://bore.pub:34567" ] \
  && ok "bore: URL extracted" || bad "bore: URL extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
stop_test_bridge

# ── Case 4: pinggy — fake ssh prints a pinggy URL; extractor picks the https one
cat > "$WORK/bin/ssh" <<'FAKE'
#!/bin/bash
( sleep 1; echo "http://abc123.a.free.pinggy.link"; echo "https://abc123.a.free.pinggy.link" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/ssh"
start_test_bridge
"$REPO/claude-bridge" share --provider pinggy >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "https://abc123.a.free.pinggy.link" ] \
  && ok "pinggy: https URL extracted" || bad "pinggy: extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
rm -f "$WORK/bin/ssh"   # IMPORTANT: don't leave a fake ssh on PATH for later cases
stop_test_bridge

# ── Case 5: zrok — fake binary handles `status` (enabled) and `share` (emits URL)
cat > "$WORK/bin/zrok" <<'FAKE'
#!/bin/bash
if [ "$1" = "status" ]; then echo "OK: environment enabled"; exit 0; fi
( sleep 1; echo "https://fak3test.share.zrok.io" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/zrok"
start_test_bridge
"$REPO/claude-bridge" share --provider zrok >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "https://fak3test.share.zrok.io" ] \
  && ok "zrok: URL extracted" || bad "zrok: extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
stop_test_bridge

echo ""; echo "test-providers: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
