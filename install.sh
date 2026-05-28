#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"
SKILL_DIR="$HOME/.claude/skills/claude-bridge"
LEGACY_SKILL_DIR="$HOME/.claude/skills/cc-bridge"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
PID_FILE="/tmp/claude-bridge.pid"
PORT="${CC_BRIDGE_PORT:-7400}"
VERSION_FILE="$HOME/.claude/.cc-bridge-version"
MANIFEST_FILE="$HOME/.claude/.cc-bridge-manifest"

# Read version from package.json
VERSION=$(jq -r '.version // "unknown"' "$REPO_DIR/package.json" 2>/dev/null || echo "unknown")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

# ── Argument parsing ────────────────────────────────────────────────────────

ACTION="install"
case "${1:-}" in
  --uninstall) ACTION="uninstall" ;;
  --check)     ACTION="check" ;;
  --start)     ACTION="start" ;;
  --stop)      ACTION="stop" ;;
  --restart)   ACTION="restart" ;;
  --help|-h)
    echo "Usage: ./install.sh [--uninstall | --check | --start | --stop | --restart | --help]"
    echo ""
    echo "  (no args)    Install claude-bridge hooks, MCP server, skill, and Desktop config"
    echo "  --uninstall  Remove all claude-bridge configuration"
    echo "  --check      Verify installation without changing anything"
    echo "  --start      Start the bridge server (writes PID to $PID_FILE)"
    echo "  --stop       Stop the bridge server (graceful SIGTERM)"
    echo "  --restart    Stop then start the bridge server"
    exit 0
    ;;
esac

# ── Version + manifest tracking ────────────────────────────────────────────
#
# The manifest records every artifact this install touched, with its absolute
# path. The uninstaller reads it back so future versions can clean up files
# that an older install.sh wouldn't know about. Format: one path per line,
# prefixed with a directive: FILE, DIR, or HOOK_PATH (for grep-based cleanup).

manifest_init() {
  mkdir -p "$(dirname "$MANIFEST_FILE")"
  {
    echo "# claude-bridge install manifest — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# version: $VERSION"
    echo "# repo: $REPO_DIR"
  } > "$MANIFEST_FILE"
}

manifest_add() {
  local kind="$1" path="$2"
  echo "${kind}=${path}" >> "$MANIFEST_FILE"
}

manifest_uninstall() {
  if [ ! -f "$MANIFEST_FILE" ]; then
    return 1
  fi

  local prior_version
  prior_version=$(grep -E '^# version:' "$MANIFEST_FILE" | awk '{print $3}')
  echo "  Found manifest from version $prior_version"

  while IFS='=' read -r kind value; do
    [ -z "$kind" ] && continue
    case "$kind" in
      FILE)
        if [ -f "$value" ]; then
          rm -f "$value" && ok "Removed file: $value"
        fi
        ;;
      DIR)
        if [ -d "$value" ]; then
          rm -rf "$value" && ok "Removed dir: $value"
        fi
        ;;
    esac
  done < "$MANIFEST_FILE"

  rm -f "$MANIFEST_FILE" "$VERSION_FILE"
  return 0
}

write_version() {
  mkdir -p "$(dirname "$VERSION_FILE")"
  echo "$VERSION" > "$VERSION_FILE"
}

# ── Prerequisites ───────────────────────────────────────────────────────────

check_prereqs() {
  local all_ok=true

  if command -v node &>/dev/null; then
    local ver
    ver=$(node -e "console.log(process.version.slice(1).split('.')[0])")
    if [ "$ver" -ge 18 ] 2>/dev/null; then
      ok "Node.js v$(node -e "process.stdout.write(process.version)")"
    else
      fail "Node.js >= 18 required (found v$(node -e "process.stdout.write(process.version)"))"
      all_ok=false
    fi
  else
    fail "Node.js not found (install from https://nodejs.org)"
    all_ok=false
  fi

  if command -v jq &>/dev/null; then
    ok "jq $(jq --version 2>&1)"
  else
    fail "jq not found (brew install jq)"
    all_ok=false
  fi

  if command -v curl &>/dev/null; then
    ok "curl available"
  else
    fail "curl not found"
    all_ok=false
  fi

  if command -v claude &>/dev/null; then
    ok "Claude Code CLI available"
  else
    fail "Claude Code CLI not found (install from https://docs.anthropic.com/en/docs/claude-code)"
    all_ok=false
  fi

  $all_ok
}

