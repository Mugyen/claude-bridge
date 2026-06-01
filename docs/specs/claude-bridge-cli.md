# `claude-bridge` CLI — design spec

Turn `install.sh` into a proper subcommand CLI, symlinked onto PATH as
`claude-bridge`. Approved decisions: **bash (evolve install.sh, zero-dep)**,
**auto PATH install (sudo `/usr/local/bin`, fallback `~/.local/bin`)**,
**foundation + the 4 lifecycle bug fixes first**.

Honors the owner's vision: all UX stays in `install.sh` (now reachable as
`claude-bridge`), zero runtime dependency, not chatty by default (verbose output
is opt-in via `status`/`doctor`; everything is logged to a file).

## Invocation
- `claude-bridge <command> [args]` once installed on PATH.
- `./install.sh <command>` keeps working (same script).
- **Back-compat:** every old `--flag` (`--start`, `--stop`, `--restart`, `--check`,
  `--share`, `--join`, `--unlink`, `--stop-share`, `--uninstall`) stays as a hidden
  alias mapping to the corresponding verb. Nothing breaks.

## Commands (foundation)
| Command | What it does |
|---|---|
| `install` / `reinstall` | hooks + MCP + skill + Desktop config; **symlinks `claude-bridge` onto PATH** (auto location). Idempotent. |
| `start` | start the bridge; **detect-and-replace a foreign/stale `:7400` listener** (BUG-1/2) — no silent abort. |
| `stop` | graceful SIGTERM (sends `event: close`). |
| `restart [--force]` | stop+start; `--force` kills whatever holds `:7400` by listener (not just the PID file) and replaces it (BUG-1/2). |
| `status` | the old `--check` (role, ports, version, tunnel, sessions). |
| `doctor` | deep health report (see below). |
| `update` | `git pull` → `reinstall` → `restart` (the "pull ≠ restart" fix, OPS-4, made one command). |
| `uninstall` | remove skill, MCP registration, hooks from settings.json, dotfiles, PATH symlink, PID/runtime files (manifest + hardcoded fallback). Leaves a running bridge unless `--stop` given (lesson #15). |
| `share [--named-tunnel H] [--node N]` | become a hub (auto-installs cloudflared); `--named-tunnel` closes a mismatched running tunnel first (BUG-4). |
| `join <link>` | become a spoke; **restart on token-change** instead of a dropped `/link/reload` (BUG-3). |
| `unlink` / `stop-share` | leave hub / stop sharing (existing). |
| `logs [-f]` | tail `~/.claude/claude-bridge.log`. |
| `version` | print version + running-bridge version. |
| `help` | grouped, situational command list. |

## Logging
Every invocation appends one structured line to `~/.claude/claude-bridge.log`:
`<ISO-ts>  <command> <args>  → <result/exit>`. Created `0600`, rotated at ~5MB.
`doctor` surfaces the last failures; `logs` tails it. This is the "ideal workflow
checks a log" requirement.

## `doctor` checks (each ✓/✗/⚠ + a one-line fix)
1. Prereqs: node ≥18, jq, curl, cloudflared (hub only).
2. Bridge process: running? which PID/port? **does the running version match the
   repo** (the stale-bridge check — OPS-4)? PID-file vs actual-listener drift.
3. MCP: `bridge` registered in `claude mcp list` + Connected.
4. Hooks: all 5 present in settings.json, scripts executable.
5. Federation: role/token/hub coherent; **running-mode vs dotfile drift** (e.g.
   dotfile says spoke but process is still hub — the reload-didn't-take case);
   token present ⇒ liveness uses `/health/ping` not `/health`.
6. Tunnel (hub): cloudflared running + edge-connected (metrics `/ready` if available),
   `<host>` reachable.
7. Ports: `:7400`/`:7401` conflicts / foreign holders.
8. Recent errors from the log.

## The 4 bug fixes folded in
- **BUG-1** `start` silent-abort: guard the success `cat $PID_FILE`; detect a foreign listener and report clearly.
- **BUG-2** lifecycle can't manage a non-PID-file bridge: `restart --force` (and `start` when the port is held by an unmanaged bridge) act on the actual `:7400` **listener** (`lsof -ti:PORT -sTCP:LISTEN`), not just the PID file.
- **BUG-3** token-change can't hot-reload: when `join`/`share` change the token, **restart** the bridge instead of relying on `/link/reload` (which the old token rejects).
- **BUG-4** `--share --named-tunnel` ignored when a tunnel is open: only reuse a running tunnel if it matches the request; otherwise stop it and start the requested one.

## Out of scope (later passes)
- A `cloudflared` supervisor (systemd/launchd) generator (G2).
- Richer `doctor --fix` auto-remediation.
- Node rewrite (rejected — staying bash).

## Tests
- `test-process-mgmt.sh`: extend for `restart --force` replacing a foreign listener; `start` clear-error on a foreign holder.
- `test-share-flags.sh`: `--named-tunnel` replaces a mismatched tunnel.
- New `test-cli.sh`: verb dispatch + alias back-compat + `help`/`version`/`doctor` run clean + logging appends.
