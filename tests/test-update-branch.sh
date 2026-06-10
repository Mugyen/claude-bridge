#!/bin/bash
# `claude-bridge update [branch]` — branch switching against a scratch origin.
# Never touches the real repo's git state, the real HOME, or the real bridge.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$DIR")"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

# Isolation: scratch HOME (install steps write there), scratch port (no real
# bridge → no restart path), tool PATH WITHOUT `claude` (exercises the
# headless-update fix — update must not crash when claude is absent).
export HOME="$WORK/home"; mkdir -p "$HOME/.claude"
export CC_BRIDGE_PORT=7499
mkdir -p "$WORK/bin"
for t in git jq node curl; do
  p=$(command -v "$t") && ln -s "$p" "$WORK/bin/$t"
done
export PATH="$WORK/bin:/usr/bin:/bin"

# ── Scratch origin: bare clone of this repo, default branch forced to main,
#    plus a beta branch carrying a marker file. The WORKING-TREE claude-bridge is
#    committed into BOTH branches so the code under test is the current code,
#    not whatever HEAD was last committed (bit us: an uncommitted do_update ran
#    as its old committed version and every assertion misfired).
git clone --quiet --bare "$REPO" "$WORK/origin.git" 2>/dev/null
git -C "$WORK/origin.git" symbolic-ref HEAD refs/heads/main
git clone --quiet "$WORK/origin.git" "$WORK/clone" 2>/dev/null
git -C "$WORK/clone" config user.email t@t; git -C "$WORK/clone" config user.name t
cp "$REPO/claude-bridge" "$WORK/clone/claude-bridge"
git -C "$WORK/clone" add claude-bridge && git -C "$WORK/clone" commit --quiet -m wt-cli
git -C "$WORK/clone" push --quiet origin main 2>/dev/null
git -C "$WORK/clone" checkout --quiet -b beta-test 2>/dev/null
echo beta > "$WORK/clone/BETA_MARKER"
git -C "$WORK/clone" add BETA_MARKER && git -C "$WORK/clone" commit --quiet -m beta
git -C "$WORK/clone" push --quiet origin beta-test 2>/dev/null
git -C "$WORK/clone" checkout --quiet main 2>/dev/null

# symlink_cli guard: a claude-bridge already on PATH pointing at the clone makes
# symlink_cli early-return instead of touching /usr/local/bin (real machine!).
ln -s "$WORK/clone/claude-bridge" "$WORK/bin/claude-bridge"
chmod +x "$WORK/clone/claude-bridge" "$WORK/clone"/hooks/*.sh 2>/dev/null

CB="$WORK/clone/claude-bridge"

# ── Case 1: update <branch> switches to it and pulls
OUT=$("$CB" update beta-test 2>&1; echo "RC=$?")
[ "$(git -C "$WORK/clone" rev-parse --abbrev-ref HEAD)" = "beta-test" ] \
  && ok "update <branch>: switched to beta-test" || bad "update <branch>: on $(git -C "$WORK/clone" rev-parse --abbrev-ref HEAD)"
[ -f "$WORK/clone/BETA_MARKER" ] \
  && ok "update <branch>: branch content present (BETA_MARKER)" || bad "update <branch>: BETA_MARKER missing"
echo "$OUT" | grep -q "Now tracking branch 'beta-test'" \
  && ok "update <branch>: prints tracking warning" || bad "update <branch>: no tracking warning"
echo "$OUT" | grep -q "RC=0" \
  && ok "update <branch>: exit 0 (incl. headless install steps, no claude on PATH)" || bad "update <branch>: non-zero exit ($(echo "$OUT" | tail -3))"

# ── Case 2: bare update returns to the default branch (main)
OUT=$("$CB" update 2>&1; echo "RC=$?")
[ "$(git -C "$WORK/clone" rev-parse --abbrev-ref HEAD)" = "main" ] \
  && ok "bare update: back on main" || bad "bare update: on $(git -C "$WORK/clone" rev-parse --abbrev-ref HEAD)"
[ ! -f "$WORK/clone/BETA_MARKER" ] \
  && ok "bare update: branch content gone" || bad "bare update: BETA_MARKER still present"
echo "$OUT" | grep -q "RC=0" && ok "bare update: exit 0" || bad "bare update: non-zero exit"

# ── Case 3: unknown branch fails clearly, stays on current branch
OUT=$("$CB" update no-such-branch 2>&1; echo "RC=$?")
echo "$OUT" | grep -q "not found on origin" \
  && ok "unknown branch: clear error" || bad "unknown branch: no error message"
echo "$OUT" | grep -q "RC=1" && ok "unknown branch: exit 1" || bad "unknown branch: exit code wrong"
[ "$(git -C "$WORK/clone" rev-parse --abbrev-ref HEAD)" = "main" ] \
  && ok "unknown branch: still on main" || bad "unknown branch: branch changed!"

echo ""; echo "test-update-branch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