# ── Hook configuration ─────────────────────────────────────────────────────

HOOK_MAP='
{
  "SessionStart": "bridge-start-hook.sh",
  "UserPromptSubmit": "bridge-prompt-hook.sh",
  "PostToolUse": "bridge-hook.sh",
  "Stop": "bridge-stop-hook.sh",
  "SessionEnd": "bridge-end-hook.sh"
}
'

install_hooks() {
  mkdir -p "$(dirname "$SETTINGS")"

  if [ ! -f "$SETTINGS" ]; then
    echo '{}' > "$SETTINGS"
  fi

  local tmp
  tmp=$(mktemp)
  cp "$SETTINGS" "$tmp"

  for event in SessionStart UserPromptSubmit PostToolUse Stop SessionEnd; do
    local script
    script=$(echo "$HOOK_MAP" | jq -r --arg e "$event" '.[$e]')
    local cmd="$REPO_DIR/hooks/$script"

    local existing
    existing=$(jq -r --arg e "$event" '
      .hooks[$e] // [] | map(select(.hooks[]?.command | test("bridge"))) | length
    ' "$tmp" 2>/dev/null || echo "0")

    if [ "$existing" != "0" ]; then
      jq --arg e "$event" --arg cmd "$cmd" '
        .hooks[$e] = [.hooks[$e][] | if (.hooks[]?.command | test("bridge")) then .hooks[0].command = $cmd else . end]
      ' "$tmp" > "${tmp}.new" && mv "${tmp}.new" "$tmp"
    else
      jq --arg e "$event" --arg cmd "$cmd" '
        .hooks //= {} |
        .hooks[$e] //= [] |
        .hooks[$e] += [{"matcher": "", "hooks": [{"type": "command", "command": $cmd}]}]
      ' "$tmp" > "${tmp}.new" && mv "${tmp}.new" "$tmp"
    fi
  done

  mv "$tmp" "$SETTINGS"
  ok "Hooks configured in $SETTINGS"
}

remove_hooks() {
  if [ ! -f "$SETTINGS" ]; then
    warn "No settings.json found"
    return
  fi

  local tmp
  tmp=$(mktemp)

  jq '
    .hooks //= {} |
    .hooks |= with_entries(
      .value |= map(select(.hooks | all(.command | test("bridge") | not)))
    ) |
    .hooks |= with_entries(select(.value | length > 0))
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"

  ok "Bridge hooks removed from $SETTINGS"
}

check_hooks() {
  if [ ! -f "$SETTINGS" ]; then
    fail "No settings.json found"
    return 1
  fi

  local count
  count=$(jq '[.hooks // {} | to_entries[] | .value[] | select(.hooks[]?.command | test("bridge"))] | length' "$SETTINGS" 2>/dev/null || echo "0")

  if [ "$count" -eq 5 ]; then
    ok "All 5 hooks configured"
  elif [ "$count" -gt 0 ]; then
    warn "$count/5 hooks configured (run install to fix)"
  else
    fail "No bridge hooks found"
    return 1
  fi
}

# ── MCP server ──────────────────────────────────────────────────────────────

install_mcp() {
  if claude mcp list 2>/dev/null | grep -q "bridge"; then
    ok "MCP server already registered"
  else
    claude mcp add --transport sse --scope user bridge "http://localhost:${PORT}/sse" 2>/dev/null
    ok "MCP server registered (scope: user, port: $PORT)"
  fi
}

remove_mcp() {
  claude mcp remove bridge 2>/dev/null && ok "MCP server removed" || warn "MCP server was not registered"
}

check_mcp() {
  if claude mcp list 2>/dev/null | grep -q "bridge"; then
    ok "MCP server registered"
  else
    fail "MCP server not registered"
    return 1
  fi
}

# ── Skill (replaces old CLAUDE.md append) ──────────────────────────────────

install_skill() {
  # Migrate legacy cc-bridge skill directory if present
  if [ -d "$LEGACY_SKILL_DIR" ] && [ "$LEGACY_SKILL_DIR" != "$SKILL_DIR" ]; then
    rm -rf "$LEGACY_SKILL_DIR"
    ok "Removed legacy skill at $LEGACY_SKILL_DIR"
  fi

  mkdir -p "$SKILL_DIR"
  cp "$REPO_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
  manifest_add DIR "$SKILL_DIR"
  ok "Bridge protocol skill installed to $SKILL_DIR"
}

remove_skill() {
  local removed=0
  if [ -d "$SKILL_DIR" ]; then
    rm -rf "$SKILL_DIR"
    ok "Bridge protocol skill removed ($SKILL_DIR)"
    removed=1
  fi
  if [ -d "$LEGACY_SKILL_DIR" ] && [ "$LEGACY_SKILL_DIR" != "$SKILL_DIR" ]; then
    rm -rf "$LEGACY_SKILL_DIR"
    ok "Legacy skill removed ($LEGACY_SKILL_DIR)"
    removed=1
  fi
  [ "$removed" -eq 0 ] && warn "No bridge skill found"
}

check_skill() {
  if [ -f "$SKILL_DIR/SKILL.md" ]; then
    ok "Bridge protocol skill installed"
  else
    fail "Bridge protocol skill not found"
    return 1
  fi
}

# ── Legacy CLAUDE.md cleanup ──────────────────────────────────────────────

remove_claude_md_legacy() {
  local CLAUDE_MD="$HOME/.claude/CLAUDE.md"
  if [ ! -f "$CLAUDE_MD" ]; then
    return
  fi

  if grep -q "Bridge Communication Protocol" "$CLAUDE_MD" 2>/dev/null; then
    local tmp
    tmp=$(mktemp)
    awk '
      /^# Bridge Communication Protocol/ { skip=1; next }
      skip && /^# / { skip=0 }
      !skip { print }
    ' "$CLAUDE_MD" > "$tmp" && mv "$tmp" "$CLAUDE_MD"
    ok "Legacy bridge docs removed from $CLAUDE_MD"
  fi
}

# ── Claude Desktop app ──────────────────────────────────────────────────────

install_desktop() {
  if [ "$(uname)" != "Darwin" ]; then
    warn "Claude Desktop app config skipped (not macOS)"
    return
  fi

  local config_dir
  config_dir="$(dirname "$DESKTOP_CONFIG")"

  if [ ! -d "$config_dir" ]; then
    warn "Claude Desktop app not found (no config directory)"
    return
  fi

  if [ ! -f "$DESKTOP_CONFIG" ]; then
    echo '{}' > "$DESKTOP_CONFIG"
  fi

  # Migrate legacy "cc-bridge" key to "claude-bridge" if present
  if jq -e '.mcpServers["cc-bridge"]' "$DESKTOP_CONFIG" &>/dev/null; then
    local tmp
    tmp=$(mktemp)
    jq 'del(.mcpServers["cc-bridge"])' "$DESKTOP_CONFIG" > "$tmp" && mv "$tmp" "$DESKTOP_CONFIG"
    ok "Migrated legacy 'cc-bridge' Desktop config key"
  fi

  if jq -e '.mcpServers["claude-bridge"]' "$DESKTOP_CONFIG" &>/dev/null; then
    local tmp
    tmp=$(mktemp)
    jq --arg path "$REPO_DIR/bridge-stdio.mjs" '
      .mcpServers["claude-bridge"].args = [$path]
    ' "$DESKTOP_CONFIG" > "$tmp" && mv "$tmp" "$DESKTOP_CONFIG"
    ok "Desktop app config updated (path refreshed)"
  else
    local tmp
    tmp=$(mktemp)
    jq --arg path "$REPO_DIR/bridge-stdio.mjs" '
      .mcpServers //= {} |
      .mcpServers["claude-bridge"] = {
        "command": "node",
        "args": [$path]
      }
    ' "$DESKTOP_CONFIG" > "$tmp" && mv "$tmp" "$DESKTOP_CONFIG"
    ok "Desktop app config added (relaunch the app to activate)"
  fi
}

remove_desktop() {
  if [ ! -f "$DESKTOP_CONFIG" ]; then
    warn "No Desktop app config found"
    return
  fi

  local removed=0
  if jq -e '.mcpServers["claude-bridge"]' "$DESKTOP_CONFIG" &>/dev/null; then
    local tmp
    tmp=$(mktemp)
    jq 'del(.mcpServers["claude-bridge"]) | if .mcpServers == {} then del(.mcpServers) else . end' "$DESKTOP_CONFIG" > "$tmp" && mv "$tmp" "$DESKTOP_CONFIG"
    ok "Desktop app config removed (claude-bridge — relaunch the app)"
    removed=1
  fi
  if jq -e '.mcpServers["cc-bridge"]' "$DESKTOP_CONFIG" &>/dev/null; then
    local tmp
    tmp=$(mktemp)
    jq 'del(.mcpServers["cc-bridge"]) | if .mcpServers == {} then del(.mcpServers) else . end' "$DESKTOP_CONFIG" > "$tmp" && mv "$tmp" "$DESKTOP_CONFIG"
    ok "Legacy Desktop config key removed (cc-bridge)"
    removed=1
  fi
  [ "$removed" -eq 0 ] && warn "claude-bridge not in Desktop app config"
}

check_desktop() {
  if [ "$(uname)" != "Darwin" ]; then
    warn "Claude Desktop app check skipped (not macOS)"
    return
  fi

  if [ ! -f "$DESKTOP_CONFIG" ]; then
    warn "No Desktop app config found"
    return
  fi

  if jq -e '.mcpServers["claude-bridge"]' "$DESKTOP_CONFIG" &>/dev/null; then
    local configured_path
    configured_path=$(jq -r '.mcpServers["claude-bridge"].args[0]' "$DESKTOP_CONFIG")
    if [ -f "$configured_path" ]; then
      ok "Desktop app configured (stdio adapter: $configured_path)"
    else
      fail "Desktop app configured but stdio adapter not found at: $configured_path"
    fi
  elif jq -e '.mcpServers["cc-bridge"]' "$DESKTOP_CONFIG" &>/dev/null; then
    warn "Legacy 'cc-bridge' Desktop config key present — re-run install to migrate to 'claude-bridge'"
  else
    ok "Desktop app not configured (optional)"
  fi
}

# ── Bridge server process management ──────────────────────────────────────

start_bridge() {
  if [ -f "$PID_FILE" ]; then
    local old_pid
    old_pid=$(cat "$PID_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      warn "Bridge already running (PID $old_pid, port $PORT)"
      return
    else
      rm -f "$PID_FILE"
    fi
  fi

  nohup node "$REPO_DIR/bridge-server.mjs" >> /tmp/claude-bridge-server.log 2>&1 &
  local child=$!

  # Verify the server actually came up — don't trust the PID file alone. The
  # server writes the PID file only AFTER a successful bind, so a bind failure
  # (EADDRINUSE) would otherwise look like a silent "no PID file" while leaving a
  # child process behind. Poll /health, and reap the child if it never serves.
  local up=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf --max-time 1 "http://localhost:$PORT/health" >/dev/null 2>&1; then up=1; break; fi
    sleep 0.3
  done

  if [ -n "$up" ] && [ -f "$PID_FILE" ]; then
    ok "Bridge started (PID $(cat "$PID_FILE"), port $PORT, log: /tmp/claude-bridge-server.log)"
  else
    kill "$child" 2>/dev/null
    fail "Bridge failed to start on port $PORT — check /tmp/claude-bridge-server.log"
  fi
}

stop_bridge() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      sleep 1
      ok "Bridge stopped (PID $pid)"
    else
      rm -f "$PID_FILE"
      warn "Bridge was not running (stale PID file cleaned)"
    fi
  else
    local pids
    pids=$(lsof -ti:"$PORT" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill 2>/dev/null
      sleep 1
      ok "Bridge stopped (found by port $PORT)"
    else
      warn "Bridge is not running"
    fi
  fi
}

check_bridge() {
  if curl -sf --max-time 1 "http://localhost:${PORT}/health" &>/dev/null; then
    local sessions pid_info
    sessions=$(curl -sf --max-time 1 "http://localhost:${PORT}/health" | jq '.sessions | length')
    if [ -f "$PID_FILE" ]; then
      pid_info=" (PID $(cat "$PID_FILE"))"
    else
      pid_info=""
    fi
    ok "Bridge running on port $PORT${pid_info} ($sessions active sessions)"
  else
    warn "Bridge not running (start with: ./install.sh --start)"
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

case "$ACTION" in
  install)
    echo ""
    echo "claude-bridge installer (v$VERSION)"
    echo "==================="
    echo ""
    echo "Checking prerequisites..."
    if ! check_prereqs; then
      echo ""
      fail "Missing prerequisites. Install them and try again."
      exit 1
    fi
    echo ""
    echo "Installing..."
    chmod +x "$REPO_DIR"/hooks/*.sh
    manifest_init
    write_version
    echo ""
    echo "Claude Code CLI:"
    install_hooks
    install_mcp
    install_skill
    remove_claude_md_legacy
    echo ""
    echo "Claude Desktop App:"
    install_desktop
    echo ""
    echo "Done! Start the bridge:"
    echo ""
    echo "  ./install.sh --start"
    echo ""
    echo "Already-open Claude sessions need to be restarted to pick up the new MCP server."
    echo ""
    echo "CLI sessions auto-register. Desktop app needs a relaunch,"
    echo "then tell it: \"Register on the bridge as 'desktop'\""
    echo ""
    ;;

  uninstall)
    echo ""
    echo "claude-bridge uninstaller (running v$VERSION)"
    echo "====================="
    echo ""

    # Detect prior installed version
    if [ -f "$VERSION_FILE" ]; then
      PRIOR=$(cat "$VERSION_FILE")
      echo "Detected prior install: v$PRIOR"
    else
      echo "No version marker found — running full cleanup of all known artifacts"
    fi
    echo ""

    echo "Manifest-tracked artifacts:"
    if ! manifest_uninstall; then
      warn "No manifest found (this is an old install or fresh checkout)"
    fi
    echo ""

    # Always run the full known-cleanup steps too — covers anything the
    # manifest missed and handles installs that predate manifest tracking.
    echo "Standard cleanup (hooks, MCP, legacy docs, Desktop, temp):"
    remove_hooks
    remove_mcp
    remove_skill
    remove_claude_md_legacy
    remove_desktop
    rm -f /tmp/claude-bridge-* /tmp/cc-bridge-* /tmp/claude-bridge.pid /tmp/cc-bridge.pid
    ok "Temp files cleaned (/tmp/{claude,cc}-bridge-*)"
    rm -f "$VERSION_FILE"
    echo ""
    echo "Done. Stop any running bridge server: ./install.sh --stop"
    echo "Relaunch Claude Desktop app if it was configured."
    echo ""
    ;;

  check)
    echo ""
    echo "claude-bridge status (repo v$VERSION)"
    echo "================"
    echo ""
    if [ -f "$VERSION_FILE" ]; then
      INSTALLED=$(cat "$VERSION_FILE")
      if [ "$INSTALLED" = "$VERSION" ]; then
        ok "Installed version: v$INSTALLED (matches repo)"
      else
        warn "Installed version: v$INSTALLED (repo is v$VERSION — re-run install to upgrade)"
      fi
    else
      warn "No version marker — install may predate manifest tracking, or never installed"
    fi
    echo ""
    echo "Prerequisites:"
    check_prereqs || true
    echo ""
    echo "Claude Code CLI:"
    check_hooks || true
    check_mcp || true
    check_skill || true
    echo ""
    echo "Claude Desktop App:"
    check_desktop
    echo ""
    echo "Server:"
    check_bridge
    echo ""
    ;;

  start)
    start_bridge
    ;;

  stop)
    warn "Stopping the bridge disconnects every Claude session whose MCP client is on it —"
    warn "including the session running this command. Run this from a SEPARATE terminal, not"
    warn "from a Claude session bound to this bridge. (See DEVELOPER.md lesson #23.)"
    stop_bridge
    ;;

  restart)
    warn "Restarting the bridge disconnects every Claude session whose MCP client is on it —"
    warn "including the session running this command, which the harness may then kill. Run this"
    warn "from a SEPARATE terminal, not from a Claude session bound to this bridge. (lesson #23)"
    stop_bridge
    start_bridge
    ;;
esac
