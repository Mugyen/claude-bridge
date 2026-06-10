#!/bin/bash
# claude-bridge CLI dispatcher: verb routing, --flag back-compat aliases, the
# read-only commands (help/version/doctor/status/logs), unknown-command handling,
# and per-invocation logging. Uses an isolated HOME so it never touches the real
# ~/.claude (the CLI log + config land under the temp HOME).

set -u
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d); export HOME="$TMP/home"; mkdir -p "$HOME/.claude"
CLI_LOG="$HOME/.claude/claude-bridge.log"
PASS=0; FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
trap "rm -rf $TMP" EXIT
SH() { bash "$REPO_DIR/claude-bridge" "$@" 2>&1; }

# help → exit 0, grouped, mentions key verbs
OUT=$(SH help); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "claude-bridge" && echo "$OUT" | grep -q "doctor" && echo "$OUT" | grep -q "share"; then
  ok "help → exit 0, lists commands"
else bad "help (rc=$RC)"; fi

# version → exit 0, prints repo version
OUT=$(SH version); [ $? -eq 0 ] && echo "$OUT" | grep -q "claude-bridge v" && ok "version → exit 0" || bad "version"

# invoked THROUGH a PATH symlink → REPO_DIR still resolves to the real checkout
# (regression: a bare `dirname $0` pointed at the symlink dir → version "unknown"
# and a broken bridge-server.mjs path).
LN="$TMP/bin/claude-bridge"; mkdir -p "$TMP/bin"; ln -sf "$REPO_DIR/claude-bridge" "$LN"
OUT=$(cd / && bash "$LN" version 2>&1); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "v2" && ! echo "$OUT" | grep -qi "unknown"; then
  ok "invoked via PATH symlink → REPO_DIR resolves (version not 'unknown')"
else bad "symlink invocation (rc=$RC: $OUT)"; fi

# unknown command → exit 2 + hint
OUT=$(SH frobnicate); RC=$?
if [ $RC -eq 2 ] && echo "$OUT" | grep -q "Unknown command"; then ok "unknown command → exit 2 + hint"; else bad "unknown command (rc=$RC: $OUT)"; fi

# verb aliases all route to the same action (status == check == --check)
H1=$(SH status | grep -c "claude-bridge status"); H2=$(SH check | grep -c "claude-bridge status"); H3=$(SH --check | grep -c "claude-bridge status")
if [ "$H1" -ge 1 ] && [ "$H2" -ge 1 ] && [ "$H3" -ge 1 ]; then ok "verb aliases route together (status / check / --check)"; else bad "alias routing ($H1/$H2/$H3)"; fi

# old federation --flags still parse (back-compat): --join with no link → usage error, not 'unknown command'
OUT=$(SH --join 'https://h.example' ); echo "$OUT" | grep -qi "must include a fragment" && ok "old --join flag still recognized (back-compat)" || bad "--join back-compat ($OUT)"

# doctor → runs and exits 0 even with nothing installed (checks are non-fatal)
OUT=$(SH doctor); RC=$?
[ $RC -eq 0 ] && echo "$OUT" | grep -q "claude-bridge doctor" && ok "doctor → exit 0, prints report" || bad "doctor (rc=$RC)"

# logging: every invocation appended a line to the CLI log
if [ -f "$CLI_LOG" ] && grep -q "help " "$CLI_LOG" && grep -q "doctor " "$CLI_LOG" && grep -q "exit:" "$CLI_LOG"; then
  ok "every invocation logged to ~/.claude/claude-bridge.log (with exit code)"
else bad "logging ($([ -f "$CLI_LOG" ] && wc -l < "$CLI_LOG" || echo no-log) lines)"; fi

# log perms 0600
if [ -f "$CLI_LOG" ]; then
  P=$(stat -f '%Lp' "$CLI_LOG" 2>/dev/null || stat -c '%a' "$CLI_LOG" 2>/dev/null)
  [ "$P" = "600" ] && ok "CLI log is 0600" || bad "CLI log perms ($P)"
fi

# logs command tails without error
SH logs >/dev/null 2>&1 && ok "logs → exit 0" || bad "logs command"

# debug command → exit 0, points to a new session + "debug bridge", states read-only
OUT=$(SH debug); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "debug bridge" && echo "$OUT" | grep -qi "read-only\|not change"; then
  ok "debug → exit 0, instructs 'debug bridge' + read-only"
