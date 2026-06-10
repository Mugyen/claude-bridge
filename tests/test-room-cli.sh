#!/bin/bash
# room CLI verbs end-to-end: create → invite → spoke joins via '#invite:' link →
# members → kick → delete. Two scratch HOMEs (hub + spoke), scratch ports,
# isolated rooms/tunnel state. Never touches real bridges or real dotfiles.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$DIR")"
WORK=$(mktemp -d)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

HUBHOME="$WORK/hub-home"; SPOKEHOME="$WORK/spoke-home"
mkdir -p "$HUBHOME/.claude" "$SPOKEHOME/.claude"
HUB_PORT=7493; HUB_FED=7494; SPOKE_PORT=7495

hub() {
  HOME="$HUBHOME" CC_BRIDGE_PORT=$HUB_PORT CC_BRIDGE_FED_PORT=$HUB_FED \
  CC_BRIDGE_ROOMS_FILE="$WORK/hub.rooms" \
  CC_BRIDGE_TUNNEL_PID="$WORK/h-t.pid" CC_BRIDGE_TUNNEL_URL="$WORK/h-t.url" \
  CC_BRIDGE_TUNNEL_LOG="$WORK/h-t.log" CC_BRIDGE_TUNNEL_PROVIDER="$WORK/h-t.provider" \
  bash "$REPO/claude-bridge" "$@"
}
spoke() {
  HOME="$SPOKEHOME" CC_BRIDGE_PORT=$SPOKE_PORT \
  CC_BRIDGE_ROOMS_FILE="$WORK/spoke.rooms" \
  CC_BRIDGE_TUNNEL_PID="$WORK/s-t.pid" CC_BRIDGE_TUNNEL_URL="$WORK/s-t.url" \
  CC_BRIDGE_TUNNEL_LOG="$WORK/s-t.log" CC_BRIDGE_TUNNEL_PROVIDER="$WORK/s-t.provider" \
  CC_BRIDGE_SPOKE_PIPE_PID="$WORK/s-p.pid" CC_BRIDGE_SPOKE_PIPE_PORT="$WORK/s-p.port" \
  CC_BRIDGE_SPOKE_PIPE_TICKET="$WORK/s-p.ticket" \
  bash "$REPO/claude-bridge" "$@"
}
cleanup() {
  kill "$(lsof -ti:$HUB_PORT -sTCP:LISTEN 2>/dev/null | head -1)" 2>/dev/null
  kill "$(lsof -ti:$SPOKE_PORT -sTCP:LISTEN 2>/dev/null | head -1)" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# Hub: become a hub (no tunnel needed — spoke reaches the fed port directly).
hub share --provider cloudflared-quick >/dev/null 2>&1   # rejected provider — just ensures token+role exist? NO: use stop after
# Simpler: start bridge + set hub role via share with a FAKE provider is messy.
# ensure_token+role happen inside `room create` flow? No — do it via share with bore fake:
mkdir -p "$WORK/bin"
cat > "$WORK/bin/bore" <<'FAKE'
#!/bin/bash
( echo "listening at bore.pub:11111" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/bore"
PATH="$WORK/bin:$PATH" hub share --provider bore >/dev/null 2>&1

# ── 1. room create
OUT=$(hub room create team-x --password secretpw12345 2>&1)
echo "$OUT" | grep -q "r_[a-f0-9]" && ok "room create prints the room id" || bad "room create output: $(echo "$OUT" | tail -2)"
echo "$OUT" | grep -qi "member-token auth" && ok "room create announces the auth switch" || bad "no auth-switch notice"

# ── 2. room invite prints a complete join link with #invite: fragment
OUT=$(hub room invite --one-time 2>&1)
LINK=$(echo "$OUT" | grep -oE "'[^']+#invite:[a-f0-9]+'" | head -1 | tr -d "'")
[ -n "$LINK" ] && ok "room invite prints a join link ($LINK)" || bad "no link in: $(echo "$OUT" | tail -3)"

# ── 3. spoke joins via the invite link (point it at the hub fed port directly)
JOIN_LINK="http://127.0.0.1:${HUB_FED}#${LINK#*#}"
OUT=$(spoke join "$JOIN_LINK" --node spokecli 2>&1)
echo "$OUT" | grep -qi "joined room" && ok "spoke join exchanges invite for member token" || bad "join output: $(echo "$OUT" | tail -3)"
TOK=$(cat "$SPOKEHOME/.claude/.cc-bridge-token" 2>/dev/null)
[ ${#TOK} -eq 64 ] && ok "spoke stored a 64-hex member token (not the invite)" || bad "token len=${#TOK}"
[ "$(cat "$SPOKEHOME/.claude/.cc-bridge-role" 2>/dev/null)" = "spoke" ] && ok "spoke role set" || bad "spoke role wrong"

# ── 4. one-time invite is now dead
OUT=$(spoke join "$JOIN_LINK" --node spokecli2 2>&1; true)
echo "$OUT" | grep -qi "invalid or expired" && ok "second use of one-time invite rejected" || bad "reuse not rejected: $(echo "$OUT" | tail -2)"

# ── 5. members shows the spoke; kick removes it
sleep 2
OUT=$(hub room members 2>&1)
echo "$OUT" | grep -q "spokecli" && ok "room members lists the joined spoke" || bad "members: $OUT"
OUT=$(hub room kick spokecli 2>&1)
echo "$OUT" | grep -qi "kicked" && ok "room kick works" || bad "kick: $OUT"
OUT=$(hub room members 2>&1)
echo "$OUT" | grep -q "spokecli" && bad "kicked member still listed" || ok "kicked member gone from members"

# ── 6. password join via --password flag
OUT=$(spoke join "http://127.0.0.1:${HUB_FED}" --password secretpw12345 --node spokepw 2>&1)
echo "$OUT" | grep -qi "joined room" && ok "password join works (no fragment needed)" || bad "pw join: $(echo "$OUT" | tail -3)"

# ── 7. room info + delete (typed confirmation)
OUT=$(hub room info 2>&1)
echo "$OUT" | grep -q "team-x" && ok "room info renders" || bad "info: $OUT"
OUT=$(hub room delete wrong-name 2>&1; true)
echo "$OUT" | grep -qi "confirm" && ok "delete with wrong name refused" || bad "delete guard: $OUT"
OUT=$(hub room delete team-x 2>&1)
echo "$OUT" | grep -qi "deleted" && ok "room delete works with typed name" || bad "delete: $OUT"

echo ""; echo "test-room-cli: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
