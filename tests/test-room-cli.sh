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

# Dead rendezvous + scratch codes so room create's auto-publish never hits prod.
RDV_ENV='CC_BRIDGE_RENDEZVOUS=http://127.0.0.1:9'
mkdir -p "$WORK/bin"
cat > "$WORK/bin/bore" <<'FAKE'
#!/bin/bash
( echo "listening at bore.pub:11111" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/bore"

hub() {
  HOME="$HUBHOME" CC_BRIDGE_PORT=$HUB_PORT CC_BRIDGE_FED_PORT=$HUB_FED \
  CC_BRIDGE_ROOMS_FILE="$WORK/hub.rooms" CC_BRIDGE_CODES_FILE="$WORK/hub.codes" CC_BRIDGE_RENDEZVOUS="http://127.0.0.1:9" \
  CC_BRIDGE_TUNNEL_PID="$WORK/h-t.pid" CC_BRIDGE_TUNNEL_URL="$WORK/h-t.url" \
  CC_BRIDGE_TUNNEL_LOG="$WORK/h-t.log" CC_BRIDGE_TUNNEL_PROVIDER="$WORK/h-t.provider" \
  PATH="$WORK/bin:$PATH" bash "$REPO/claude-bridge" "$@"
}
spoke() {
  HOME="$SPOKEHOME" CC_BRIDGE_PORT=$SPOKE_PORT \
  CC_BRIDGE_ROOMS_FILE="$WORK/spoke.rooms" CC_BRIDGE_CODES_FILE="$WORK/spoke.codes" CC_BRIDGE_RENDEZVOUS="http://127.0.0.1:9" \
  CC_BRIDGE_TUNNEL_PID="$WORK/s-t.pid" CC_BRIDGE_TUNNEL_URL="$WORK/s-t.url" \
  CC_BRIDGE_TUNNEL_LOG="$WORK/s-t.log" CC_BRIDGE_TUNNEL_PROVIDER="$WORK/s-t.provider" \
  CC_BRIDGE_SPOKE_PIPE_PID="$WORK/s-p.pid" CC_BRIDGE_SPOKE_PIPE_PORT="$WORK/s-p.port" \
  CC_BRIDGE_SPOKE_PIPE_TICKET="$WORK/s-p.ticket" \
  PATH="$WORK/bin:$PATH" bash "$REPO/claude-bridge" "$@"
}
cleanup() {
  kill "$(lsof -ti:$HUB_PORT -sTCP:LISTEN 2>/dev/null | head -1)" 2>/dev/null
  kill "$(lsof -ti:$SPOKE_PORT -sTCP:LISTEN 2>/dev/null | head -1)" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 1. room create — now opens connectivity itself (bore fake) + publishes a code
OUT=$(hub room create team-x --password secretpw12345 --provider bore 2>&1)
echo "$OUT" | grep -qi "Room \"team-x\" created" && ok "room create makes the room" || bad "room create output: $(echo "$OUT" | tail -3)"
echo "$OUT" | grep -qi "ACTIVE — you're hosting" && ok "room create reports the room ACTIVE" || bad "no ACTIVE line"

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

# ── 8. E2EE room: key file written, invite link carries the key, joiner installs it
export CC_BRIDGE_ROOM_KEY_FILE_HUB="$WORK/hub.roomkey" CC_BRIDGE_ROOM_KEY_FILE_SPOKE="$WORK/spoke.roomkey"
OUT=$(CC_BRIDGE_ROOM_KEY_FILE="$WORK/hub.roomkey" hub room create vault-x --password secretpw12345 --e2ee --provider bore 2>&1)
echo "$OUT" | grep -q "E2EE ON" && ok "e2ee create announces" || bad "e2ee create: $(echo "$OUT" | tail -2)"
[ -s "$WORK/hub.roomkey" ] && grep -qE "^[a-f0-9]{64}$" "$WORK/hub.roomkey" && ok "e2ee: owner key file written (64-hex)" || bad "e2ee: hub key file bad"
OUT=$(CC_BRIDGE_ROOM_KEY_FILE="$WORK/hub.roomkey" hub room invite 2>&1)
ELINK=$(echo "$OUT" | grep -oE "'[^']+#invite:[a-f0-9]+:[a-f0-9]{64}'" | head -1 | tr -d "'")
[ -n "$ELINK" ] && ok "e2ee: invite link carries code AND key in the fragment" || bad "e2ee link missing key: $(echo "$OUT" | tail -3)"
EJOIN="http://127.0.0.1:${HUB_FED}#${ELINK#*#}"
OUT=$(CC_BRIDGE_ROOM_KEY_FILE="$WORK/spoke.roomkey" spoke join "$EJOIN" --node spokee2ee 2>&1)
echo "$OUT" | grep -q "room key installed" && ok "e2ee: joiner installed the key from the link" || bad "e2ee join: $(echo "$OUT" | tail -3)"
[ "$(cat "$WORK/spoke.roomkey" 2>/dev/null)" = "$(cat "$WORK/hub.roomkey")" ] && ok "e2ee: spoke key matches owner key" || bad "e2ee: key mismatch"
CC_BRIDGE_ROOM_KEY_FILE="$WORK/hub.roomkey" hub room delete vault-x >/dev/null 2>&1

echo ""; echo "test-room-cli: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
