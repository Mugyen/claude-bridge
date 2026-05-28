# Changelog

All notable changes to claude-bridge (originally cc-bridge) are documented here. Each release section is
written while the version is in development and finalized when it ships.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), semver.

## [Unreleased]

_Add entries here as you work on the next version. Move them under a dated
heading when you tag the release and bump `package.json` + the banner in
`bridge-server.mjs`._

### Added
- **`notify` tool — one-way NOTICE messages.** A fire-and-forget FYI from one session to
  another: non-blocking, no reply expected (`notify(to, content)`). Distinct from `ask`
  (blocks for an answer) and `broadcast` (pull-based shared scratchpad). Modelled as a new
  message `kind: "notice"` with a `delivered` flag — it carries no `answer`, so it can never
  show up as a pending question or be targeted by `reply`. Delivered exactly once through the
  same path as questions: `/pending` (hooks + idle-listener) and `check_inbox` surface it and
  mark it delivered; it also appears in `get_thread` history and migrates on rename/reconnect.
  The idle-listener's grep now matches `NOTICE from`, so a one-way message **wakes an idle
  teammate** — and the listener peeks (`/pending?peek=1`) so its own poll doesn't consume the
  notice before the woken agent reads it via `check_inbox` (consume-once delivery happens only
  on the real-delivery paths: the PostToolUse hook injection and `check_inbox`). Queues even
  when the target is offline (`target_online: false`) — note that, with auto-generated session
  names, a notice to a *stale* name is effectively a dead-letter (documented in USAGE.md).
  Brings the tool count to 9. Bumped to v2.6.0.
- **`notify` test coverage** in `tests/test-tools.mjs` (13 assertions: input validation,
  happy path, deliver-once via `/pending` and `check_inbox`, never-a-pending-question,
  thread inclusion, offline queueing, health notices count) plus a `test-monitor-trigger.sh`
  case asserting the arm command greps `NOTICE from`. Added a `pending()` REST helper to
  `tests/lib.mjs`.
- **Idle-listener (auto-armed monitor)** — closes the long-standing "idle session can't
  see new questions" gap. The first time a CLI session `ask`s or `reply`s, the PostToolUse
  hook nudges it (once) to arm a background `Monitor` that polls `/pending` every ~25s and
  wakes the agent **only when a new question arrives** — zero tokens while the inbox is
  empty (the loop runs in the shell, not the model; deduped by message id so a still-pending
  question never re-wakes). `register`/`list`/`inbox` do not trigger it — only engaging
  (ask/reply) does. Per-session state file `/tmp/claude-bridge-${SESSION_ID}.monitor`
  (`on`=agent armed it, `off`=user-disabled, absent=eligible) lets the user close it ("stop
  the bridge listener" → disables auto-run for the session) and re-enable it. The **agent**
  writes `on` once the Monitor is genuinely running; the hook re-nudges on every ask/reply
  until then, so a skipped nudge is retried rather than lost (it never pre-marks the session
  armed). Interval is configurable via `CC_BRIDGE_MONITOR_INTERVAL` (default 25). Bumped to
  v2.5.0.
- **`tests/test-monitor-trigger.sh`** — 8 assertions: only ask/reply trigger the nudge, the
  hook leaves state unwritten, it re-nudges while un-armed, goes silent once the agent writes
  `on` or the user writes `off`, re-nudges after re-enable, and the emitted command embeds the
  session name + interval + the `echo on` arm-confirm step. Runs against a dead port so it's
  isolated from any live bridge.

### Removed
- **npm package (`@vijay2411/claude-bridge`) and `bin/cli.mjs`** — the scoped npm package was wired up but never published. Removed entirely so the repo doesn't carry npm publishing infrastructure we don't intend to maintain. `package.json` is now marked `private: true`. Single install path is the curl bootstrap.

### Fixed
- **Hook MCP-cache fallthrough on mid-session installs.** When `claude-bridge` is
  installed during an already-open Claude Code session, the SessionStart hook
  never fired for that session, so `/tmp/claude-bridge-${SESSION_ID}.mcp` doesn't
  exist. The previous check only silenced output when the cache file existed and
  said `no`, which meant pre-install sessions kept getting nag spam on every
  tool call. Now each hook (PostToolUse, Stop, UserPromptSubmit) seeds the cache
  lazily on first run by running `claude mcp list` once and writing the result.
  Cost: ~1 second on the first tool call of a pre-install session; subsequent
  calls are instant.

### Added
- **Three new test cases** in `tests/test-hook-mcp-check.sh` covering the
  cache-missing path that the production bug exposed: cache-missing-and-bridge-absent
  (must seed `no` and exit silently), cache-missing-and-bridge-present (must seed
  `yes` and proceed). Uses a PATH-shimmed `claude` stub to simulate both outcomes
  deterministically. Suite is now 12 assertions (was 6).

### Changed
- `install.sh --check` no longer shows a yellow `!` for the Desktop app when it's
  simply not configured — the Desktop app is optional, so a missing config is
  green-checkmark "ok" status, not a warning.

### Changed
- **Project name rename: `cc-bridge` → `claude-bridge`** in all user-visible places (README title, server banners, MCP `serverInfo.name`, hook output messages, Desktop config key `mcpServers["claude-bridge"]`, skill directory `~/.claude/skills/claude-bridge/`, skill `name:` frontmatter, JSON-LD `name`). `install.sh` auto-migrates: removes the legacy `~/.claude/skills/cc-bridge/` dir and the legacy `mcpServers["cc-bridge"]` Desktop key on re-install. Internal runtime paths (`/tmp/cc-bridge-*`, `CC_BRIDGE_*` env vars, `~/.claude/.cc-bridge-version`, `~/.claude/.cc-bridge-manifest`) are intentionally unchanged — they're implementation details and renaming them would break in-flight installs without benefit.
- Bumped to v2.4.0.

### Added
- **One-line installer** — `curl -fsSL https://vijay2411.github.io/claude-bridge/install.sh | bash`. Bootstrap script hosted on the Pages site clones the repo to `~/.local/share/claude-bridge` and runs the in-repo `install.sh`. Lives at `site/install.sh`.
- **Demo image at top of README** (`docs/demo.jpg`) showing two real Claude sessions chatting through the bridge — a Desktop session on the left, a CLI session on the right, with the bridge agent taking a victory lap. The "what this does" beats any prose pitch.
- **Install CTA on the site** copies the curl command to clipboard.
- **GitHub Pages deploy** — site shipped at <https://vijay2411.github.io/claude-bridge/>. `.github/workflows/deploy-pages.yml` deploys `site/` on every push to `main` that touches `site/**`. Canonical, og:url, twitter:image, sitemap, robots all point at the Pages URL.
- **Showcase site at `site/`** — single-page static landing built with the `anti-slop-frontend` skill workflow. Hero animation is a hand-sketched SVG node graph: 5 labeled Claude agents (frontend / backend / research / db / tests) connected with pencil-wobble lines, with message packets traveling along the wires and a live transcript mirroring the conversation. Editorial dark palette (warm-black + bone + acid-yellow + terracotta + dusty teal), JetBrains Mono display + Instrument Serif italic accents, no build step. Local preview: `cd site && python3 -m http.server 5173`.
- **SEO pass on `site/`** — full `<head>` metadata, Open Graph + Twitter Card with 1200x630 `og-image.png`, JSON-LD `SoftwareApplication` block, favicon set (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`), web app `manifest.json`, `robots.txt`, `sitemap.xml`, semantic HTML audit, skip-link, focus rings, SVG `<title>`/`<desc>`. Lighthouse: SEO/A11y/Best-Practices 100, Performance 91.
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
