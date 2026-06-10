#!/bin/bash
# claude-bridge federation flags: --join parses a link into the right files,
# --share without cloudflared prints install instructions and exits non-zero,
# --share with a FAKE cloudflared parses the quick-tunnel URL and prints a join
# link. We never open a real tunnel in CI (external tool = detect-and-instruct).
#
# Uses port 7408 and isolated HOME-like config paths so it never touches the
# developer's real ~/.claude dotfiles or the production bridge on 7400.

set -u
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=7408
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# Isolated fake HOME so claude-bridge writes config under a temp dir.
TMP=$(mktemp -d)
export HOME="$TMP/home"
mkdir -p "$HOME/.claude"
# CRITICAL: isolate the tunnel state files. They default to hardcoded /tmp paths,
# so without this the fake-cloudflared share/stop-share in this test would clobber
# and KILL a real production tunnel running on the same machine (a real incident).
export CC_BRIDGE_TUNNEL_PID="$TMP/tunnel.pid"
export CC_BRIDGE_TUNNEL_URL="$TMP/tunnel.url"
export CC_BRIDGE_TUNNEL_LOG="$TMP/tunnel.log"
FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
# Snapshot the REAL tunnel-url file so we can assert the test never modifies it.
REAL_TUN_BEFORE=$(cat /tmp/claude-bridge-tunnel.url 2>/dev/null || echo __absent__)
TOKEN_FILE="$HOME/.claude/.cc-bridge-token"
ROLE_FILE="$HOME/.claude/.cc-bridge-role"
HUB_FILE="$HOME/.claude/.cc-bridge-hub"
NODE_FILE="$HOME/.claude/.cc-bridge-node"

cleanup() {
  [ -f "$CC_BRIDGE_TUNNEL_PID" ] && kill "$(cat "$CC_BRIDGE_TUNNEL_PID")" 2>/dev/null
  lsof -ti:$PORT 2>/dev/null | xargs kill 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# ── 1. --join parses a link into token/hub/role files (bridge not running) ──
# join_hub falls back to start_bridge if the bridge isn't up; to avoid spawning
# a server we pre-touch a "running" check by pointing PORT at nothing — start
# will try, so instead just assert the files after the parse step by running
# join against a down bridge and checking the files were written before the
# start attempt. We run with CC_BRIDGE_PORT set to an unused port.
CC_BRIDGE_PORT=$PORT bash "$REPO_DIR/claude-bridge" --join 'https://calm-river-1234.trycloudflare.com#secrettoken99' >/dev/null 2>&1 || true

if [ "$(cat "$TOKEN_FILE" 2>/dev/null)" = "secrettoken99" ]; then ok "--join writes the token from the fragment"; else bad "--join token (got: $(cat "$TOKEN_FILE" 2>/dev/null))"; fi
if [ "$(cat "$HUB_FILE" 2>/dev/null)" = "https://calm-river-1234.trycloudflare.com" ]; then ok "--join writes the hub URL (fragment stripped)"; else bad "--join hub URL (got: $(cat "$HUB_FILE" 2>/dev/null))"; fi
if [ "$(cat "$ROLE_FILE" 2>/dev/null)" = "spoke" ]; then ok "--join sets role=spoke"; else bad "--join role (got: $(cat "$ROLE_FILE" 2>/dev/null))"; fi
if [ -s "$NODE_FILE" ]; then ok "--join derives a node id"; else bad "--join node id missing"; fi

# ── 2. --join rejects a link with no token fragment ─────────────────────────
OUT=$(CC_BRIDGE_PORT=$PORT bash "$REPO_DIR/claude-bridge" --join 'https://no-fragment.example.com' 2>&1 || true)
if echo "$OUT" | grep -q "token fragment"; then ok "--join rejects a link with no token fragment"; else bad "--join no-fragment rejection"; fi

# ── 3. --share without cloudflared + auto-install OFF → instruct + non-zero ──
# CC_BRIDGE_NO_AUTOINSTALL=1 keeps this hermetic (no real download/brew in CI) and
# exercises the detect-and-instruct fallback. (The auto-install path itself uses
# brew/curl — an external tool — and is verified live, not in CI.)
rm -f "$TOKEN_FILE" "$ROLE_FILE" "$HUB_FILE" "$NODE_FILE"
OUT=$(CC_BRIDGE_PORT=$PORT CC_BRIDGE_NO_AUTOINSTALL=1 PATH="$FAKEBIN:/usr/bin:/bin" bash "$REPO_DIR/claude-bridge" --share 2>&1; echo "RC=$?")
if echo "$OUT" | grep -q "cloudflared not found"; then ok "--share without cloudflared (auto-install off) prints not-found"; else bad "--share missing-cloudflared message ($(echo "$OUT" | tail -3))"; fi
if echo "$OUT" | grep -q "RC=1"; then ok "--share without cloudflared exits non-zero"; else bad "--share missing-cloudflared exit code"; fi

# ── 4. --share with a FAKE cloudflared parses the quick-tunnel URL ──────────
# Fake cloudflared: branches on the subcommand so the auto-install/update probe
# (`cloudflared update` / `--version`) returns fast instead of hanging on sleep.
# Only `tunnel` simulates the long-lived tunnel.
cat > "$FAKEBIN/cloudflared" <<'EOF'
#!/bin/bash
case "$1" in
  update)    exit 0 ;;
  --version) echo "cloudflared version 9999.0.0 (fake)"; exit 0 ;;
  tunnel)
    echo "2024-01-01 INF +-----------------------------+"
    echo "2024-01-01 INF |  https://fake-tunnel-9.trycloudflare.com  |"
    echo "2024-01-01 INF +-----------------------------+"
    sleep 30 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKEBIN/cloudflared"
