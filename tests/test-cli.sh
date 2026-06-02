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
OUT=$(SH --join 'https://h.example' ); echo "$OUT" | grep -qi "token fragment" && ok "old --join flag still recognized (back-compat)" || bad "--join back-compat ($OUT)"

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

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
