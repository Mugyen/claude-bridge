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
echo "bore" > "$WORK/tunnel.provider"
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

# ── Case 2: share --stable (cloudflared named) records provider+URL; quick is REJECTED
cat > "$WORK/bin/cloudflared" <<'FAKE'
#!/bin/bash
( sleep 1; echo "INF +-- https://fake-test.trycloudflare.com" >&2 )
exec sleep 300
FAKE
chmod +x "$WORK/bin/cloudflared"
start_test_bridge
"$REPO/claude-bridge" share --stable fake-test.example.com >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.provider" 2>/dev/null)" = "cloudflared-named" ] \
  && ok "share: provider recorded" || bad "share: provider file wrong/missing (got: $(cat "$WORK/tunnel.provider" 2>/dev/null))"
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "https://fake-test.example.com" ] \
  && ok "share: named URL recorded" || bad "share: named URL wrong"
OUT=$("$REPO/claude-bridge" share --provider cloudflared-quick 2>&1; true)
echo "$OUT" | grep -q "buffer SSE" \
  && ok "share: quick tunnels REJECTED with explanation" || bad "share: quick not rejected ($OUT)"
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

# ── Case 6a: share --p2p extracts the ticket as p2p:<ticket>
cat > "$WORK/bin/dumbpipe" <<'FAKE'
#!/bin/bash
if [ "$1" = "listen-tcp" ]; then
  echo "secret=${IROH_SECRET:-none}"
  ( sleep 1; echo "To connect, use e.g.:"; echo "dumbpipe connect-tcp nodeaafake7ticket3string9xyz" )
  exec sleep 300
fi
if [ "$1" = "connect-tcp" ]; then exec sleep 300; fi
if [ "$1" = "generate-ticket" ]; then echo "endpointfake$(printf %.8s "${IROH_SECRET:-rand}")canonical"; exit 0; fi
FAKE
chmod +x "$WORK/bin/dumbpipe"
start_test_bridge
"$REPO/claude-bridge" share --p2p >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "p2p:nodeaafake7ticket3string9xyz" ] \
  && ok "p2p: ticket extracted" || bad "p2p: ticket extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1

# ── Case 6b: join 'p2p:<ticket>#<token>' spawns the forwarder + writes localhost HUB_FILE
"$REPO/claude-bridge" join 'p2p:nodeaafake7ticket3string9xyz#deadbeef' >/dev/null 2>&1
hub=$(cat "$HOME/.claude/.cc-bridge-hub" 2>/dev/null)
case "$hub" in
  http://127.0.0.1:*) ok "p2p join: HUB_FILE is localhost forwarder ($hub)";;
  *) bad "p2p join: HUB_FILE wrong: $hub";;
esac
if [ -f "$WORK/pipe.pid" ] && kill -0 "$(cat "$WORK/pipe.pid")" 2>/dev/null; then
  ok "p2p join: forwarder running"
else
  bad "p2p join: forwarder not running"
fi
[ "$(cat "$WORK/pipe.ticket" 2>/dev/null)" = "nodeaafake7ticket3string9xyz" ] \
  && ok "p2p join: ticket recorded" || bad "p2p join: ticket file wrong"
PIPE_PID_BEFORE=$(cat "$WORK/pipe.pid" 2>/dev/null || echo "")
"$REPO/claude-bridge" unlink >/dev/null 2>&1
sleep 0.5
if [ -n "$PIPE_PID_BEFORE" ] && kill -0 "$PIPE_PID_BEFORE" 2>/dev/null; then
  bad "unlink: forwarder still alive"; kill -9 "$PIPE_PID_BEFORE" 2>/dev/null
else
  ok "unlink: forwarder killed"
fi
stop_test_bridge