else bad "debug command (rc=$RC)"; fi

# the repo ships the debug skill with the right frontmatter name (auto-trigger key)
if grep -q '^name: claude-bridge-debug' "$REPO_DIR/skill-debug/SKILL.md" 2>/dev/null; then
  ok "skill-debug/SKILL.md ships with name: claude-bridge-debug"
else bad "debug skill frontmatter name"; fi

# debug skill is read-only by contract: it must NOT instruct restart/stop/edit of the bridge
if grep -qi "DO NOT TOUCH\|read-only\|never changes" "$REPO_DIR/skill-debug/SKILL.md"; then
  ok "debug skill states the strict read-only rule"
else bad "debug skill read-only rule missing"; fi

# full install lands BOTH skills + uninstall removes both (only when the Claude CLI
# is present — server/hub-only installs skip skill wiring, covered separately).
if command -v claude >/dev/null 2>&1; then
  SH2HOME="$TMP/skillhome"; mkdir -p "$SH2HOME/.claude"
  # CC_BRIDGE_PORT=7498 (unused) so uninstall's full-teardown step can't stop a
  # real bridge on the default :7400 — uninstall now kills the listener on $PORT.
  HOME="$SH2HOME" CC_BRIDGE_PORT=7498 CC_BRIDGE_TUNNEL_PID="$SH2HOME/t.pid" CC_BRIDGE_TUNNEL_URL="$SH2HOME/t.url" CC_BRIDGE_TUNNEL_PROVIDER="$SH2HOME/t.provider" CC_BRIDGE_SPOKE_PIPE_PID="$SH2HOME/p.pid" CC_BRIDGE_SPOKE_PIPE_PORT="$SH2HOME/p.port" CC_BRIDGE_SPOKE_PIPE_TICKET="$SH2HOME/p.ticket" bash "$REPO_DIR/claude-bridge" install >/dev/null 2>&1
  both_in=$([ -f "$SH2HOME/.claude/skills/claude-bridge/SKILL.md" ] && [ -f "$SH2HOME/.claude/skills/claude-bridge-debug/SKILL.md" ] && echo yes || echo no)
  HOME="$SH2HOME" CC_BRIDGE_PORT=7498 CC_BRIDGE_TUNNEL_PID="$SH2HOME/t.pid" CC_BRIDGE_TUNNEL_URL="$SH2HOME/t.url" CC_BRIDGE_TUNNEL_PROVIDER="$SH2HOME/t.provider" CC_BRIDGE_SPOKE_PIPE_PID="$SH2HOME/p.pid" CC_BRIDGE_SPOKE_PIPE_PORT="$SH2HOME/p.port" CC_BRIDGE_SPOKE_PIPE_TICKET="$SH2HOME/p.ticket" bash "$REPO_DIR/claude-bridge" uninstall >/dev/null 2>&1
  both_gone=$([ ! -d "$SH2HOME/.claude/skills/claude-bridge" ] && [ ! -d "$SH2HOME/.claude/skills/claude-bridge-debug" ] && echo yes || echo no)
  if [ "$both_in" = yes ] && [ "$both_gone" = yes ]; then
    ok "install lands protocol+debug skills; uninstall removes both"
  else bad "skill install/uninstall round-trip (in=$both_in gone=$both_gone)"; fi
else
  ok "skill install round-trip skipped (no claude CLI here — server-only path)"
fi

# bare `claude-bridge` (no args) → help, and must NOT run the installer
OUT=$(SH); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "USAGE" && ! echo "$OUT" | grep -q "Installing..."; then
  ok "bare 'claude-bridge' → help (does not install)"
else bad "bare invocation (rc=$RC, installed=$(echo "$OUT" | grep -q Installing && echo yes || echo no))"; fi

# health → against a port with no bridge, reports not-running (non-zero) without crashing
OUT=$(CC_BRIDGE_PORT=7499 bash "$REPO_DIR/claude-bridge" health 2>&1); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qi "not running"; then
  ok "health → 'not running' when no bridge on the port"
else bad "health no-bridge (rc=$RC: $(echo "$OUT" | tail -2))"; fi

