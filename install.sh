#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"
SKILL_DIR="$HOME/.claude/skills/claude-bridge"
LEGACY_SKILL_DIR="$HOME/.claude/skills/cc-bridge"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
PID_FILE="/tmp/claude-bridge.pid"
PORT="${CC_BRIDGE_PORT:-7400}"
# Federation listener port. The cloudflared tunnel points HERE (the loopback-only
# link surface), NEVER at the main port — the main bridge stays unreachable from
# the LAN / internet. Defaults to PORT+1; override with CC_BRIDGE_FED_PORT.
FED_PORT="${CC_BRIDGE_FED_PORT:-$((PORT + 1))}"
VERSION_FILE="$HOME/.claude/.cc-bridge-version"
MANIFEST_FILE="$HOME/.claude/.cc-bridge-manifest"

# ── Federation (cross-network) config files ──────────────────────────────────
TOKEN_FILE="$HOME/.claude/.cc-bridge-token"
ROLE_FILE="$HOME/.claude/.cc-bridge-role"
HUB_FILE="$HOME/.claude/.cc-bridge-hub"
NODE_FILE="$HOME/.claude/.cc-bridge-node"
TUNNEL_PID_FILE="/tmp/claude-bridge-tunnel.pid"
TUNNEL_URL_FILE="/tmp/claude-bridge-tunnel.url"

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
ARG2="${2:-}"
ARG3="${3:-}"
case "${1:-}" in
  --uninstall)   ACTION="uninstall" ;;
  --check)       ACTION="check" ;;
  --start)       ACTION="start" ;;
  --stop)        ACTION="stop" ;;
  --restart)     ACTION="restart" ;;
  --share)       ACTION="share" ;;
  --join)        ACTION="join" ;;
  --unlink)      ACTION="unlink" ;;
  --stop-share)  ACTION="stop-share" ;;
  --help|-h)
    echo "Usage: ./install.sh [command]"
    echo ""
    echo "  (no args)         Install hooks, MCP server, skill, and Desktop config"
    echo "  --uninstall       Remove all claude-bridge configuration"
    echo "  --check           Verify installation without changing anything"
    echo "  --start           Start the bridge server (writes PID to $PID_FILE)"
    echo "  --stop            Stop the bridge server (graceful SIGTERM)"
    echo "  --restart         Stop then start the bridge server"
    echo ""
    echo "Cross-network federation (link bridges across machines):"
    echo "  --share [--named-tunnel <hostname>] [--node <id>]"
    echo "                    Become a hub: generate a token, open a tunnel, print a join link."
    echo "                    Default tunnel = Cloudflare quick tunnel (ephemeral URL, zero setup)."
    echo "                    --named-tunnel uses a pre-configured cloudflared named tunnel (stable URL)."
    echo "  --join '<link>'   Become a spoke: link your local bridge to a hub via its join link"
    echo "                    (https://host#token). Sessions stay on localhost."
    echo "  --unlink          Spoke leaves its hub (local sessions unaffected)."
    echo "  --stop-share      Hub stops sharing: closes the tunnel, keeps the bridge + token."
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
  # Poll the UNGATED /health/ping — the full /health is token-gated when sharing
  # is on, so an unauthenticated liveness probe must use the ping (else a hub that
  # came up fine would look like a failed start). /health/ping always responds.
  local up=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf --max-time 1 "http://localhost:$PORT/health/ping" >/dev/null 2>&1; then up=1; break; fi
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
  # Use the UNGATED /health/ping so this works even when sharing is on (the full
  # /health requires the token then). Ping reports role + node + sharing state.
  local ping
  ping=$(curl -sf --max-time 1 "http://localhost:${PORT}/health/ping" 2>/dev/null)
  if [ -n "$ping" ]; then
    local pid_info role node sharing
    role=$(echo "$ping" | jq -r '.role // "standalone"')
    node=$(echo "$ping" | jq -r '.node // "?"')
    sharing=$(echo "$ping" | jq -r '.sharing // false')
    if [ -f "$PID_FILE" ]; then pid_info=" (PID $(cat "$PID_FILE"))"; else pid_info=""; fi
    ok "Bridge running on port $PORT${pid_info}"
    if [ "$sharing" = "true" ]; then
      ok "Federation: role=$role node=$node (sharing ON)"
      if [ "$role" = "hub" ]; then
        ok "Link surface (loopback): http://127.0.0.1:${FED_PORT} (the tunnel points here, NOT the main port $PORT)"
      fi
      if [ -f "$TUNNEL_URL_FILE" ] && [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
        ok "Tunnel open: $(cat "$TUNNEL_URL_FILE") → 127.0.0.1:${FED_PORT}"
      elif [ "$role" = "hub" ]; then
        warn "Hub mode on but no tunnel running — run ./install.sh --share to open one"
      fi
    else
      ok "Federation: standalone (local only)"
    fi
  else
    warn "Bridge not running (start with: ./install.sh --start)"
  fi
}

