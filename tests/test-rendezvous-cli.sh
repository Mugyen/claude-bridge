#!/bin/bash
# CLI ↔ rendezvous integration: `room invite --code`, `share --code`, and
# `join <code>` against the REAL worker.js served locally via a node adapter.
# Scratch everything; never touches real bridges, dotfiles, or the real worker.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$DIR")"
WORK=$(mktemp -d)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

RDV_PORT=7485
HUBHOME="$WORK/hub-home"; SPOKEHOME="$WORK/spoke-home"
mkdir -p "$HUBHOME/.claude" "$SPOKEHOME/.claude"
HUB_PORT=7483; HUB_FED=7484; SPOKE_PORT=7486

# ── The real worker.js, served locally (in-memory KV, Request/Response adapter)
cat > "$WORK/rdv-server.mjs" << EOF
import http from "node:http";
import worker from "$REPO/rendezvous/worker.js";
const store = new Map();
const env = { RDV: {
  async get(k, t) { const e = store.get(k); if (!e) return null; if (e.exp && Date.now() > e.exp) { store.delete(k); return null; } return t === "json" ? JSON.parse(e.v) : e.v; },
  async put(k, v, o = {}) { store.set(k, { v, exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : null }); },
  async delete(k) { store.delete(k); },
}};
http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const r = await worker.fetch(new Request("https://rdv.local" + req.url, { method: req.method, headers: { "CF-Connecting-IP": "127.0.0.1", "Content-Type": "application/json" }, body: body || undefined }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(await r.text());
}).listen($RDV_PORT, "127.0.0.1", () => console.log("rdv up"));
EOF
node "$WORK/rdv-server.mjs" > "$WORK/rdv.log" 2>&1 &
RDV_PID=$!
sleep 1

