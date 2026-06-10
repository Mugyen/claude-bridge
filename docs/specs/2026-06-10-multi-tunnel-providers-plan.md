# Multi-Tunnel Provider Support (Phases 1+2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded (and SSE-broken-by-default) cloudflared quick-tunnel logic in the `claude-bridge` bash CLI with a provider-dispatch layer supporting six transports — dumbpipe P2P (new default), cloudflared named/quick, bore, pinggy, zrok, and tailscale-direct — with verified teardown, an EXPOSED status surface, docs, and tests.

**Architecture:** All changes live in the `claude-bridge` bash CLI (the server is transport-agnostic and untouched except zero lines — `CC_BRIDGE_FED_BIND` already exists and is NOT used; tailscale mode uses `tailscale serve --tcp` L4 forwarding so the fed listener stays loopback). Each provider implements four case-dispatched functions (`ensure`, `launch`, `extract`, `teardown`). Hub state generalizes from "a cloudflared PID + URL" to "a provider name + PID + URL/ticket" via one new state file. P2P adds a spoke-side forwarder (`dumbpipe connect-tcp`) managed by `join`/`unlink`.

**Tech Stack:** bash 3.2-compatible (macOS default — NO associative arrays, no `${var,,}`), Node ≥18 present by prerequisite (used for free-port picking), curl, jq. Fake-binary test pattern from `tests/test-share-flags.sh`.