# ── Federation (cross-network hub-and-spoke) ─────────────────────────────────

# Tell a RUNNING bridge to re-read its federation config WITHOUT a restart. A
# restart would drop every SSE client and can kill the calling session
# (DEVELOPER.md lesson #23a) — so --share/--join flip the role on a live bridge
# via the localhost-only /link/reload endpoint instead.
fed_reload() {
  # /link/reload is loopback-only AND token-gated (defense-in-depth) when a token
  # is configured. Send the token header if we have one so the reload is accepted.
  local hdr=()
  if [ -s "$TOKEN_FILE" ]; then hdr=(-H "X-Bridge-Token: $(cat "$TOKEN_FILE")"); fi
  curl -sf --max-time 2 -X POST "http://localhost:${PORT}/link/reload" "${hdr[@]}" -d '{}' >/dev/null 2>&1
}

fed_bridge_running() {
  curl -sf --max-time 1 "http://localhost:${PORT}/health/ping" >/dev/null 2>&1
}

ensure_token() {
  if [ ! -s "$TOKEN_FILE" ]; then
    mkdir -p "$(dirname "$TOKEN_FILE")"
    local tok
    if command -v openssl &>/dev/null; then
      tok=$(openssl rand -hex 32)
    else
      tok=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    fi
    printf '%s' "$tok" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    ok "Generated access token ($TOKEN_FILE)"
  else
    ok "Reusing existing access token"
  fi
}

ensure_node() {
  local explicit="$1"
  if [ -n "$explicit" ]; then
    printf '%s' "$explicit" > "$NODE_FILE"
  elif [ ! -s "$NODE_FILE" ]; then
    local host
    host=$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/^-*//;s/-*$//')
    [ -z "$host" ] && host="node"
    printf '%s' "$host" > "$NODE_FILE"
  fi
  ok "Node id: $(cat "$NODE_FILE")"
}

