# Changelog

All notable changes to cc-bridge are documented here. Each release section is
written while the version is in development and finalized when it ships.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), semver.

## [Unreleased]

_Add entries here as you work on the next version. Move them under a dated
heading when you tag the release and bump `package.json` + the banner in
`bridge-server.mjs`._

### Added
- Project-level `CLAUDE.md` at the repo root that `@`-references `DEVELOPER.md`,
  so Claude Code sessions running inside this repo auto-load the maintainer
  guide. New "First-time setup if you're a developer of this repo" section
  in `DEVELOPER.md` explains the convention.
- Explicit "Documentation update checklist" table near the top of
  `DEVELOPER.md` — hard rule that every code change updates at least one
  MD file, with a per-file mapping of when each one applies.

## [2.2.0] - 2026-05-11

### Added
- **Version tracking** — `install.sh` writes `~/.claude/.cc-bridge-version`
  on install and reports installed vs repo version on `--check`.
- **Install manifest** — `~/.claude/.cc-bridge-manifest` records every path
  the installer touched; the uninstaller reads it back so future versions
  can clean up files an older `install.sh` wouldn't know about. Hardcoded
  cleanup still runs as a belt-and-suspenders fallback.
- **`DEVELOPER.md`** — primary maintainer notes: owner's vision, 15
  hard-learned lessons, release checklist, what NOT to do.
- **`tests/` folder** — runnable test suite (`./tests/run-all.sh` or
  `npm test`). Covers tool behaviour, broadcast input validation,
  graceful shutdown SSE close event, hook MCP-check silencing, install.sh
  process management. Add a test here for every new feature.
- **`CHANGELOG.md`** — this file. Update it whenever you work on a version.

### Changed
- Repo renamed from `claude-code-sessions-bridge` → `claude-bridge`. URLs
  and clone instructions updated in `USAGE.md`. Remote `origin` is now
  `git@github.com:vijay2411/claude-bridge.git`.

## [2.1.0] - 2026-05-11

### Added
- **Bridge protocol skill** — installs to `~/.claude/skills/cc-bridge/SKILL.md`
  using Claude Code's native skill infrastructure. Loads on-demand instead
  of permanently bloating every session's context.
- **Process management** — `./install.sh --start | --stop | --restart` and
  PID file at `/tmp/cc-bridge.pid`. Graceful SIGTERM closes SSE connections
  with an `event: close` notification before exiting, preventing connected
  Claude sessions from crashing.
- **Hook MCP-check** — `SessionStart` hook caches `claude mcp list` result
  in `/tmp/cc-bridge-${SESSION_ID}.mcp`. Other hooks read the cache and
  exit silently when the bridge MCP isn't registered, eliminating nag
  spam in pre-install sessions.
- **Tool schema table** in `USAGE.md` documenting required/optional args
  for all 8 MCP tools.
- **"What gets modified" section** in `USAGE.md` listing every file
  install.sh touches.
- **`check_inbox` tool** for hookless clients (Desktop app) to enumerate
  pending questions without polling `get_thread` per session.
- **Auto-targeting `reply`** — `message_id` is optional when exactly one
  pending question exists.

### Changed
- Replaced the legacy ~/.claude/CLAUDE.md append with the skill model.
  Installer automatically cleans up the legacy section.
- Softened README "battle-tested" claim to "used daily across 2–5
  sessions" — more honest first impression.

### Fixed
- **broadcast() crash on bad input** (`Cannot read properties of undefined`).
  Now validates `content` is a string and returns a clean error instead of
  killing the Node process.
- **No error boundary around tool calls** — all `executeTool` invocations
  are wrapped in try/catch. Global `uncaughtException` and
  `unhandledRejection` handlers added as a final safety net.

## [2.0.0] - 2026-05-10

### Added
- Initial public release at
  `github.com:vijay2411/claude-code-sessions-bridge`.
- MCP-over-SSE server (`bridge-server.mjs`) on port 7400 with 8 tools:
  `register`, `list_sessions`, `ask`, `reply`, `get_thread`, `broadcast`,
  `read_scratchpad`, plus the foundations for `check_inbox` (added in 2.1).
- 5 lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`,
  `Stop`, `SessionEnd`) for Claude Code CLI auto-registration, question
  injection, and cleanup.
- stdio adapter (`bridge-stdio.mjs`) so the Claude Desktop app (macOS)
  can join via stdio MCP transport.
- 30-day in-memory TTL garbage collection for messages, threads,
  sessions, and scratchpads.
- Ghost-session cleanup on `register()` reconnect via `claude_session_id`.
- Pending-ask migration on rename/reconnect (never fail an in-flight ask).
- Automated `install.sh` (CLI + Desktop), `--check`, `--uninstall`.
- README, USAGE.md, BRIDGE.md.

[Unreleased]: https://github.com/vijay2411/claude-bridge/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/vijay2411/claude-bridge/releases/tag/v2.2.0
[2.1.0]: https://github.com/vijay2411/claude-bridge/releases/tag/v2.1.0
[2.0.0]: https://github.com/vijay2411/claude-bridge/releases/tag/v2.0.0