# Fake node/openssl already on real PATH; need jq + node + curl for start_bridge.
# We DO start a real bridge here (on 7408) so fed_reload/start works.
OUT=$(CC_BRIDGE_PORT=$PORT CC_BRIDGE_NO_AUTOINSTALL=1 PATH="$FAKEBIN:$PATH" bash "$REPO_DIR/claude-bridge" --share 2>&1; echo "RC=$?")
if echo "$OUT" | grep -q "fake-tunnel-9.trycloudflare.com"; then ok "--share parses the quick-tunnel URL from cloudflared output"; else bad "--share URL parse ($(echo "$OUT" | tail -3))"; fi
if echo "$OUT" | grep -q "claude-bridge join 'https://fake-tunnel-9.trycloudflare.com#"; then ok "--share prints the join link with token fragment"; else bad "--share join link print"; fi
if [ -s "$TOKEN_FILE" ]; then ok "--share generated a token"; else bad "--share token generation"; fi
if [ "$(cat "$ROLE_FILE" 2>/dev/null)" = "hub" ]; then ok "--share sets role=hub"; else bad "--share role (got: $(cat "$ROLE_FILE" 2>/dev/null))"; fi

# Isolation guard — WHILE the (fake) tunnel is open: the URL must be in the
# isolated TMP path, and the REAL /tmp tunnel-url must be untouched. If isolation
# breaks, the fake URL leaks into /tmp/claude-bridge-tunnel.url and would clobber a
# live production tunnel (the incident this guards against).
if [ "$(cat "$CC_BRIDGE_TUNNEL_URL" 2>/dev/null)" = "https://fake-tunnel-9.trycloudflare.com" ]; then ok "tunnel URL written to the ISOLATED path (not /tmp)"; else bad "isolated tunnel URL not written ($(cat "$CC_BRIDGE_TUNNEL_URL" 2>/dev/null))"; fi
if [ "$(cat /tmp/claude-bridge-tunnel.url 2>/dev/null || echo __absent__)" = "$REAL_TUN_BEFORE" ]; then ok "real /tmp tunnel state untouched while test tunnel is open"; else bad "TEST CLOBBERED the real /tmp/claude-bridge-tunnel.url — isolation broke"; fi

# ── 5. --stop-share closes the tunnel + drops to standalone ─────────────────
OUT=$(CC_BRIDGE_PORT=$PORT CC_BRIDGE_NO_AUTOINSTALL=1 PATH="$FAKEBIN:$PATH" bash "$REPO_DIR/claude-bridge" --stop-share 2>&1 || true)
if echo "$OUT" | grep -qiE "tunnel.*closed"; then ok "--stop-share closes the tunnel"; else bad "--stop-share tunnel close ($OUT)"; fi
if [ "$(cat "$ROLE_FILE" 2>/dev/null)" = "standalone" ]; then ok "--stop-share drops role to standalone"; else bad "--stop-share role reset"; fi
if [ -s "$TOKEN_FILE" ]; then ok "--stop-share keeps the token (fast re-share)"; else bad "--stop-share kept token"; fi

# Stop the test bridge we started.
lsof -ti:$PORT 2>/dev/null | xargs kill 2>/dev/null || true

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