**Key research facts driving this (verified, June 2026):**
- Cloudflare quick tunnels buffer SSE until connection close — events through them NEVER arrive (cloudflared#1449; now in official docs). This breaks `/link/stream`. Named tunnels work (single connector only — two connectors on one named tunnel = CF load-balancing = intermittent 530/1033).
- `tailscale serve`/`funnel` HTTP mode also buffers SSE (opencode#16726). `serve --tcp` is L4 passthrough — safe. Serve config PERSISTS across reboots; teardown must run `serve --tcp <port> off` and status must parse `tailscale serve status`, not process checks.
- dumbpipe `listen-tcp` accepts ANY number of concurrent connections through one ticket ("Any number of connections can flow through a single dumb pipe"); iroh hole-punches with automatic relay fallback; connections E2E-encrypted; ticket = bearer credential.
- bore relays plaintext TCP (token + traffic readable by relay operator) — opt-in only, loud warning.
- pinggy free = 60-minute session ceiling, URL rotates per session — demo-grade, loud warning.
- ngrok free tier quotas (20k req/mo) disqualify it — NOT included.

**Previous-developer constraints (from bridge consult, 2026-06-10):**
- `health_cmd`/`doctor`/`uninstall`/`stop_share`/`check_bridge` ALL read `TUNNEL_PID_FILE`/`TUNNEL_URL_FILE` — every reader updated in the same task that generalizes the writers.
- Keep: `launch_cloudflared` detach hardening (setsid/nohup+disown+`</dev/null`) as generic `launch_tunnel`; EXIT-trap rc preservation; lesson #23 (share/stop-share/unlink = hot-reload only, never restart :7400); `port_listener_pid()` ss fallback (lsof blind on GCP VM); bracket-pkill (`[d]umbpipe`) to avoid self-match.
- `uninstall` captures runtime PIDs BEFORE the /tmp wipe — extend for new PID files.
- P2P spoke: `unlink` must POST `/link/unregister` BEFORE killing the forwarder; forwarder PID in its own env-overridable file; forwarder death → spoke reconnect loops ECONNREFUSED, so `doctor` checks forwarder liveness.
- Tests: ALWAYS set `CC_BRIDGE_TUNNEL_*` env overrides; ports 7497/7498 never 7400; per-provider extractor functions so the fake and the grep can't drift; fakes write the URL after a brief delay to exercise polling.

**File structure:**
- Modify: `claude-bridge` (all CLI work — state files ~line 37, `ensure_cloudflared` ~line 674, `launch_cloudflared` ~line 744, `share_hub` ~line 756, `join_hub` ~line 865, `unlink_hub` ~line 907, `stop_share` ~line 923, `check_bridge` ~line 592, `health_cmd` ~line 1070, `doctor` ~line 1022, `print_help` ~line 1174, uninstall case ~line 1262)
- Create: `tests/test-providers.sh` (fake-binary provider dispatch tests)
- Modify: `tests/test-share-flags.sh` (only if assertions break — back-compat must hold)
- Modify: `USAGE.md`, `CHANGELOG.md`, `DEVELOPER.md`, `package.json` (2.7.0 → 2.8.0), `README.md` (one line)

---

### Task 1: Generalize tunnel state + generic launch/teardown (behavior-preserving refactor)

**Files:**
- Modify: `claude-bridge:34-38` (state files), `claude-bridge:744-754` (launch), `claude-bridge:923-937` (stop_share), `claude-bridge:592-620` (check_bridge), `claude-bridge:1058-1060,1113-1127` (doctor/health readers), `claude-bridge:1306-1316` (uninstall PID capture)
- Test: `tests/test-providers.sh` (new — case 1)

- [ ] **Step 1: Write the failing test** — create `tests/test-providers.sh`:

```bash
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
echo "cloudflared-quick" > "$WORK/tunnel.provider"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
sleep 0.5
if kill -0 "$SLEEPER" 2>/dev/null; then bad "stop-share: tunnel process still alive"; kill -9 "$SLEEPER"; else ok "stop-share: tunnel process killed"; fi
[ ! -f "$WORK/tunnel.pid" ] && [ ! -f "$WORK/tunnel.url" ] && [ ! -f "$WORK/tunnel.provider" ] \
  && ok "stop-share: state files cleared" || bad "stop-share: state files remain"

echo ""; echo "test-providers: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `chmod +x tests/test-providers.sh && tests/test-providers.sh`
Expected: FAIL — "state files cleared" fails because `stop_share` doesn't know `tunnel.provider` yet.

- [ ] **Step 3: Implement.** In `claude-bridge`:

(a) After line 38 add the new state files:

```bash
TUNNEL_PROVIDER_FILE="${CC_BRIDGE_TUNNEL_PROVIDER:-/tmp/claude-bridge-tunnel.provider}"
# P2P spoke-side forwarder state (dumbpipe connect-tcp), same env-override pattern.
SPOKE_PIPE_PID_FILE="${CC_BRIDGE_SPOKE_PIPE_PID:-/tmp/claude-bridge-spoke-pipe.pid}"
SPOKE_PIPE_PORT_FILE="${CC_BRIDGE_SPOKE_PIPE_PORT:-/tmp/claude-bridge-spoke-pipe.port}"
SPOKE_PIPE_TICKET_FILE="${CC_BRIDGE_SPOKE_PIPE_TICKET:-/tmp/claude-bridge-spoke-pipe.ticket}"
```

(b) Rename `launch_cloudflared` → `launch_tunnel` (same body — it's already generic: `$1` log, rest = command). Keep a one-line alias for greppability is NOT needed; update the two call sites in `share_hub`.

(c) Replace `stop_share` with the generalized, verified version:

```bash
# Kill a recorded tunnel/forwarder PID and VERIFY it died (SIGTERM → wait → SIGKILL).
# $1 = pid file, $2 = human label. Returns 0 if dead/absent.
kill_recorded() {
  local pidf="$1" label="$2" tp
  [ -f "$pidf" ] || return 0
  tp=$(cat "$pidf" 2>/dev/null || echo "")
  rm -f "$pidf"
  [ -n "$tp" ] && kill -0 "$tp" 2>/dev/null || return 0
  kill "$tp" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$tp" 2>/dev/null || { ok "$label closed (PID $tp)"; return 0; }; sleep 0.3; done
  kill -9 "$tp" 2>/dev/null || true; sleep 0.3
  if kill -0 "$tp" 2>/dev/null; then warn "$label (PID $tp) did not die — kill it manually"; return 1; fi
  ok "$label closed (PID $tp, forced)"
}

stop_share() {
  local provider
  provider=$(cat "$TUNNEL_PROVIDER_FILE" 2>/dev/null || echo "")
  if [ "$provider" = "tailscale" ]; then
    provider_tailscale_teardown   # defined in Task 7; serve config persists — must be explicit
  elif [ -f "$TUNNEL_PID_FILE" ]; then
    kill_recorded "$TUNNEL_PID_FILE" "Tunnel${provider:+ ($provider)}"
  else
    warn "No tunnel PID file — nothing to close (the bridge keeps running)"
  fi
  rm -f "$TUNNEL_PID_FILE" "$TUNNEL_URL_FILE" "$TUNNEL_PROVIDER_FILE"
  # Drop to standalone but KEEP the token so re-sharing is fast.
  printf '%s' "standalone" > "$ROLE_FILE"
  fed_reload && ok "Hub mode disabled (token kept; bridge still running, sessions preserved)"
}
```

NOTE for this task only: `provider_tailscale_teardown` doesn't exist yet — guard the branch with `command -v tailscale` + a warn, or simply leave the `tailscale` case out until Task 7 (preferred: leave it out; Task 7 adds it). The test only exercises the PID path.

(d) `check_bridge` (line 609-613): replace the cloudflared-specific line with provider-aware output:

```bash
      if [ -f "$TUNNEL_URL_FILE" ]; then
        local prov; prov=$(cat "$TUNNEL_PROVIDER_FILE" 2>/dev/null || echo "tunnel")
        if [ "$prov" = "tailscale" ] || { [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; }; then
          ok "EXPOSED via $prov: $(cat "$TUNNEL_URL_FILE") → 127.0.0.1:${FED_PORT}"
        else
          fail "Share recorded ($prov: $(cat "$TUNNEL_URL_FILE")) but its process is DOWN — re-run: claude-bridge share"
        fi
      elif [ "$role" = "hub" ]; then
        warn "Hub mode on but no tunnel running — run ./claude-bridge --share to open one"
      fi
```

(e) `doctor` hub branch (line 1058-1060) and `health_cmd` hub branch (line 1113-1127): same generalization — replace the word "cloudflared" with the provider read from `$TUNNEL_PROVIDER_FILE`, and skip the `kill -0` process check when provider = tailscale (no PID; Task 7 adds `tailscale serve status` parsing). `health_cmd` end-to-end reachability check stays — but only for `http(s)://` URLs (skip for `p2p:` tickets; the spoke forwarder is the testable surface there).

(f) `uninstall` (line 1306-1316): capture BOTH pids before the /tmp wipe:

```bash
    tunnel_pid=$(cat "$TUNNEL_PID_FILE" 2>/dev/null || echo "")
    pipe_pid=$(cat "$SPOKE_PIPE_PID_FILE" 2>/dev/null || echo "")
```
…and after killing `tunnel_pid`, also kill `pipe_pid` the same way. Also: if `command -v tailscale` and `tailscale serve status 2>/dev/null | grep -q ":${FED_PORT}"`, run `tailscale serve --tcp ${FED_PORT} off 2>/dev/null || true` (belt-and-suspenders; full version in Task 7).

- [ ] **Step 4: Run the test — verify it passes**

Run: `tests/test-providers.sh`
Expected: 2 passed, 0 failed.

- [ ] **Step 5: Run the existing suite (no regressions)**

Run: `npm test`
Expected: all green — especially `test-share-flags.sh` (back-compat: `--share`/`--stop-share` flag behavior unchanged for cloudflared).

- [ ] **Step 6: Commit**

```bash
git add claude-bridge tests/test-providers.sh
git commit -m "refactor(cli): generalize tunnel state (provider file, launch_tunnel, verified stop_share)"
```

---

### Task 2: Provider dispatch skeleton + cloudflared as first provider (behavior-preserving)

**Files:**
- Modify: `claude-bridge` (`ensure_cloudflared` block → provider section; `share_hub` rewritten as dispatcher)
- Test: `tests/test-providers.sh` (case 2)

- [ ] **Step 1: Write the failing test** — append to `tests/test-providers.sh` before the summary lines:

```bash
# ── Case 2: share --provider cloudflared-quick uses the fake binary, records provider+URL
cat > "$WORK/bin/cloudflared" <<'FAKE'
#!/bin/bash
# fake cloudflared: emits a trycloudflare URL to stderr after a delay (exercises polling)
( sleep 1; echo "INF +-- https://fake-test.trycloudflare.com" >&2 ) 
exec sleep 300
FAKE
chmod +x "$WORK/bin/cloudflared"
# A bridge must be running for share (hot-reload path). Start a throwaway one.
CC_BRIDGE_TOKEN_FILE="$HOME/.claude/.cc-bridge-token" \
CC_BRIDGE_ROLE_FILE="$HOME/.claude/.cc-bridge-role" \
CC_BRIDGE_HUB_FILE="$HOME/.claude/.cc-bridge-hub" \
CC_BRIDGE_NODE_FILE="$HOME/.claude/.cc-bridge-node" \
node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 &
BRIDGE_PID=$!
sleep 1
"$REPO/claude-bridge" share --provider cloudflared-quick >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.provider" 2>/dev/null)" = "cloudflared-quick" ] \
  && ok "share: provider recorded" || bad "share: provider file wrong/missing"
grep -q "trycloudflare.com" "$WORK/tunnel.url" 2>/dev/null \
  && ok "share: URL extracted from fake" || bad "share: URL not extracted"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null
```

- [ ] **Step 2: Run to verify it fails** (`--provider` is not a recognized flag yet).

- [ ] **Step 3: Implement.** In `claude-bridge`, replace the `share_hub` flag parsing and body with a dispatcher, and wrap the existing cloudflared logic into provider functions. The provider contract (document it in a comment block above the section):

```bash
# ── Tunnel providers ─────────────────────────────────────────────────────────
# Contract — each provider implements (case-dispatched, bash-3.2 safe):
#   provider_<p>_ensure    : binary present (auto-install unless CC_BRIDGE_NO_AUTOINSTALL=1) → 0/1
#   provider_<p>_launch    : start detached via launch_tunnel; write TUNNEL_PID_FILE
#   provider_<p>_extract   : poll the log; print the public URL (or p2p:<ticket>) to stdout, empty = fail
#   provider_<p>_warn      : print provider-specific caveats (free-tier limits, plaintext, etc.)
# Shared state: TUNNEL_{PID,URL,PROVIDER}_FILE + tunnel log. The URL file holds
# whatever `join` consumes: https://host, http://host:port, or p2p:<ticket>.
# The tunnel ALWAYS points at FED_PORT (loopback link surface) — never $PORT.
```

`share_hub` becomes:

```bash
share_hub() {
  local provider="" named_tunnel="" node_override=""
  shift_args=("$@"); local i=0
  while [ $i -lt ${#shift_args[@]} ]; do
    case "${shift_args[$i]}" in
      --provider)     i=$((i+1)); provider="${shift_args[$i]:-}" ;;
      --p2p)          provider="p2p" ;;
      --tailscale)    provider="tailscale" ;;
      --stable)       i=$((i+1)); provider="cloudflared-named"; named_tunnel="${shift_args[$i]:-}" ;;
      --named-tunnel) i=$((i+1)); provider="cloudflared-named"; named_tunnel="${shift_args[$i]:-}" ;;  # back-compat
      --node)         i=$((i+1)); node_override="${shift_args[$i]:-}" ;;
    esac
    i=$((i+1))
  done
  # Default provider: p2p (dumbpipe) — zero-account, E2E-encrypted, SSE-safe.
  # (Flipped to p2p in Task 8; until then default stays cloudflared-quick.)
  [ -z "$provider" ] && provider="${CC_BRIDGE_PROVIDER:-cloudflared-quick}"
  case "$provider" in
    cloudflared-named) [ -z "$named_tunnel" ] && { fail "--stable needs a hostname: claude-bridge share --stable <host>"; exit 1; } ;;
    cloudflared-quick|p2p|bore|pinggy|zrok|tailscale) ;;
    cloudflared) provider="cloudflared-quick" ;;   # alias
    *) fail "Unknown provider '$provider'. Available: p2p (default), cloudflared-named (--stable <host>), cloudflared-quick, bore, pinggy, zrok, tailscale"; exit 1 ;;
  esac

  provider_${provider//-/_}_ensure || exit 1
  ensure_token
  ensure_node "$node_override"
  printf '%s' "hub" > "$ROLE_FILE"
  : > "$HUB_FILE"
  if fed_bridge_running; then
    fed_reload && ok "Hub mode enabled on the running bridge (no restart — sessions preserved)"
  else
    start_bridge
  fi
  local token; token=$(cat "$TOKEN_FILE")

  # Reuse a running share ONLY if it matches the request (provider + named host — BUG-4).
  if [ -s "$TUNNEL_URL_FILE" ] && [ "$(cat "$TUNNEL_PROVIDER_FILE" 2>/dev/null)" = "$provider" ]; then
    local existing alive=""
    existing=$(cat "$TUNNEL_URL_FILE")
    if [ "$provider" = "tailscale" ]; then
      tailscale serve status 2>/dev/null | grep -q ":${FED_PORT}" && alive=1
    elif [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then alive=1; fi
    if [ -n "$alive" ] && { [ -z "$named_tunnel" ] || [ "$existing" = "https://${named_tunnel}" ]; }; then
      ok "Share already open ($provider): $existing"
      print_join_link "$existing" "$token"
      return
    fi
    [ -n "$alive" ] && { warn "A different share is open ($existing) — closing it first"; stop_share_tunnel_only; }
  fi

  local tunnel_log="${CC_BRIDGE_TUNNEL_LOG:-/tmp/claude-bridge-tunnel.log}"
  : > "$tunnel_log"
  provider_${provider//-/_}_warn
  NAMED_TUNNEL_HOST="$named_tunnel" provider_${provider//-/_}_launch "$tunnel_log" || { fail "share failed to launch ($provider)"; exit 1; }
  local url=""
  url=$(provider_${provider//-/_}_extract "$tunnel_log")
  if [ -z "$url" ]; then fail "Share did not report a URL/ticket — check $tunnel_log"; exit 1; fi
  printf '%s' "$url" > "$TUNNEL_URL_FILE"
  printf '%s' "$provider" > "$TUNNEL_PROVIDER_FILE"
  ok "EXPOSED via $provider: $url → 127.0.0.1:${FED_PORT}"
  print_join_link "$url" "$token"
  warn "Keep this machine on while you want the link open. 'claude-bridge stop-share' closes it (verified)."
}

print_join_link() {
  echo ""
  echo "  Share this ONE command:"
  echo "    claude-bridge join '$1#$2'"
  echo ""
}

# Close just the tunnel process/state (used when switching providers mid-share),
# WITHOUT dropping hub role — unlike stop_share which goes standalone.
stop_share_tunnel_only() {
  local prov; prov=$(cat "$TUNNEL_PROVIDER_FILE" 2>/dev/null || echo "")
  if [ "$prov" = "tailscale" ]; then provider_tailscale_teardown 2>/dev/null || true
  else kill_recorded "$TUNNEL_PID_FILE" "Tunnel${prov:+ ($prov)}"; fi
  rm -f "$TUNNEL_PID_FILE" "$TUNNEL_URL_FILE" "$TUNNEL_PROVIDER_FILE"
  sleep 1
}
```

Note on `provider_${provider//-/_}_ensure` — bash 3.2 supports `${var//-/_}` substitution and computed function names via plain expansion; this is the dispatch mechanism (no associative arrays).

Cloudflared provider functions (wrap existing code — `ensure_cloudflared` body becomes `provider_cloudflared_common_ensure`, called by both):

```bash
provider_cloudflared_quick_ensure()  { provider_cloudflared_common_ensure; }
provider_cloudflared_named_ensure()  { provider_cloudflared_common_ensure; }
# provider_cloudflared_common_ensure = the existing ensure_cloudflared body, renamed.

provider_cloudflared_quick_warn() {
  echo ""
  echo -e "${RED}  ⚠  QUICK TUNNEL — BROKEN FOR THE BRIDGE, DEMO ONLY${NC}"
  echo -e "${RED}     Cloudflare quick tunnels BUFFER Server-Sent Events: spokes will register${NC}"
  echo -e "${RED}     but NEVER receive forwarded messages (confirmed: cloudflared#1449 +${NC}"
  echo -e "${RED}     official docs 'Quick Tunnels do not support SSE'). Use the default${NC}"
  echo -e "${RED}     instead:  claude-bridge share          (p2p — no account, encrypted)${NC}"
  echo -e "${RED}     or:       claude-bridge share --stable <host>   (your own domain)${NC}"
  echo ""
}
provider_cloudflared_named_warn() {
  warn "Named tunnel: run exactly ONE connector for this hostname — two connectors on one"
  warn "named tunnel get load-balanced by Cloudflare and the link flaps (530/1033)."
}

provider_cloudflared_quick_launch() {
  launch_tunnel "$1" cloudflared tunnel --url "http://localhost:${FED_PORT}"
}
provider_cloudflared_named_launch() {
  launch_tunnel "$1" cloudflared tunnel --url "http://localhost:${FED_PORT}" run "$NAMED_TUNNEL_HOST"
}

provider_cloudflared_quick_extract() {
  local url=""
  for _ in $(seq 1 30); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$1" 2>/dev/null | head -1 || true)
    [ -n "$url" ] && break; sleep 1
  done
  printf '%s' "$url"
}
provider_cloudflared_named_extract() { printf 'https://%s' "$NAMED_TUNNEL_HOST"; }
```

Delete the old `share_hub` body (lines 769-863) — fully replaced. The old red quick-tunnel box is replaced by `provider_cloudflared_quick_warn` (now stating the REAL reason: SSE buffering, not just "flappy").

- [ ] **Step 4: Run tests**

Run: `tests/test-providers.sh && npm test`
Expected: all green. `test-share-flags.sh` exercises `--share`/`--named-tunnel` paths — verify its fake-cloudflared still satisfies the extractor (same trycloudflare grep).

- [ ] **Step 5: Commit**

```bash
git add claude-bridge tests/test-providers.sh
git commit -m "feat(cli): provider-dispatch share with cloudflared quick/named as first providers"
```

---

### Task 3: Generic GitHub-release binary installer + bore provider

**Files:**
- Modify: `claude-bridge` (provider section)
- Test: `tests/test-providers.sh` (case 3)

- [ ] **Step 1: Failing test** — append:

```bash
# ── Case 3: share --provider bore extracts bore.pub URL from fake
cat > "$WORK/bin/bore" <<'FAKE'
#!/bin/bash
( sleep 1; echo "2026-06-10 listening at bore.pub:34567" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/bore"
node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 & BRIDGE_PID=$!
sleep 1
"$REPO/claude-bridge" share --provider bore >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "http://bore.pub:34567" ] \
  && ok "bore: URL extracted" || bad "bore: URL extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null
```

- [ ] **Step 2: Run to verify it fails** (unknown provider 'bore').

- [ ] **Step 3: Implement.** Generic installer (place above the provider section):

```bash
# Install a single-binary tool from its latest GitHub release. Resolves the asset
# via the GitHub API (asset names embed versions, so /latest/download/<name> can't
# be hardcoded). $1=owner/repo $2=binary-name $3=grep-pattern for this OS/arch.
# Tarballs and raw binaries both handled. Honors CC_BRIDGE_NO_AUTOINSTALL=1.
install_release_binary() {
  local repo="$1" bin="$2" pattern="$3"
  command -v "$bin" &>/dev/null && return 0
  if [ "${CC_BRIDGE_NO_AUTOINSTALL:-}" = "1" ]; then
    fail "$bin not found — required for this provider (auto-install disabled)."
    echo "      Install it from: https://github.com/$repo/releases"
    return 1
  fi
  warn "$bin not found — installing from github.com/$repo..."
  local api url tmp dir dest
  api=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null) || { fail "GitHub API unreachable"; return 1; }
  url=$(printf '%s' "$api" | grep -oE '"browser_download_url": *"[^"]+"' | cut -d'"' -f4 | grep -E "$pattern" | head -1 || true)
  [ -z "$url" ] && { fail "no release asset matching '$pattern' for $repo — install manually"; return 1; }
  tmp=$(mktemp -d)
  curl -fsSL "$url" -o "$tmp/asset" || { fail "download failed: $url"; rm -rf "$tmp"; return 1; }
  case "$url" in
    *.tar.gz|*.tgz) tar -xzf "$tmp/asset" -C "$tmp" 2>/dev/null; rm -f "$tmp/asset" ;;
    *.zip)          unzip -q "$tmp/asset" -d "$tmp" 2>/dev/null; rm -f "$tmp/asset" ;;
    *)              mv "$tmp/asset" "$tmp/$bin" ;;
  esac
  dir=$(find "$tmp" -name "$bin" -type f | head -1)
  [ -z "$dir" ] && { fail "binary '$bin' not found in release asset"; rm -rf "$tmp"; return 1; }
  chmod +x "$dir"
  if [ -w /usr/local/bin ]; then dest=/usr/local/bin/$bin
  else mkdir -p "$HOME/.local/bin"; dest="$HOME/.local/bin/$bin"; export PATH="$HOME/.local/bin:$PATH"; fi
  mv "$dir" "$dest"; rm -rf "$tmp"
  command -v "$bin" &>/dev/null && ok "$bin installed ($dest)" || { fail "$bin still not on PATH"; return 1; }
}

# OS/arch → release-asset grep pattern fragments.
release_pattern() { # $1 = rust|go style
  local os arch; os="$(uname -s)"; arch="$(uname -m)"
  case "$os-$arch" in
    Darwin-arm64)        echo 'aarch64-apple-darwin|darwin_arm64|darwin-arm64' ;;
    Darwin-x86_64)       echo 'x86_64-apple-darwin|darwin_amd64|darwin-amd64' ;;
    Linux-x86_64)        echo 'x86_64-unknown-linux|linux_amd64|linux-amd64' ;;
    Linux-aarch64|Linux-arm64) echo 'aarch64-unknown-linux|linux_arm64|linux-arm64' ;;
    *) echo "__unsupported__" ;;
  esac
}
```

bore provider:

```bash
provider_bore_ensure() { install_release_binary "ekzhang/bore" "bore" "$(release_pattern)"; }
provider_bore_warn() {
  warn "bore relays PLAINTEXT TCP through bore.pub: the relay operator can read the"
  warn "token and all bridge traffic. Use only for throwaway demos — prefer the"
  warn "default p2p mode (end-to-end encrypted) for anything real."
}
provider_bore_launch() { launch_tunnel "$1" bore local "${FED_PORT}" --to bore.pub; }
provider_bore_extract() {
  local hostport=""
  for _ in $(seq 1 20); do
    hostport=$(grep -oE 'bore\.pub:[0-9]+' "$1" 2>/dev/null | head -1 || true)
    [ -n "$hostport" ] && break; sleep 1
  done
  [ -n "$hostport" ] && printf 'http://%s' "$hostport"
}
```

- [ ] **Step 4: Run tests** — `tests/test-providers.sh && npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add claude-bridge tests/test-providers.sh
git commit -m "feat(cli): bore provider + generic GitHub-release binary installer"
```

---

### Task 4: pinggy provider (zero-install, ssh-based)

**Files:** same pattern as Task 3.

- [ ] **Step 1: Failing test** — append:

```bash
# ── Case 4: pinggy — fake ssh prints a pinggy URL; extractor picks the https one
cat > "$WORK/bin/ssh" <<'FAKE'
#!/bin/bash
( sleep 1; echo "http://abc123.a.free.pinggy.link"; echo "https://abc123.a.free.pinggy.link" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/ssh"
node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 & BRIDGE_PID=$!
sleep 1
"$REPO/claude-bridge" share --provider pinggy >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "https://abc123.a.free.pinggy.link" ] \
  && ok "pinggy: https URL extracted" || bad "pinggy: extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
rm -f "$WORK/bin/ssh"   # IMPORTANT: don't leave a fake ssh on PATH for later cases
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement:**

```bash
provider_pinggy_ensure() {
  command -v ssh &>/dev/null && return 0
  fail "ssh not found — pinggy needs the system ssh client"; return 1
}
provider_pinggy_warn() {
  warn "pinggy free tier: the session HARD-STOPS after 60 minutes and the URL rotates —"
  warn "spokes will need a fresh join link. Good for quick demos; for longer sessions"
  warn "use the default p2p mode or --stable <host>."
}
provider_pinggy_launch() {
  launch_tunnel "$1" ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 \
    -o ExitOnForwardFailure=yes -p 443 -R0:127.0.0.1:"${FED_PORT}" a.pinggy.io
}
provider_pinggy_extract() {
  local url=""
  for _ in $(seq 1 30); do
    url=$(grep -oE 'https://[a-z0-9.-]+\.pinggy\.link' "$1" 2>/dev/null | head -1 || true)
    [ -n "$url" ] && break; sleep 1
  done
  printf '%s' "$url"
}
```

- [ ] **Step 4: Run tests** → green. **Step 5: Commit** `feat(cli): pinggy provider (zero-install ssh tunnel)`.

---

### Task 5: zrok provider

**Files:** same pattern.

- [ ] **Step 1: Failing test** — append:

```bash
# ── Case 5: zrok — fake binary handles `status` (enabled) and `share` (emits URL)
cat > "$WORK/bin/zrok" <<'FAKE'
#!/bin/bash
if [ "$1" = "status" ]; then echo "OK: environment enabled"; exit 0; fi
( sleep 1; echo "https://fak3test.share.zrok.io" )
exec sleep 300
FAKE
chmod +x "$WORK/bin/zrok"
node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 & BRIDGE_PID=$!
sleep 1
"$REPO/claude-bridge" share --provider zrok >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "https://fak3test.share.zrok.io" ] \
  && ok "zrok: URL extracted" || bad "zrok: extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement:**

```bash
provider_zrok_ensure() {
  install_release_binary "openziti/zrok" "zrok" "$(release_pattern)" || return 1
  # zrok needs a ONE-TIME account enable (free): zrok invite → zrok enable <token>.
  if ! zrok status 2>/dev/null | grep -qi "enabled"; then
    fail "zrok is installed but this machine isn't enabled yet (one-time, free):"
    echo "      1. Create an account:   zrok invite     (or https://myzrok.io)"
    echo "      2. Enable this machine: zrok enable <your-account-token>"
    echo "      Then re-run: claude-bridge share --provider zrok"
    return 1
  fi
}
provider_zrok_warn() {
  warn "zrok free SaaS: bandwidth capped per rolling 24h + public shares rate-limited"
  warn "(~6.6 req/s). Fine for bridge traffic; self-host zrok to lift the caps."
}
provider_zrok_launch() {
  launch_tunnel "$1" zrok share public --headless "http://127.0.0.1:${FED_PORT}"
}
provider_zrok_extract() {
  local url=""
  for _ in $(seq 1 30); do
    url=$(grep -oE 'https://[a-z0-9]+\.share\.zrok\.io' "$1" 2>/dev/null | head -1 || true)
    [ -n "$url" ] && break; sleep 1
  done
  printf '%s' "$url"
}
```

- [ ] **Step 4: Run tests** → green. **Step 5: Commit** `feat(cli): zrok provider (TLS + one-time free account)`.

---

### Task 6: dumbpipe P2P — hub provider + spoke forwarder in join/unlink

**Files:**
- Modify: `claude-bridge` (provider section; `join_hub`; `unlink_hub`; `doctor`)
- Test: `tests/test-providers.sh` (cases 6a/6b)

- [ ] **Step 1: Failing tests** — append:

```bash
# ── Case 6a: share --p2p extracts the ticket as p2p:<ticket>
cat > "$WORK/bin/dumbpipe" <<'FAKE'
#!/bin/bash
if [ "$1" = "listen-tcp" ]; then
  ( sleep 1; echo "To connect, use e.g.:"; echo "dumbpipe connect-tcp nodeaafake7ticket3string9xyz" ) 
  exec sleep 300
fi
if [ "$1" = "connect-tcp" ]; then exec sleep 300; fi
FAKE
chmod +x "$WORK/bin/dumbpipe"
node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 & BRIDGE_PID=$!
sleep 1
"$REPO/claude-bridge" share --p2p >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "p2p:nodeaafake7ticket3string9xyz" ] \
  && ok "p2p: ticket extracted" || bad "p2p: ticket extraction failed (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1

# ── Case 6b: join 'p2p:<ticket>#<token>' spawns the forwarder + writes localhost HUB_FILE
"$REPO/claude-bridge" join 'p2p:nodeaafake7ticket3string9xyz#deadbeef' >/dev/null 2>&1
hub=$(cat "$HOME/.claude/.cc-bridge-hub" 2>/dev/null)
case "$hub" in http://127.0.0.1:*) ok "p2p join: HUB_FILE is localhost forwarder ($hub)";; *) bad "p2p join: HUB_FILE wrong: $hub";; esac
[ -f "$WORK/pipe.pid" ] && kill -0 "$(cat "$WORK/pipe.pid")" 2>/dev/null \
  && ok "p2p join: forwarder running" || bad "p2p join: forwarder not running"
[ "$(cat "$WORK/pipe.ticket" 2>/dev/null)" = "nodeaafake7ticket3string9xyz" ] \
  && ok "p2p join: ticket recorded" || bad "p2p join: ticket file wrong"
"$REPO/claude-bridge" unlink >/dev/null 2>&1
sleep 0.5
[ ! -f "$WORK/pipe.pid" ] || ! kill -0 "$(cat "$WORK/pipe.pid" 2>/dev/null)" 2>/dev/null \
  && ok "unlink: forwarder killed" || bad "unlink: forwarder still alive"
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement.**

Hub side:

```bash
provider_p2p_ensure() { install_release_binary "n0-computer/dumbpipe" "dumbpipe" "$(release_pattern)"; }
provider_p2p_warn() {
  ok "p2p mode: end-to-end encrypted QUIC, no account, no public URL. NAT traversal is"
  ok "automatic (relay fallback if hole-punching fails). The ticket admits anyone who"
  ok "holds it — treat the whole join link as a secret."
}
provider_p2p_launch() { launch_tunnel "$1" dumbpipe listen-tcp --host "127.0.0.1:${FED_PORT}"; }
provider_p2p_extract() {
  local t=""
  for _ in $(seq 1 30); do
    t=$(grep -oE 'connect-tcp +[a-z0-9]+' "$1" 2>/dev/null | head -1 | awk '{print $2}' || true)
    [ -n "$t" ] && break; sleep 1
  done
  [ -n "$t" ] && printf 'p2p:%s' "$t"
}
```

Spoke side — in `join_hub`, after the token split (line 872-878) insert ticket handling:

```bash
  # P2P link: 'p2p:<ticket>#<token>' — spawn a local dumbpipe forwarder and treat
  # http://127.0.0.1:<port> as the hub URL. connectToHub picks http by protocol;
  # everything downstream (HUB_FILE, fed_reload, heartbeats) is unchanged.
  if case "$host" in p2p:*) true;; *) false;; esac; then
    local ticket="${host#p2p:}"
    provider_p2p_ensure || exit 1
    # Replace any previous forwarder (re-join with a new ticket).
    kill_recorded "$SPOKE_PIPE_PID_FILE" "Old p2p forwarder"
    local lport
    lport=$(node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
    local pipe_log="${CC_BRIDGE_TUNNEL_LOG:-/tmp/claude-bridge-tunnel.log}.spoke"
    : > "$pipe_log"
    # Same detach hardening as the hub tunnel; record the PID in the pipe's own file.
    if command -v setsid >/dev/null 2>&1; then
      setsid dumbpipe connect-tcp --addr "127.0.0.1:${lport}" "$ticket" >> "$pipe_log" 2>&1 < /dev/null &
    else
      nohup dumbpipe connect-tcp --addr "127.0.0.1:${lport}" "$ticket" >> "$pipe_log" 2>&1 < /dev/null &
    fi
    local ppid=$!
    echo "$ppid" > "$SPOKE_PIPE_PID_FILE"; disown "$ppid" 2>/dev/null || true
    printf '%s' "$lport"  > "$SPOKE_PIPE_PORT_FILE"
    printf '%s' "$ticket" > "$SPOKE_PIPE_TICKET_FILE"
    sleep 1
    kill -0 "$ppid" 2>/dev/null || { fail "p2p forwarder died on start — check $pipe_log"; exit 1; }
    ok "p2p forwarder up (PID $ppid): 127.0.0.1:${lport} → hub ticket ${ticket:0:16}…"
    host="http://127.0.0.1:${lport}"
  fi
```

`unlink_hub` — unregister FIRST (already does, via the existing curl), THEN kill the forwarder. Add after the `: > "$HUB_FILE"` line:

```bash
  kill_recorded "$SPOKE_PIPE_PID_FILE" "p2p forwarder"
  rm -f "$SPOKE_PIPE_PORT_FILE" "$SPOKE_PIPE_TICKET_FILE"
```

`doctor` — in the spoke branch (line 1053-1057), add forwarder liveness:

```bash
  if [ "$drole" = "spoke" ] && [ -f "$SPOKE_PIPE_TICKET_FILE" ]; then
    if [ -f "$SPOKE_PIPE_PID_FILE" ] && kill -0 "$(cat "$SPOKE_PIPE_PID_FILE" 2>/dev/null)" 2>/dev/null; then
      ok "p2p forwarder up (ticket $(cut -c1-16 "$SPOKE_PIPE_TICKET_FILE")…)"
    else
      fail "p2p forwarder DOWN — the hub is unreachable. Re-join: claude-bridge join 'p2p:$(cat "$SPOKE_PIPE_TICKET_FILE")#<token>'"
    fi
  fi
```

Also `health_cmd` spoke branch: same check (hub reachability through 127.0.0.1 forwarder already covered by the existing `$hub/health/ping` probe).

NOTE: `kill_recorded` is used by `join_hub` which can run before any share — it already handles the absent-file case. The `case…esac` boolean wrapper avoids bash 3.2 `[[ == p2p:* ]]` (works, but the codebase avoids `[[`).

- [ ] **Step 4: Run tests** — `tests/test-providers.sh && npm test` → green.

- [ ] **Step 5: Commit** `feat(cli): dumbpipe p2p provider — hub ticket share + spoke forwarder join/unlink`

---

### Task 7: tailscale-direct provider (serve --tcp, no tunnel process)

**Files:**
- Modify: `claude-bridge` (provider section; the Task-1 stop_share/`stop_share_tunnel_only` tailscale branches now resolve)
- Test: `tests/test-providers.sh` (case 7)

- [ ] **Step 1: Failing test** — append:

```bash
# ── Case 7: tailscale — fake CLI; share uses serve --tcp; stop-share runs serve off
cat > "$WORK/bin/tailscale" <<'FAKE'
#!/bin/bash
case "$1" in
  status) if [ "$2" = "--json" ]; then echo '{"BackendState":"Running","Self":{"DNSName":"myhost.tail1234.ts.net."}}'; else echo "running"; fi ;;
  serve)
    echo "$@" >> "${TAILSCALE_FAKE_LOG:-/tmp/ts-fake.log}"
    if [ "$2" = "status" ]; then cat "${TAILSCALE_FAKE_STATE:-/dev/null}" 2>/dev/null; exit 0; fi
    case " $* " in
      *" off "*) : > "${TAILSCALE_FAKE_STATE}" ;;
      *) echo "|-- tcp://myhost.tail1234.ts.net:7498 -> tcp://127.0.0.1:7498" > "${TAILSCALE_FAKE_STATE}" ;;
    esac ;;