# ── Case 7: tailscale — fake CLI; share uses serve --tcp; stop-share runs serve off
cat > "$WORK/bin/tailscale" <<'FAKE'
#!/bin/bash
case "$1" in
  status)
    if [ "${2:-}" = "--json" ]; then echo '{"BackendState":"Running","Self":{"DNSName":"myhost.tail1234.ts.net."}}'; else echo "running"; fi ;;
  serve)
    echo "$@" >> "${TAILSCALE_FAKE_LOG:-/tmp/ts-fake.log}"
    if [ "${2:-}" = "status" ]; then cat "${TAILSCALE_FAKE_STATE:-/dev/null}" 2>/dev/null; exit 0; fi
    case " $* " in
      *" off "*) : > "${TAILSCALE_FAKE_STATE}" ;;
      *) echo "|-- tcp://myhost.tail1234.ts.net:7498 -> tcp://127.0.0.1:7498" > "${TAILSCALE_FAKE_STATE}" ;;
    esac ;;
esac
FAKE
chmod +x "$WORK/bin/tailscale"
export TAILSCALE_FAKE_LOG="$WORK/ts.log" TAILSCALE_FAKE_STATE="$WORK/ts.state"
export CC_BRIDGE_FED_PORT=7498
start_test_bridge
"$REPO/claude-bridge" share --tailscale >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "http://myhost.tail1234.ts.net:7498" ] \
  && ok "tailscale: URL built from MagicDNS" || bad "tailscale: URL wrong (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
grep -q -- "--tcp" "$WORK/ts.log" 2>/dev/null \
  && ok "tailscale: used serve --tcp (L4, no SSE buffering)" || bad "tailscale: did not use --tcp"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
if grep -q " off" "$WORK/ts.log" 2>/dev/null && [ ! -s "$WORK/ts.state" ]; then
  ok "tailscale: serve torn down (config persists otherwise!)"
else
  bad "tailscale: serve NOT torn down"
fi
unset CC_BRIDGE_FED_PORT
stop_test_bridge

# ── Case 8: bare `share` defaults to p2p (fake dumbpipe from case 6 still on PATH)
start_test_bridge
"$REPO/claude-bridge" share >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.provider" 2>/dev/null)" = "p2p" ] \
  && ok "default provider is p2p" || bad "default provider is '$(cat "$WORK/tunnel.provider" 2>/dev/null)', expected p2p"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
stop_test_bridge

# ── Case 9: share --reuse persists a key and passes the SAME IROH_SECRET each time
export CC_BRIDGE_P2P_KEY="$WORK/p2p.key"
start_test_bridge
"$REPO/claude-bridge" share --reuse >/dev/null 2>&1
[ -s "$WORK/p2p.key" ] && ok "reuse: key file created" || bad "reuse: key file missing"
perms=$(stat -f %Lp "$WORK/p2p.key" 2>/dev/null || stat -c %a "$WORK/p2p.key" 2>/dev/null)
[ "$perms" = "600" ] && ok "reuse: key file is 0600" || bad "reuse: key perms $perms"
S1=$(grep -oE 'secret=[a-f0-9]+' "$WORK/tunnel.log" | head -1)
REUSE_T1=$(cat "$WORK/tunnel.url")
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
"$REPO/claude-bridge" share --reuse >/dev/null 2>&1
S2=$(grep -oE 'secret=[a-f0-9]+' "$WORK/tunnel.log" | head -1)
[ -n "$S1" ] && [ "$S1" = "$S2" ] && ok "reuse: same IROH_SECRET across restarts" || bad "reuse: secret changed ($S1 vs $S2)"
[ "$(cat "$WORK/tunnel.url")" = "$REUSE_T1" ] && ok "reuse: ticket STRING identical across restarts (canonical)" || bad "reuse: ticket changed ($REUSE_T1 vs $(cat "$WORK/tunnel.url"))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
"$REPO/claude-bridge" share >/dev/null 2>&1
S3=$(grep -oE 'secret=[a-f0-9]+' "$WORK/tunnel.log" | head -1 || true)
[ "$S3" != "$S1" ] && ok "reuse: plain share stays ephemeral (no secret reuse)" || bad "reuse: plain share leaked the persistent key"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
stop_test_bridge

echo ""; echo "test-providers: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