hub() {
  HOME="$HUBHOME" CC_BRIDGE_PORT=$HUB_PORT CC_BRIDGE_FED_PORT=$HUB_FED \
  CC_BRIDGE_ROOMS_FILE="$WORK/hub.rooms" CC_BRIDGE_RENDEZVOUS="http://127.0.0.1:$RDV_PORT" \
  CC_BRIDGE_CODES_FILE="$WORK/hub.codes" CC_BRIDGE_ROOM_KEY_FILE="$WORK/hub.roomkey" \
  CC_BRIDGE_TUNNEL_PID="$WORK/h-t.pid" CC_BRIDGE_TUNNEL_URL="$WORK/h-t.url" \
  CC_BRIDGE_TUNNEL_LOG="$WORK/h-t.log" CC_BRIDGE_TUNNEL_PROVIDER="$WORK/h-t.provider" \
  bash "$REPO/claude-bridge" "$@"
}
spoke() {
  HOME="$SPOKEHOME" CC_BRIDGE_PORT=$SPOKE_PORT \
  CC_BRIDGE_ROOMS_FILE="$WORK/spoke.rooms" CC_BRIDGE_RENDEZVOUS="http://127.0.0.1:$RDV_PORT" \
  CC_BRIDGE_CODES_FILE="$WORK/spoke.codes" CC_BRIDGE_ROOM_KEY_FILE="$WORK/spoke.roomkey" \
  CC_BRIDGE_TUNNEL_PID="$WORK/s-t.pid" CC_BRIDGE_TUNNEL_URL="$WORK/s-t.url" \
  CC_BRIDGE_TUNNEL_LOG="$WORK/s-t.log" CC_BRIDGE_TUNNEL_PROVIDER="$WORK/s-t.provider" \
  CC_BRIDGE_SPOKE_PIPE_PID="$WORK/s-p.pid" CC_BRIDGE_SPOKE_PIPE_PORT="$WORK/s-p.port" \
  CC_BRIDGE_SPOKE_PIPE_TICKET="$WORK/s-p.ticket" \
  bash "$REPO/claude-bridge" "$@"
}
cleanup() {
  kill "$RDV_PID" 2>/dev/null
  kill "$(lsof -ti:$HUB_PORT -sTCP:LISTEN 2>/dev/null | head -1)" 2>/dev/null
  kill "$(lsof -ti:$SPOKE_PORT -sTCP:LISTEN 2>/dev/null | head -1)" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# Fake bore so share has a URL to publish.
mkdir -p "$WORK/bin"
printf '#!/bin/bash\n( echo "listening at bore.pub:22222" )\nexec sleep 300\n' > "$WORK/bin/bore"
chmod +x "$WORK/bin/bore"
# ── 1. room create opens connectivity itself; --code publishes under the room name
PATH="$WORK/bin:$PATH" hub room create code-room --password rdvtestpw1234 --provider bore >/dev/null 2>&1
# The fake bore URL isn't joinable — point the recorded share URL at the real
# fed listener so published codes resolve to a WORKING link.
printf 'http://127.0.0.1:%s' "$HUB_FED" > "$WORK/h-t.url"
OUT=$(hub room invite --code 2>&1)
echo "$OUT" | grep -q "join code-room" && ok "invite --code publishes under the ROOM name" || bad "invite --code: $(echo "$OUT" | tail -4)"
[ -s "$WORK/hub.codes" ] && jq -e '."code-room"' "$WORK/hub.codes" >/dev/null 2>&1 && ok "owner token persisted for renewals" || bad "codes file missing owner token"

# ── 2. join <code> resolves and completes the room join
OUT=$(spoke join code-room --node spokerdv 2>&1)
echo "$OUT" | grep -q "Code resolved" && echo "$OUT" | grep -qi "joined room" \
  && ok "join <code>: resolved + joined the room" || bad "join code: $(echo "$OUT" | tail -4)"

# ── 3. re-publish same name (renewal with stored owner token)
OUT=$(hub room invite --code 2>&1)
echo "$OUT" | grep -q "join code-room" && ok "re-publish renews with the stored owner token (no 409)" || bad "renew: $(echo "$OUT" | tail -3)"

# ── 4. squatting from another machine fails cleanly while alive
OUT=$(spoke join nonexistent-code-99 2>&1; true)
echo "$OUT" | grep -qi "not found" && ok "unknown code: clean failure" || bad "unknown code: $(echo "$OUT" | tail -2)"
OUT=$(CC_BRIDGE_RENDEZVOUS="http://127.0.0.1:$RDV_PORT" CC_BRIDGE_CODES_FILE="$WORK/evil.codes" HOME="$SPOKEHOME" bash -c '
  curl -s -X POST "http://127.0.0.1:'"$RDV_PORT"'/v1/rooms" -H "Content-Type: application/json" -d "{\"code\":\"code-room\",\"link\":\"https://evil.example#x\"}"')
echo "$OUT" | grep -q "taken" && ok "alive name: squat attempt 409s" || bad "squat: $OUT"

# ── 5. custom vanity name + share --code
OUT=$(hub room invite --code vanity-name 2>&1)
echo "$OUT" | grep -q "join vanity-name" && ok "invite --code <custom-name> works" || bad "vanity: $(echo "$OUT" | tail -3)"

# ── 6. rendezvous down → graceful degradation (links still printed)
kill "$RDV_PID" 2>/dev/null; sleep 0.5
OUT=$(hub room invite --code 2>&1)
echo "$OUT" | grep -q "#invite:" && echo "$OUT" | grep -qi "not published" \
  && ok "rendezvous down: link printed, code skipped with warning" || bad "degradation: $(echo "$OUT" | tail -3)"

# ── 7. SECURITY: a malicious expires_at must NOT execute (bash arithmetic
#    injection — was a HIGH finding; expiry_human validates pure-int first).
INJ="$WORK/injected-$$"; rm -f "$INJ"
( set -e; source <(sed -n "/^expiry_human()/,/^}/p" "$REPO/claude-bridge"); ok(){ :; }
  expiry_human "{\"expires_at\":\"a[\$(touch $INJ)]\"}" ".expires_at" >/dev/null 2>&1
  expiry_human "{\"expires_at\":\"\$(touch $INJ)\"}" ".expires_at" >/dev/null 2>&1 ) || true
[ ! -f "$INJ" ] && ok "SECURITY: crafted expires_at does not execute (arith injection blocked)" || { bad "INJECTION EXECUTED"; rm -f "$INJ"; }

echo ""; echo "test-rendezvous-cli: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