esac
FAKE
chmod +x "$WORK/bin/tailscale"
export TAILSCALE_FAKE_LOG="$WORK/ts.log" TAILSCALE_FAKE_STATE="$WORK/ts.state"
export CC_BRIDGE_FED_PORT=7498
node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 & BRIDGE_PID=$!
sleep 1
"$REPO/claude-bridge" share --tailscale >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.url" 2>/dev/null)" = "http://myhost.tail1234.ts.net:7498" ] \
  && ok "tailscale: URL built from MagicDNS" || bad "tailscale: URL wrong (got: $(cat "$WORK/tunnel.url" 2>/dev/null))"
grep -q -- "--tcp" "$WORK/ts.log" 2>/dev/null \
  && ok "tailscale: used serve --tcp (L4, no SSE buffering)" || bad "tailscale: did not use --tcp"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
grep -q "off" "$WORK/ts.log" 2>/dev/null && [ ! -s "$WORK/ts.state" ] \
  && ok "tailscale: serve torn down (config persists otherwise!)" || bad "tailscale: serve NOT torn down"
unset CC_BRIDGE_FED_PORT
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement:**

```bash
provider_tailscale_ensure() {
  command -v tailscale &>/dev/null || { fail "tailscale not installed — https://tailscale.com/download"; return 1; }
  local state
  state=$(tailscale status --json 2>/dev/null | jq -r '.BackendState // "?"')
  [ "$state" = "Running" ] || { fail "tailscale is not up (state: $state) — run: tailscale up"; return 1; }
}
provider_tailscale_warn() {
  ok "tailscale mode: tailnet-only (NOT public internet), WireGuard-encrypted, no extra"
  ok "process. Spokes must be on the SAME tailnet. Uses 'serve --tcp' (L4 passthrough —"
  ok "the HTTP serve/funnel modes buffer SSE and would silently break the bridge)."
}
provider_tailscale_launch() {
  # serve --tcp is L4: the fed listener stays loopback; tailscaled forwards the
  # tailnet-side port to it. --bg persists it (survives this shell). NO PID file —
  # tailscaled owns it; teardown/status go through the serve CLI, not processes.
  tailscale serve --bg --tcp "${FED_PORT}" "tcp://127.0.0.1:${FED_PORT}" >> "$1" 2>&1
}
provider_tailscale_extract() {
  local dns
  dns=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')
  [ -n "$dns" ] && printf 'http://%s:%s' "$dns" "${FED_PORT}"
}
provider_tailscale_teardown() {
  if command -v tailscale &>/dev/null; then
    tailscale serve --tcp "${FED_PORT}" off 2>/dev/null || true
    # Serve config PERSISTS across reboots — verify it's actually gone.
    if tailscale serve status 2>/dev/null | grep -q ":${FED_PORT} "; then
      warn "tailscale serve still lists :${FED_PORT} — run: tailscale serve --tcp ${FED_PORT} off"
    else
      ok "tailscale serve for :${FED_PORT} torn down (verified)"
    fi
  fi
}
```

