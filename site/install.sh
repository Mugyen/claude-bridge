#!/usr/bin/env bash
# claude-bridge bootstrap installer.
#
# One-line install:
#   curl -fsSL https://vijay2411.github.io/claude-bridge/install.sh | bash
#
# Clones the repo to ~/.local/share/claude-bridge (override with
# CLAUDE_BRIDGE_HOME), then runs the in-repo install.sh.
set -euo pipefail

INSTALL_DIR="${CLAUDE_BRIDGE_HOME:-$HOME/.local/share/claude-bridge}"
REPO_URL="https://github.com/vijay2411/claude-bridge.git"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

echo ""
echo "claude-bridge bootstrap installer"
echo "================================="
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────────
echo "Checking prerequisites..."
missing=0
for cmd in node jq curl git; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd"
  else
    fail "$cmd not found"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  echo ""
  fail "Install missing prerequisites and re-run."
  echo "  macOS: brew install node jq git"
  echo "  Linux: use your distro package manager"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo ""
  warn "Claude Code CLI (\`claude\`) not found."
  warn "Install from https://docs.anthropic.com/en/docs/claude-code first."
  warn "Continuing anyway — install.sh will recheck."
fi

# ── Clone or update ────────────────────────────────────────────────────────
echo ""
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing checkout at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" reset --hard origin/main
  ok "Updated"
else
  echo "Cloning to $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned"
fi

# ── Run repo installer ─────────────────────────────────────────────────────
echo ""
"$INSTALL_DIR/install.sh"

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
echo "Installed to: $INSTALL_DIR"
echo ""
echo "Start the bridge:"
echo "  $INSTALL_DIR/install.sh --start"
echo ""