share_hub() {
  # Parse optional flags: --named-tunnel <hostname>, --node <id>
  local named_tunnel="" node_override=""
  shift_args=("$@")
  local i=0
  while [ $i -lt ${#shift_args[@]} ]; do
    case "${shift_args[$i]}" in
      --named-tunnel) i=$((i+1)); named_tunnel="${shift_args[$i]:-}" ;;
      --node)         i=$((i+1)); node_override="${shift_args[$i]:-}" ;;
    esac
    i=$((i+1))
  done

  if ! command -v cloudflared &>/dev/null; then
    fail "cloudflared not found — required to open a tunnel."
    echo "    Install it once (no account needed for a quick tunnel):"
    echo "      brew install cloudflared       # macOS"
    echo "      https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi

  ensure_token
  ensure_node "$node_override"
  printf '%s' "hub" > "$ROLE_FILE"
  : > "$HUB_FILE"   # a hub has no upstream hub URL

  # Bring the bridge up (or hot-reload a running one — never restart it).
  if fed_bridge_running; then
    fed_reload && ok "Hub mode enabled on the running bridge (no restart — sessions preserved)"
  else
    start_bridge
  fi

  local token
  token=$(cat "$TOKEN_FILE")

  # If a tunnel is already running, just reprint the current join link.
  if [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null && [ -s "$TUNNEL_URL_FILE" ]; then
    local existing
    existing=$(cat "$TUNNEL_URL_FILE")
    ok "Tunnel already open: $existing"
    echo ""
    echo "  Share this ONE command:"
    echo "    ./install.sh --join '${existing}#${token}'"
    echo ""
    return
  fi

  local tunnel_log="/tmp/claude-bridge-tunnel.log"
  : > "$tunnel_log"

  if [ -n "$named_tunnel" ]; then
    # Named tunnel: stable hostname on the user's own domain. The user must have
    # configured the tunnel + DNS route already (cloudflared tunnel route dns ...).
    # Tunnel the FED PORT (loopback-only link surface), never the main bridge port.
    nohup cloudflared tunnel --url "http://localhost:${FED_PORT}" run "$named_tunnel" >> "$tunnel_log" 2>&1 &
    echo "$!" > "$TUNNEL_PID_FILE"
    printf '%s' "https://${named_tunnel}" > "$TUNNEL_URL_FILE"
    ok "Named tunnel started ($named_tunnel)"
    echo ""
    echo "  Share this ONE command:"
    echo "    ./install.sh --join 'https://${named_tunnel}#${token}'"
    echo ""
  else
    # Quick tunnel: ephemeral *.trycloudflare.com URL, zero setup.
    # Tunnel the FED PORT (loopback-only link surface), never the main bridge port.
    nohup cloudflared tunnel --url "http://localhost:${FED_PORT}" >> "$tunnel_log" 2>&1 &
    echo "$!" > "$TUNNEL_PID_FILE"
    ok "Opening Cloudflare quick tunnel..."
    # NB: `set -e` + `pipefail` would abort on an empty grep (the pipeline exits
    # non-zero), so guard the substitution with `|| true`.
    local url=""
    for _ in $(seq 1 30); do
      url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" 2>/dev/null | head -1 || true)
      [ -n "$url" ] && break
      sleep 1
    done
    if [ -z "$url" ]; then
      fail "Tunnel did not report a URL — check $tunnel_log"
      exit 1
    fi
    printf '%s' "$url" > "$TUNNEL_URL_FILE"
    ok "Secure tunnel open (Cloudflare): $url"
    echo ""
    echo "  Share this ONE command:"
    echo "    ./install.sh --join '${url}#${token}'"
    echo ""
    echo "  Note: quick-tunnel URLs are ephemeral. If cloudflared restarts the URL"
    echo "  rotates — re-run ./install.sh --share to reprint the new join link, and"
    echo "  spokes must re-join. For an always-on URL, use --named-tunnel <hostname>."
    echo ""
  fi
  warn "Keep this set up while you want the link open. --stop-share closes the tunnel."
}

join_hub() {
  local link="$1"
  if [ -z "$link" ]; then
    fail "Usage: ./install.sh --join 'https://<host>#<token>'"
    exit 1
  fi
  # Split on the '#' fragment locally — the token never travels to a server.
  local host="${link%%#*}"
  local token="${link#*#}"
  if [ "$token" = "$link" ] || [ -z "$token" ]; then
    fail "Join link must include the token fragment: 'https://<host>#<token>'"
    exit 1
  fi
  host="${host%/}"

  mkdir -p "$(dirname "$TOKEN_FILE")"
  printf '%s' "$token" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
  printf '%s' "$host"  > "$HUB_FILE"
  printf '%s' "spoke"  > "$ROLE_FILE"
  ensure_node "${ARG3_NODE:-}"

  if fed_bridge_running; then
    fed_reload && ok "Spoke mode enabled on the running bridge (no restart)"
  else
    start_bridge
  fi
  ok "Linked to hub $host as node $(cat "$NODE_FILE")"
  echo ""
  echo "  Your sessions stay local. Other agents now appear in list_sessions"
  echo "  tagged with their node; target a specific remote session as name@node."
  echo ""
}

unlink_hub() {
  # Tell the hub we're leaving (graceful), then drop to standalone via reload.
  local host token node
  host=$(cat "$HUB_FILE" 2>/dev/null || echo "")
  token=$(cat "$TOKEN_FILE" 2>/dev/null || echo "")
  node=$(cat "$NODE_FILE" 2>/dev/null || echo "")
  if [ -n "$host" ] && [ -n "$token" ]; then
    curl -sf --max-time 3 -X POST "${host}/link/unregister" \
      -H "X-Bridge-Token: ${token}" -H "Content-Type: application/json" \
      -d "{\"node\":\"${node}\"}" >/dev/null 2>&1 && ok "Hub notified (unregistered)" || warn "Could not reach hub (it will prune us via liveness sweep)"
  fi
  : > "$HUB_FILE"
  printf '%s' "standalone" > "$ROLE_FILE"
  fed_reload && ok "Unlinked — back to standalone (local sessions unaffected)"
}

stop_share() {
  if [ -f "$TUNNEL_PID_FILE" ]; then
    local tp
    tp=$(cat "$TUNNEL_PID_FILE")
    if kill -0 "$tp" 2>/dev/null; then
      kill "$tp" 2>/dev/null && ok "Tunnel closed (PID $tp)"
    fi
    rm -f "$TUNNEL_PID_FILE" "$TUNNEL_URL_FILE"
  else
    warn "No tunnel PID file — nothing to close (the bridge keeps running)"
  fi
  # Drop to standalone but KEEP the token so re-sharing is fast.
  printf '%s' "standalone" > "$ROLE_FILE"
  fed_reload && ok "Hub mode disabled (token kept; bridge still running, sessions preserved)"
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
    # Register federation config files so --uninstall removes them even if they
    # are created later by --share/--join. (DEVELOPER.md: every install artifact
    # is in the manifest + the hardcoded cleanup fallback.)
    manifest_add FILE "$TOKEN_FILE"
    manifest_add FILE "$ROLE_FILE"
    manifest_add FILE "$HUB_FILE"
    manifest_add FILE "$NODE_FILE"
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
    # Kill the federation tunnel child if running (it's not the bridge; lesson #15
    # — uninstall does NOT stop the bridge server itself).
    if [ -f "$TUNNEL_PID_FILE" ]; then
      tp=$(cat "$TUNNEL_PID_FILE" 2>/dev/null || echo "")
      if [ -n "$tp" ] && kill -0 "$tp" 2>/dev/null; then
        kill "$tp" 2>/dev/null && ok "Closed federation tunnel (PID $tp)"
      fi
    fi
    # Federation config files (hardcoded fallback in case the manifest is missing).
    rm -f "$TOKEN_FILE" "$ROLE_FILE" "$HUB_FILE" "$NODE_FILE" && ok "Federation config removed (token, role, hub, node)"
    rm -f /tmp/claude-bridge-* /tmp/cc-bridge-* /tmp/claude-bridge.pid /tmp/cc-bridge.pid
    ok "Temp files cleaned (/tmp/{claude,cc}-bridge-* incl. tunnel pid/url)"
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

  share)
    echo ""
    echo "claude-bridge --share (become a hub)"
    echo "===================================="
    echo ""
    share_hub "$@"
    ;;

  join)
    echo ""
    echo "claude-bridge --join (become a spoke)"
    echo "====================================="
    echo ""
    ARG3_NODE=""
    # support: --join '<link>' --node <id>
    if [ "${3:-}" = "--node" ]; then ARG3_NODE="${4:-}"; fi
    join_hub "$ARG2"
    ;;

  unlink)
    unlink_hub
    ;;

  stop-share)
    stop_share
    ;;
esac