In Task 1's `stop_share`/`stop_share_tunnel_only`, the `provider_tailscale_teardown` branch now resolves — remove any guard added there. In `share_hub`, the launch step for tailscale must NOT write a PID file (launch_tunnel would) — note `provider_tailscale_launch` calls `tailscale serve --bg` directly (foreground command that returns immediately), NOT via `launch_tunnel`. The dispatcher works unchanged because the reuse/alive checks already special-case tailscale (Task 2).

IMPLEMENTATION CHECK (live machines, not fakes): `tailscale serve --bg --tcp <port> <target>` syntax varies across tailscale versions (older: `tailscale serve tcp:<port> tcp://...`). During Task 10 live testing, verify on the installed version (`tailscale version`) on BOTH the Mac and the VM and adjust the launch line + a fallback if needed.

- [ ] **Step 4: Run tests** → green. **Step 5: Commit** `feat(cli): tailscale-direct provider via serve --tcp (L4 — SSE-safe)`

---

### Task 8: Flip the default to p2p + help text + EXPOSED in share output

**Files:**
- Modify: `claude-bridge` (`share_hub` default line; `print_help`)
- Test: `tests/test-providers.sh` (case 8)

- [ ] **Step 1: Failing test** — append:

```bash
# ── Case 8: bare `share` defaults to p2p (fake dumbpipe from case 6 still on PATH)
node "$REPO/bridge-server.mjs" --port 7497 >/dev/null 2>&1 & BRIDGE_PID=$!
sleep 1
"$REPO/claude-bridge" share >/dev/null 2>&1
[ "$(cat "$WORK/tunnel.provider" 2>/dev/null)" = "p2p" ] \
  && ok "default provider is p2p" || bad "default provider is $(cat "$WORK/tunnel.provider" 2>/dev/null), expected p2p"
"$REPO/claude-bridge" stop-share >/dev/null 2>&1
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null
```