# uninstall is a FULL teardown: it STOPS a running bridge (not just config removal).
# Isolated HOME + a throwaway port so it never touches real config or :7400.
if command -v node >/dev/null 2>&1; then
  THOME="$TMP/teardown"; mkdir -p "$THOME/.claude"
  HOME="$THOME" CC_BRIDGE_PORT=7497 bash "$REPO_DIR/claude-bridge" start >/dev/null 2>&1
  sleep 1
  up=$(curl -sf --max-time 1 http://localhost:7497/health/ping >/dev/null 2>&1 && echo yes || echo no)
  HOME="$THOME" CC_BRIDGE_PORT=7497 CC_BRIDGE_TUNNEL_PID="$THOME/t.pid" CC_BRIDGE_TUNNEL_URL="$THOME/t.url" CC_BRIDGE_TUNNEL_PROVIDER="$THOME/t.provider" CC_BRIDGE_SPOKE_PIPE_PID="$THOME/p.pid" CC_BRIDGE_SPOKE_PIPE_PORT="$THOME/p.port" CC_BRIDGE_SPOKE_PIPE_TICKET="$THOME/p.ticket" bash "$REPO_DIR/claude-bridge" uninstall >/dev/null 2>&1
  sleep 1
  down=$(curl -sf --max-time 1 http://localhost:7497/health/ping >/dev/null 2>&1 && echo no || echo yes)
  lsof -ti:7497 2>/dev/null | xargs kill 2>/dev/null || true
  if [ "$up" = yes ] && [ "$down" = yes ]; then
    ok "uninstall stops the running bridge (full teardown)"
  else bad "uninstall teardown (bridge up before=$up, stopped after=$down)"; fi
else
  ok "uninstall teardown test skipped (no node)"
fi

# server/hub-only install: no `claude` on PATH → install still succeeds (warns,
# skips hooks/MCP/skill/Desktop) and still symlinks the CLI. Build a PATH with
# node/jq/curl/git/bash but NO claude.
FB="$TMP/srvbin"; mkdir -p "$FB"
for c in node jq curl git bash sed grep mkdir chmod ln readlink dirname basename cat rm stat date cut tr; do
  p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "$FB/$c"
done
SRV_HOME="$TMP/srvhome"; mkdir -p "$SRV_HOME/.claude"
OUT=$(HOME="$SRV_HOME" PATH="$FB" bash "$REPO_DIR/claude-bridge" install 2>&1); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -qi "server/hub-only" && [ -L "$SRV_HOME/.local/bin/claude-bridge" ]; then
  ok "server/hub-only install (no claude CLI) → succeeds, skips wiring, still symlinks CLI"
else bad "server-only install (rc=$RC, symlink=$([ -L "$SRV_HOME/.local/bin/claude-bridge" ] && echo yes || echo no)): $(echo "$OUT" | tail -3)"; fi

# ── uninstall with env-overridden tunnel paths must NOT touch real /tmp state ──
# (regression: the global /tmp/claude-bridge-* glob — run from a TEST — wiped a
# live production share's state files and killed its dumbpipe, 2026-06-10)
SENTINEL="/tmp/claude-bridge-SENTINEL-$$"
echo live > "$SENTINEL"
UHOME="$TMP/uhome"; mkdir -p "$UHOME/.claude"
HOME="$UHOME" CC_BRIDGE_PORT=7496 \
  CC_BRIDGE_TUNNEL_PID="$UHOME/t.pid" CC_BRIDGE_TUNNEL_URL="$UHOME/t.url" \
  CC_BRIDGE_TUNNEL_PROVIDER="$UHOME/t.provider" CC_BRIDGE_SPOKE_PIPE_PID="$UHOME/p.pid" \
  CC_BRIDGE_SPOKE_PIPE_PORT="$UHOME/p.port" CC_BRIDGE_SPOKE_PIPE_TICKET="$UHOME/p.ticket" \
  bash "$REPO_DIR/claude-bridge" uninstall >/dev/null 2>&1
if [ -f "$SENTINEL" ]; then
  ok "scoped uninstall: real /tmp/claude-bridge-* state survives (sentinel intact)"
else
  bad "scoped uninstall WIPED real /tmp state (sentinel gone) — live-share killer regressed!"
fi
rm -f "$SENTINEL"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