- [ ] **Step 2: Run to verify it fails** (default is still cloudflared-quick).

- [ ] **Step 3: Implement.** In `share_hub`: `[ -z "$provider" ] && provider="${CC_BRIDGE_PROVIDER:-p2p}"`. Update `print_help` FEDERATION section:

```
FEDERATION (link bridges across machines)
  share                                Become a hub over an encrypted P2P pipe (default; no account, no public URL)
  share --stable <host>                Stable HTTPS URL on your own domain (cloudflared named tunnel; one connector only)
  share --tailscale                    Tailnet-only (both machines on your Tailscale network; no extra process)
  share --provider <p>                 Other tunnels: bore | pinggy | zrok | cloudflared-quick (see USAGE.md table)
  share [--node <id>]                  --node sets this machine's federation id (default: hostname)
  join '<link>'                        Become a spoke. Accepts https://host#token AND p2p:<ticket>#<token>
  unlink                               Spoke leaves its hub → standalone (kills the p2p forwarder too)
  stop-share                           Hub stops sharing — verified teardown (kills tunnel / serve off), keeps the bridge + token
```

- [ ] **Step 4: Run ALL tests** — `tests/test-providers.sh && npm test`. CHECK: `test-share-flags.sh` may invoke bare `--share` expecting fake cloudflared — if it breaks, fix THAT test to pass `--provider cloudflared-quick` explicitly (its purpose is flag parsing, not default choice).

- [ ] **Step 5: Commit** `feat(cli)!: default share transport is now p2p (dumbpipe) — quick tunnels demoted (SSE-broken)`

---

### Task 9: Documentation pass (required by repo rules — every change updates MD files)

**Files:**
- Modify: `CHANGELOG.md`, `USAGE.md`, `DEVELOPER.md`, `README.md`, `package.json`

- [ ] **Step 1: `package.json`** version 2.7.0 → 2.8.0; same in `bridge-server.mjs` startup banner (line ~1678).

- [ ] **Step 2: `CHANGELOG.md`** under `[Unreleased]`:

```markdown
### Added
- Multi-tunnel provider dispatch for `share`: p2p (dumbpipe, NEW DEFAULT), cloudflared named (`--stable <host>`), cloudflared quick, bore, pinggy, zrok, tailscale-direct (`--tailscale`, via `serve --tcp`).
- `join` accepts `p2p:<ticket>#<token>` links — spawns a local dumbpipe forwarder (managed by `unlink`/`doctor`/uninstall).
- Verified teardown: `stop-share` confirms the tunnel process died (and `tailscale serve` config is removed — it persists otherwise).
- EXPOSED status line in `share`/`status`/`health`/`doctor` showing provider + URL/ticket + liveness.
- Generic GitHub-release binary auto-installer (bore, dumbpipe, zrok), `CC_BRIDGE_NO_AUTOINSTALL=1` honored.

### Changed
- **Default share transport is now p2p (dumbpipe)** — encrypted end-to-end, no account, no public URL, multi-spoke through one ticket.
- Cloudflared QUICK tunnels demoted to opt-in `--provider cloudflared-quick` with a corrected warning: they BUFFER SSE (events never arrive) per cloudflared#1449 + official docs — the prior "flappy" warning understated it.

### Fixed
- `stop-share`/`uninstall` no longer leave provider processes or persistent tailscale serve config behind (verified teardown, both PID files captured before the /tmp wipe).
```

- [ ] **Step 3: `USAGE.md`** — update the share/join section with the provider table (the one-screen version):

| Command | Transport | Account? | Encrypted? | Notes |
|---|---|---|---|---|
| `share` | dumbpipe P2P (default) | No | E2E (QUIC) | No public URL; ticket+token = the secret; any number of spokes |
| `share --stable <host>` | cloudflared named | Cloudflare + domain | TLS | Stable URL; run ONE connector per hostname |
| `share --tailscale` | tailnet `serve --tcp` | Tailscale | WireGuard | Same-tailnet only; no extra process |
| `share --provider zrok` | zrok | one-time free | TLS | 24h bandwidth window on free SaaS |
| `share --provider pinggy` | ssh | No | TLS | 60-MINUTE session cap; URL rotates |
| `share --provider bore` | bore.pub TCP | No | ⚠ PLAINTEXT relay | Demos only |
| `share --provider cloudflared-quick` | trycloudflare | No | TLS | ⚠ SSE-BROKEN: spokes never receive messages |

Plus: p2p join example, forwarder troubleshooting ("p2p forwarder DOWN" → re-join), `CC_BRIDGE_PROVIDER` env default, and the "What claude-bridge modifies" table gains the three new /tmp pipe files + tunnel.provider.

- [ ] **Step 4: `DEVELOPER.md`** — add lesson #32 (provider contract: the four functions, the state files, every-reader-updates-together rule, fake-binary test pattern incl. "fake ssh must be removed from PATH after its case") and #33 (the SSE-buffering table: CF quick + tailscale serve/funnel HTTP buffer SSE; serve --tcp/raw-TCP/QUIC safe; MS dev tunnels 504 at 15min; ngrok free quotas; named-tunnel single-connector rule). Update the architecture quick-reference file list (new /tmp files) and the `--share` description in the federation section.

- [ ] **Step 5: `README.md`** — one line in features: sharing works over an encrypted P2P pipe by default (no account, no tunnel service), with cloudflared/tailscale/zrok/bore/pinggy as alternatives. Do not bloat.

- [ ] **Step 6: Commit** `docs: provider table, SSE-buffering lessons, v2.8.0 changelog`

---

### Task 10: Live end-to-end testing (Mac + Linux VM)

No fakes — real transports, real federation. The user granted VM access (ssh sub-shell). Live tests are observational; record results in the final report, fix-forward any provider quirks found (especially the tailscale serve syntax check from Task 7 and the real dumbpipe output format vs the Task-6 extractor regex).

- [ ] **Step 1: Suite green locally** — `npm test` on the Mac.
- [ ] **Step 2: Real dumbpipe smoke (Mac only)** — `dumbpipe --version` (auto-install path), then `claude-bridge share` (real ticket extraction — adjust `provider_p2p_extract` regex to the real output if it drifts), `claude-bridge status` (EXPOSED line), `claude-bridge stop-share` (verified kill).
- [ ] **Step 3: Cross-machine p2p** — Mac hub: `claude-bridge share` → join link. VM (ssh): pull repo, `./claude-bridge install` (headless mode ok), `./claude-bridge join 'p2p:<ticket>#<token>'`. Verify: `claude-bridge health` on both shows the link; hub `/health` lists the VM node; send a real cross-machine notice via two Claude sessions if available, else `curl` the link surface from the VM through the forwarder (`curl http://127.0.0.1:<port>/health/ping` with token).
- [ ] **Step 4: Reconnect resilience** — kill the forwarder on the VM (`kill $(cat /tmp/claude-bridge-spoke-pipe.pid)`), confirm `doctor` flags it, re-join, confirm recovery. Kill the hub-side dumbpipe, re-share, confirm a NEW ticket is issued and the old one stops working.
- [ ] **Step 5: Real tailscale (if both machines are on the user's tailnet)** — `claude-bridge share --tailscale` on the Mac, VM joins via the ts.net URL. Verify the serve syntax on the installed version; verify `stop-share` actually removes the serve config (`tailscale serve status` empty).
- [ ] **Step 6: bore + pinggy smoke (Mac, 2 min each)** — share, confirm URL reachable (`curl <url>/health/ping`), stop-share, confirm dead. These verify the real log formats against the extractors.
- [ ] **Step 7: cloudflared named regression** — user's existing named tunnel still works through the new dispatcher: `claude-bridge share --stable <host>`.
- [ ] **Step 8: Round-trip** — `claude-bridge uninstall && ./claude-bridge install && claude-bridge doctor` clean on the Mac (use a separate terminal context per lesson #23; do NOT run uninstall from a bridge-connected Claude session — use the VM or warn the user first).
- [ ] **Step 9: Fix-forward + final commit** of any extractor/syntax adjustments, each with a one-line CHANGELOG note if user-visible.

---

## Self-review notes

- Spec coverage: provider dispatch ✓ (T2), all six providers ✓ (T2-T7), verified teardown ✓ (T1+T7), EXPOSED status ✓ (T1/T2/T8), default flip ✓ (T8), docs ✓ (T9), tests incl. VM ✓ (every task + T10). frp/rathole deliberately DESCOPED to a USAGE.md recipe note (self-hosted relay class needs a user-owned VPS — no CLI dispatch value yet); ngrok excluded (quota research).
- Types/names consistent: `kill_recorded`, `launch_tunnel`, `provider_<p>_{ensure,launch,extract,warn}`, `provider_tailscale_teardown`, `stop_share_tunnel_only`, `print_join_link`, state-file vars — single definition each, used consistently across tasks.
- bash 3.2: no `[[ ]]` pattern matches added (case-based), no associative arrays, `${var//-/_}` is 3.2-safe.
- Lesson #23 respected: share/stop-share/unlink/join only hot-reload; `start_bridge` only when not running.
- Lesson #29 respected: every provider tunnels FED_PORT only; tailscale serve --tcp targets 127.0.0.1:FED_PORT; fed listener bind untouched.
