# Changelog

All notable changes to claude-bridge (originally cc-bridge) are documented here. Each release section is
written while the version is in development and finalized when it ships.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), semver.

## [Unreleased]

_Add entries here as you work on the next version. Move them under a dated
heading when you tag the release and bump `package.json` + the banner in
`bridge-server.mjs`._

### Added (v2.9.0 — rooms, phase 3a)
- **Rooms with per-member tokens**: `room create <name> [--ttl <dur>] [--password [value]]` turns the flat shared-token group into real membership — each joining machine gets its OWN token, so `room kick <node>` revokes one machine without rotating everyone. Member = a bridge/machine; sessions stay local and oblivious.
- **Invites + password gate**: `room invite [--one-time] [--expires <dur>]` prints a complete join link (`…#invite:<code>`, default 7d); `join '<url>' --password` joins a password-gated room (scrypt-hashed; password never rides in a link). `/link/join` is the only unauthenticated link endpoint, behind a strict global rate bucket (10/min) against brute force.
- **Durable revocation**: rooms persist in `~/.claude/.cc-bridge-rooms.json` (0600, atomic writes, env-overridable `CC_BRIDGE_ROOMS_FILE`) — kicked stays kicked across restarts/reboots. Zero new dependencies (node:crypto scrypt).
- **Room lifecycle**: `room members/info/rotate <node>/rotate-password/delete <name>` (typed-name confirmation); TTL rooms self-expire (lazy + GC sweep). Kick/rotate/delete sever the member's live stream immediately. `health`/`doctor` show a room line.
- **E2EE envelope reserved (3b)**: messages can carry an opaque `enc` payload end-to-end through every relay/queue path without the hub reading it — the 3b encryption work slots in without protocol changes.

### Added (v2.9.0 — rendezvous codes, phase 4)
- **Speakable join codes**: `claude-bridge join mugyen-team` instead of pasting long links. `room invite --code [name]` (default name: the room's) and `share --code [name]` (default: the node id) publish the join link to a rendezvous service; `join <code>` resolves it. Codes are pure sugar — long links always work, and an unreachable rendezvous degrades to a warning.
- **The rendezvous itself** ships in `rendezvous/` — a ~100-line Cloudflare Worker + KV ("a phone book, not a relay"): open namespace (anyone publishes any code, first-come), per-code owner tokens (no hijacking while alive; renew/update/release), TTL'd (default 7d — an unrenewed dead hub's name frees up), rate-limited lookups. Deploy once with `wrangler deploy` (free tier, ~$0). Tested by running the REAL worker handler in-process (16 assertions) and the CLI against it served locally (8 assertions).
- Config: default URL baked as `DEFAULT_RENDEZVOUS`, overridable per machine via `CC_BRIDGE_RENDEZVOUS` or `~/.claude/.cc-bridge-rendezvous` (self-hosters point at their own Worker). Owner tokens persist in `~/.claude/.cc-bridge-codes` (0600).

### Added (v2.9.0 — E2EE rooms, phase 3b)
- **`room create --e2ee`** — member↔member messages are sealed end-to-end (chacha20-poly1305): the origin bridge encrypts, the destination bridge decrypts, and a relaying hub passes opaque `enc` blobs — verified: a spoke↔spoke exchange leaves NOTHING readable in the hub's store. **Zero new dependencies** (node:crypto AEAD + scrypt; the researched libsodium/Argon2id route proved unnecessary).
- **Key distribution without servers seeing it**: invite links carry the room key in the URL fragment (`#invite:<code>:<key>` — fragments never reach servers); password joiners receive the key wrapped under a scrypt-derived key (separate salt from the join gate — the hub stores the wrapped blob it cannot open). Keys live in `~/.claude/.cc-bridge-room-key` (0600), installed automatically by `join`, removed on `unlink`/uninstall.
- Wrong-key members degrade safely: messages surface as `[encrypted]`, plaintext never appears. Non-E2EE rooms are byte-for-byte unaffected.
- Documented limitation: kick revokes access, not knowledge — a kicked member still holds the key (transport 401s keep them out); recreate the room to rotate.

### Added (v2.9.0 — privacy)
- **`room create --host-only`** — host a room for a community WITHOUT participating: the hub relays everything, but its own sessions are never advertised, can't be reached from the room (even by forged forwards), and can't message it. Local sessions keep full normal bridge life with each other.
- **Per-session exposure + the AIRLOCK** — when linked to a room, each local session is 🌐 EXPOSED or 🔒 hidden. Hidden sessions: invisible in the roster, unreachable (enforced at delivery, not just by roster filtering), and mute toward the room. **Airlock (always on): exposed and hidden sessions cannot exchange ANYTHING through the bridge (ask/notify/threads/scratchpads, both directions)** — the room→gateway→private-sessions social-engineering path is mechanically impossible. Zones are fully functional within themselves.
- New CLI: `claude-bridge sessions` (zone overview with 🌐/🔒), `expose <name>` / `hide <name>` (instant toggle, roster updates ripple to the room), `join '<link>' --expose none` (privacy-first join: everything hidden until exposed). `register()` gains an optional `expose` boolean.
- Honest caveat, documented: exposure is not retroactive amnesia — a session exposed after working privately carries what it learned. Expose fresh sessions.

### Changed (v2.9.0)
- **Back-compat: legacy shared-token federation works UNTIL the first `room create`** — bit-identical behavior before that; afterwards the fed surface accepts only member tokens (old links get a clear 401 + re-invite hint). `room delete` returns to legacy mode.

### Added (v2.8.0 — multi-tunnel providers)
- **Multi-tunnel provider dispatch for `share`**: p2p (dumbpipe, NEW DEFAULT), cloudflared named (`--stable <host>`), bore, pinggy, zrok, and tailscale-direct (`--tailscale`, via `serve --tcp` — L4 passthrough, because Tailscale's HTTP serve/funnel modes buffer SSE). Per-machine default via `CC_BRIDGE_PROVIDER`.
- **`join` accepts `p2p:<ticket>#<token>` links** — spawns a local dumbpipe forwarder (E2E-encrypted QUIC to the hub); managed by `unlink` (killed only AFTER the hub is notified), `doctor` (liveness + re-join hint), and uninstall.
- **Verified teardown**: `stop-share` confirms the tunnel process actually died (SIGTERM → wait → SIGKILL) and tears down persistent `tailscale serve` config (which survives reboots otherwise).
- **EXPOSED status line** in `share`/`status`/`health`/`doctor` showing provider + URL/ticket + liveness (tailscale checked via `serve status`, not process checks).
- Generic GitHub-release binary auto-installer (bore, dumbpipe, zrok); honors `CC_BRIDGE_NO_AUTOINSTALL=1`.
- **`share --reuse`** — persistent p2p identity: a 32-byte key (`~/.claude/.cc-bridge-p2p-key`, 0600, removed by uninstall) is handed to dumbpipe via `IROH_SECRET`, and the join ticket is derived canonically from it (`generate-ticket`) — so the ticket is IDENTICAL across restarts/reboots and spokes never re-join. Default `share` stays ephemeral (restart = new ticket = old links revoked). Live-verified: same ticket across restarts, canonical ticket dials a running listener.
- **`update [branch]`** — `claude-bridge update <branch>` fetches, switches to, and tracks that branch (beta-testing a feature branch in one command); bare `update` now always returns to the repo's default branch (main). Unknown branches fail with the remote branch list. Test: `tests/test-update-branch.sh`.

### Fixed (v2.8.0 — found by live Mac↔GCP-VM testing)
- **`npm test` can no longer kill a live production share (second incident of this class).** `test-cli.sh`'s uninstall round-trip isolated the port but not the tunnel state paths — uninstall read the REAL `/tmp/claude-bridge-tunnel.pid`, killed the live dumbpipe, and its unconditional `/tmp/claude-bridge-*` glob wiped the share's state files (+ live sessions' name files). Uninstall now skips the global /tmp wipe when the tunnel paths are env-overridden (i.e., a test), and every test uninstall sets the overrides. Sentinel regression test added.
- Release-asset patterns broadened to real-world names (`darwin-aarch64`/`linux-x86_64` for dumbpipe); installer falls back to a prefix match when the binary is versioned inside the tarball (zrok v2 ships `zrok2`).
- pinggy extractor matches the real free-tier tunnel domains (`*.free.pinggy.net`, `*.run.pinggy-free.link`) and no longer grabs the `dashboard.pinggy.io` banner link.
- A failed URL/ticket extraction now kills the just-launched detached process instead of leaking it (hit live with pinggy).
- **`stop`/`restart`/`update`/uninstall now find the server on hosts without `lsof`.** `stop_bridge` and the uninstall stop path used raw `lsof` (no `ss` fallback), so on an lsof-less host with no pid file, `restart` printed the contradictory "Bridge is not running" + "Bridge already running" and silently left the OLD server serving — `update` could never actually replace the running code (field report from a GCP VM pinned on v2.7.0 since Jun 02). Both now use `port_listener_pid` (lsof→ss), and `doctor`'s Ports section degrades gracefully instead of leaking exit-127.
- **Headless `update` no longer crashes.** `update` skips `check_prereqs`, so `HAS_CLAUDE` was unset and defaulted to 1 — on a box without the Claude CLI (a headless hub/VM) the reinstall step died on `claude mcp`. `run_install_steps` now derives `HAS_CLAUDE` itself.

### Changed (v2.8.0)
- **Default share transport is now p2p (dumbpipe)** — no account, no public URL, end-to-end encrypted, SSE-safe, any number of spokes through one ticket.
- **Cloudflared QUICK tunnels REMOVED.** They buffer SSE, so spokes register but never receive forwarded messages (cloudflared#1449 + official docs "Quick Tunnels do not support SSE") — a transport that cannot deliver is not worth keeping; `--provider cloudflared-quick` now fails with the explanation and the working alternatives. Named tunnels are unaffected (run ONE connector per hostname).

### Changed
- **`uninstall` is now a full teardown — it STOPS the running bridge** (and closes the federation tunnel), reversing the old "leave the server running" behavior. The stop is the last step (after all file/config removal) and targets the listener by port, so a self-disconnect can only land once cleanup is done; graceful SIGTERM then SIGKILL-after-grace. A loud warning prints up front (run it from a separate terminal). Test in `tests/test-cli.sh`; DEVELOPER.md lesson #15 updated.
- **Bare `claude-bridge` (no command) now prints help instead of installing.** Running it with no args used to re-run the full installer — surprising once it's a real CLI. `install` is an explicit verb; bare invocation shows usage (like `git`).
- **`claude-bridge install` now works on a headless hub/server node without the Claude Code CLI.** `claude` was a hard prereq (the installer aborted), but a box that only runs the bridge process doesn't need it — hooks/MCP/skill/Desktop are workstation-only. Missing `claude` is now a warning: the install skips those steps but still puts `claude-bridge` on PATH so the server can be driven with `start`/`stop`/`share`/`doctor`. Regression test in `tests/test-cli.sh`.

### Changed
- **Bridge questions/replies are now token-lean.** The `/pending` injection dropped the 5-point "include direct answer • WHY • user prefs • alternatives rejected • gotchas" checklist (which made agents write essays) for a one-line *"reply: precise answer + any gotchas/traps, no preamble"*, re-injects only the **last** exchange as context (truncated ~120 chars) instead of the last 3 full Q&As, and uses lighter banners. `skill/SKILL.md` reply/ask/notify guidance rewritten to match (terse, batch questions, don't re-explain context the thread already has). Big savings on every bridge message and especially on continued threads. (`Question from`/`NOTICE from`/`id:` kept verbatim so the idle-listener grep still works.)
- **Idle-listener monitor polls by stable `claude_session_id`, not the display name.** `/pending` now accepts `?claude_session_id=<id>` (resolves to the session's current name; unknown id → empty, not 400). The hook-emitted Monitor command uses it, so the poller follows a session across renames/resumes and you don't get a new per-name monitor each time — plus the nudge says to keep exactly one (TaskStop a duplicate first). Fixes monitors piling up.

### Fixed
- **`start` no longer reports false success when a stale/foreign listener holds the port.** The verifier polled the ungated `/health/ping` and declared "✓ Bridge started" if *anything* answered — so a stale bridge holding `:7400` masked the new server's immediate EADDRINUSE exit, then `health` (gated) said "not running" (a maddening loop hit live on the VM). It now also confirms the spawned child is still alive (`kill -0 $child`); if `/health/ping` answers but the child died, it reports the stale/foreign holder + how to clear it (`restart --force` / `pkill -f bridge-server.mjs`). Pre-flight listener detection also falls back to `ss` when `lsof` can't attribute the socket (unprivileged hosts — the VM's lsof returned nothing while a process held the port).
- **`health` now shows real tunnel state**, not just a recorded URL: tunnel URL, whether the cloudflared **process is up** (PID alive), and **end-to-end reachability** (`<url>/health/ping` → 200). A dead/flapping tunnel now reads as DOWN/NOT reachable instead of looking healthy.
- **`share` (quick tunnel) now prints a red NOT-RECOMMENDED warning.** A `*.trycloudflare.com` quick tunnel flaps/rotates and silently drops long-lived return streams (a Cloudflare-side limitation, not a bridge bug); the banner steers users to `--named-tunnel <host>`.
- **`npm test` no longer kills a live production tunnel.** The tunnel state files (`/tmp/claude-bridge-tunnel.{pid,url}` + log) were hardcoded, and `test-share-flags.sh` runs fake-cloudflared `share`/`stop-share` — so running the suite while a real hub was sharing **clobbered and killed the live tunnel** (diagnosed from a real incident: a stale `fake-tunnel-9.trycloudflare.com` URL in the production tunnel log + chronic tunnel death). The paths are now env-overridable (`CC_BRIDGE_TUNNEL_PID`/`_URL`/`_LOG`, defaulting to the same `/tmp` paths in production), and `test-share-flags.sh` points them at its temp dir + asserts the real `/tmp` tunnel state is never touched while its fake tunnel is open.
- **Spoke→hub-session messaging no longer breaks after a re-link ("not connected").** The hub's `/link/register` response is `globalRoster()`, which tags the hub's *own* sessions `node:"local"` (correct only on the hub). The spoke stored them verbatim, so on the spoke the hub's sessions looked local — and `resolveTarget` (local-first; bare-name lookup filters `node !== "local"`) treated them as local-and-absent and returned "not connected" instead of forwarding to the hub. `spokeAdvertise` now rewrites the hub's `"local"` tags to the hub's real node id (from the register response's `r.node`). The stream-broadcast path was already node-keyed and correct, which is why this only surfaced when no broadcast followed the register (e.g. a flapping link). Found live on a Mac↔Mac federation; confirmed by two independent agent diagnoses. Node-attribution invariant guarded in `tests/test-federation-hub-switch.mjs`.
- **`share` launches the cloudflared tunnel fully detached so it survives the launching shell.** Both the quick-tunnel and named-tunnel paths now go through `launch_cloudflared` (Linux: `setsid` → own session; macOS: `nohup … </dev/null &` + `disown`), so the tunnel doesn't die when `share` is started from a terminal that's later closed or from a non-interactive/automated shell that reaps its children.
- **AI agents handed the repo now install instead of running the test suite.** The root `CLAUDE.md` opened with "load the developer guide `@DEVELOPER.md`", which auto-injected the maintainer guide (release checklist, "run the test suite", testing methodology) into *every* session — so an agent asked only to install would start running tests. `CLAUDE.md` now splits by intent: **Case 1 (install/use)** → `./claude-bridge install` with an explicit "do NOT run `npm test`/`tests/`", verify with `doctor`; **Case 2 (develop)** → read `DEVELOPER.md`. Removed the unconditional `@DEVELOPER.md` auto-load. README gained an "AI agent setting this up?" note, and its one-line installer was fixed to point at the `install.sh` bootstrap (it had been changed to pipe the bare CLI, which now just prints help and can't bootstrap).
- **`uninstall` removes the `claude-bridge` PATH symlink without hanging.** It already deleted the symlink from `/usr/local/bin` + `~/.local/bin` (manifest + hardcoded fallback); the sudo fallback for `/usr/local/bin` is now TTY-aware (`sudo -n` when non-interactive) so a scripted/piped uninstall can't block on a password prompt, and it prints a clear `sudo rm` hint if it couldn't remove it.
- **CLI invoked through its PATH symlink now resolves the real checkout.** `REPO_DIR` walked `dirname "$0"` without following symlinks, so `~/.local/bin/claude-bridge` pointed `REPO_DIR` at `~/.local/bin` — `version` showed `unknown` and `start` couldn't find `bridge-server.mjs`. Now resolves the symlink chain portably (macOS has no `readlink -f`). Regression test in `tests/test-cli.sh`.
- **`symlink_cli` no longer hangs on a sudo password prompt when non-interactive** (`curl | bash`, CI, agents): uses `sudo -n` with no TTY and falls back to `~/.local/bin`; an interactive user still gets a normal prompt.

### Added
- **`claude-bridge debug` + a shipped read-only debugger skill.** A second skill, `claude-bridge-debug` (installed to `~/.claude/skills/claude-bridge-debug/`, auto-triggers on "debug bridge" / "bridge is broken"), turns a fresh Claude session into an **expert, strictly read-only** bridge debugger: it reads the *installed* code + the server/CLI logs, explains the architecture and data flow, reconstructs the execution history, root-causes the issue (cross-referencing the DEVELOPER.md lesson catalog), prepares a GitHub issue (`gh issue create` when repo access exists, else a maintainer email to vvijay1000@gmail.com — **always shown first, never auto-sent**, token redacted), and hands the user a clean **no-code temporary fix**. **Read-only by default** (changes nothing, preserves evidence); it goes hands-on — applies fixes, restarts, acts as a full dev — **only after the user explicitly grants permission**, which it records (scoped grants honored exactly; silence = read-only; never restart a bridge from a session bound to it). The `claude-bridge debug` command just explains how to invoke it (a new session + "debug bridge"). Installed/removed by `install`/`uninstall` (manifest-tracked); tests in `tests/test-cli.sh`.
- **`docs/CROSS-NETWORK.md` — step-by-step getting-started guide for linking machines.** Prerequisites table (hub vs spoke), the hub/spoke model, exact `share`/`join` steps, how to verify, `name@node` addressing, stop/disconnect/reconnect table, troubleshooting, and a quick-reference card. Linked from README and USAGE.
- **`claude-bridge health` — live server health in one view.** Reads the federation token automatically (so the token-gated `/health` works) and renders: server up/PID/port, role/node/token-configured, federation topology (spoke → hub URL + reachability; hub → connected spoke nodes + tunnel URL), the **registered-client roster** (grouped by node, with descriptions), and message counters (pending/answered/notices). Falls back to the ungated ping when the full view isn't reachable. Distinct from `status` (install/version wiring) and `doctor` (deep diagnostics). Test in `tests/test-cli.sh`.
- **`claude-bridge` CLI.** `claude-bridge` is now a proper subcommand CLI, symlinked onto PATH as `claude-bridge` (auto: `/usr/local/bin` via sudo, else `~/.local/bin`). Commands: `install`/`reinstall`, `update` (git pull → reinstall → restart — the "pull ≠ restart" fix as one command), `uninstall` (skill + MCP + hooks + configs + dotfiles + the PATH symlink), `doctor` (deep health: prereqs, running bridge, **version/role drift**, tunnel reachability, port conflicts, recent errors), `status`, `version`, `logs [-f]`, `start`/`stop [--force]`/`restart [--force]`, `share`/`join`/`unlink`/`stop-share`, `help` (grouped). Every invocation is logged to `~/.claude/claude-bridge.log` (0600, rotated). All original `--flags` stay as back-compat aliases. Zero new dependencies (stays bash). New `tests/test-cli.sh`; design in `docs/specs/claude-bridge-cli.md`.
- **Cross-network federation (Phase 1) — talk to agents on other machines.** Hub-and-spoke bridge linking over a Cloudflare tunnel. One person runs `./claude-bridge --share` (becomes a hub, opens a tunnel, prints a join link); others run `./claude-bridge --join '<link>'` (become spokes). Sessions stay on localhost; only the bridge-to-bridge link rides the tunnel. `ask`/`reply`/`notify` now resolve targets across the link: a remote message is injected into the destination bridge's local `messages` store as a shape-identical object, so every existing delivery path (`/pending`, Stop hook, idle-listener peek, `check_inbox`, blocking `ask`, `notify`, `get_thread`, GC, migration) works unchanged. `list_sessions` returns a merged roster tagged by node; target a specific remote session as `name@node` (bare names resolve local-first). Lossless reconnect: queued messages live in the durable store (30d TTL) and re-forward idempotently when the link comes back. Scratchpads (`broadcast`/`read_scratchpad`) stay local-only in Phase 1.
- **Token-auth layer.** A shared secret (`~/.claude/.cc-bridge-token`, sent as the `X-Bridge-Token` header) gates `/health` and all `/link/*` when sharing is on. Loopback is NOT trusted (a tunnel makes remote requests look local). Guardrail: the bridge refuses to serve `/link/*` without a token (503 "federation disabled").
- **`/health/ping` — ungated liveness probe** (status/role/node/sharing, NO session names). `claude-bridge --check` and the test harness use it so they keep working when the full `/health` is token-gated.
- **`POST /link/reload` — no-restart config hot-load.** `--share`/`--join`/`--unlink`/`--stop-share` flip a *running* bridge's role via this localhost-only endpoint instead of restarting it (a restart drops every SSE client and can kill the calling session — lesson #23a).
- **`claude-bridge` federation flags:** `--share [--named-tunnel <host>] [--node <id>]`, `--join '<link>'`, `--unlink`, `--stop-share`. Both Cloudflare quick-tunnel (default, ephemeral URL, zero setup) and named-tunnel (stable hostname) modes. `cloudflared` is detect-and-instruct (bridge stays zero-dependency). `--check` now shows hub/spoke/standalone status + tunnel URL.
- **Link/SSE liveness tweak.** TCP keepalive on the local `/sse` and the link `/link/stream`, plus prune-on-write-error, so a dead client/spoke leaves the roster within tens of seconds (tightens lesson #9 ghost de-merge locally too).
- **Tests:** `tests/test-token-auth.mjs` (gate accept/reject, ungated ping, no-token guardrail), `tests/test-federation.mjs` (two-bridge link: roster merge, cross-link ask/reply, notify relay + consume-once, invariants, gated health, link-drop pruning), `tests/test-federation-reconnect.mjs` (lossless queued-message flush), `tests/test-share-flags.sh` (claude-bridge flag parsing with a fake cloudflared). `tests/lib.mjs` gained per-bridge fed-config isolation + link helpers.
- **Spoke heartbeat — keeps the lossless-reconnect window honest.** The spoke now POSTs `/link/heartbeat` to the hub every 25s, so the hub's `lastSeen` for that spoke stays fresh even with no message traffic. Without it (found by the real Mac↔VM tunnel chaos run), an **idle** spoke was already "stale" when it disconnected, so the hub's 45s stale-sweep deleted its relay queue within one 15s tick — silently dropping messages queued during the outage. Now the 45s window counts from real disconnect. Doubles as the sub-100s SSE keepalive the link path needs through Cloudflare. Heartbeat/stale/sweep intervals are env-overridable (`CC_BRIDGE_HEARTBEAT_MS`/`CC_BRIDGE_SPOKE_STALE_MS`/`CC_BRIDGE_SPOKE_SWEEP_MS`, test-only; production defaults 25s/45s/15s). Regression test: `tests/test-federation-heartbeat.mjs`.
- **Hub-switch / dead-old-hub teardown test** — `tests/test-federation-hub-switch.mjs` (6 assertions) pins that every federation reload tears down the PREVIOUS hub link locally and synchronously (`applyFedConfig` → `teardownHubStream`): switching a spoke hubA→hubB drops hubA's roster (no stale ghosts) and brings hubB's in, and **unlinking while the linked hub is DOWN** still clears the roster to local-only and drops to standalone — the teardown never depends on the old hub being reachable. (Closes the "previous hub might be down when you run a connect/unlink command" concern.)
- **Federation chaos/resilience suite** — `tests/test-federation-chaos.mjs` (hub + two spokes): 3-way roster merge, spoke→hub→spoke cross-routing, hard spoke crash (SIGKILL) + prompt roster prune, lossless reconnect flush of a queued notice, hub crash+restart with spoke auto-reconnect, `name@node` collision (local-name-wins), and auth-stays-enforced-under-chaos — 30 assertions, all green. It also pins two known limitations so a future fix is noticed: an in-flight question is lost if the answering spoke crashes after receiving it (asker times out at 5 min), and a *qualified* `notify name@node` to a momentarily-offline spoke is dropped (the bare-name form is lossless).
- **Design spec for cross-network federation** — `docs/specs/cross-network-federation.md` (the why) + `docs/specs/cross-network-federation-implementation-plan.md` (the how).
- **Operations runbook + bug log** — `docs/OPERATIONS.md` (command cheat-sheet: deploy hub, join spoke, named-tunnel recipe, verify/troubleshoot) and `docs/KNOWN-BUGS.md` (running log of the claude-bridge/lifecycle issues surfaced while operating the branch: `--start` silent-abort, foreign-port-holder, token-change can't hot-reload, `--share --named-tunnel` ignored when a tunnel is already open — each with repro, workaround, and intended fix).

### Security
- **DoS + info-leak hardening (Tier 2).** A second-pass security review fed these in:
  - **Request-body cap** — any POST body over `CC_BRIDGE_MAX_BODY` (default 1MB) is rejected `413` (closes the connection cleanly so a poisoned keep-alive socket isn't pooled).
  - **Rate limiting** — the message-*creating* tools (`ask`/`notify`/`broadcast`) and `/link/forward` are token-bucketed per source (`CC_BRIDGE_RATE_MAX` default 60 per `CC_BRIDGE_RATE_WINDOW_MS` default 10s). Reads and `register`/`reply` are never limited.
  - **Federated-node caps** — a hub tracks at most `CC_BRIDGE_MAX_NODES` (default 64) distinct nodes (a new node past the cap → `429`; a known node can always re-advertise) and accepts at most `CC_BRIDGE_MAX_SESSIONS` (default 256) advertised sessions per node (over-long lists truncated).
  - **Full-length message ids** — message ids are now full UUIDs (was 8 hex), removing the id pre-claim / birthday-collision vector.
  - **`injectRemote` allowlists `kind`** and requires string `id`/`from`/`to` before storing, so a malformed/hostile forward can't create a junk message.
  - **Descriptions are no longer shared across the federation link by default** (they can carry project/file context, and a hub broadcasts the roster to every node). Local `list_sessions` still shows local descriptions; opt back in with `CC_BRIDGE_SHARE_DESCRIPTIONS=1`.
  - **Server log is created `0600` and rotated at ~10MB** on start (`claude-bridge`); message **content** is no longer written to the log (ids + lengths only) — only names/metadata remain.
- **Federation hardening — separate loopback fed port; the main bridge is no longer tunneled.** A security review found `--share` tunneled the WHOLE bridge port, exposing the intentionally token-free local routes (`/sse`, `/message`, `/pending`, `/whoami`) to anyone with the URL — they could register, ask/notify, and read any session's pending messages with no token. Fixes:
  - The bridge now runs **two listeners**. The **main server binds `127.0.0.1:PORT`** (loopback only) and serves all local routes — it is never tunneled and is now unreachable from the LAN. In **hub mode** a **second server binds `127.0.0.1:FED_PORT`** (default `PORT+1`, override `CC_BRIDGE_FED_PORT`) serving ONLY the token-gated `/link/*` surface plus the content-free `/health/ping`; every other path 404s.
  - **`--share` tunnels the fed port, not the main port** (both quick-tunnel and named-tunnel). The join link is unchanged; the tunnel hostname now maps to the fed port.
  - **`/link/reload` is now token-gated (when a token is set) AND restricted to a loopback peer** (defense-in-depth); it stays on the main loopback-only server.
  - A spoke makes only outbound connections and never binds the fed port. Standalone is byte-for-byte unchanged (the fed listener exists only in hub mode).

### Changed
- **Renamed the script `install.sh` → `claude-bridge`** (no extension — the file *is* the command; `install` is now just a verb: `claude-bridge install`). Hard rename, no shim — all docs/tests/`package.json` updated to the new name; old `--flags` still work as aliases. The public `curl … | bash` web bootstrap stays `site/install.sh` (that URL is a convention) and now runs the in-repo `claude-bridge install`.
- **`--share` now auto-installs (or updates) cloudflared for the OS** instead of only printing instructions. macOS uses Homebrew (`brew install`/`brew upgrade`); Linux downloads the matching static binary from Cloudflare's releases to `/usr/local/bin` (via `sudo` if needed, else `~/.local/bin`); if cloudflared is already present it's best-effort updated (`brew upgrade`, else `cloudflared update`). The bridge **server** stays zero-dependency — this runs only on the hub path where a tunnel is actually opened. Opt out with `CC_BRIDGE_NO_AUTOINSTALL=1` (reverts to detect-and-instruct).
- **Idle-listener arming is now ENFORCED at turn-end, not just nudged.** Askers reliably skipped the advisory PostToolUse arm-nudge because it arrives bundled with the answer they were waiting on (the accepted trade-off in lesson #18 — now closed). The PostToolUse hook marks a session `.engaged` on `ask`/`reply`; the Stop hook then blocks the turn **once per engagement** (loop-safe via an `.armblocked` marker, re-armed on the next ask/reply) with the arm instruction if the `.monitor` stamp isn't `on`/`off`. At Stop the answer is already delivered, so the instruction lands cleanly and `decision: block` makes the agent act. Respects user-disable (`off`) and already-armed (`on`). New marker files cleaned by SessionEnd; covered by `tests/test-monitor-trigger.sh` (cases 13–18).
- **Federation security model stated explicitly: one shared token per hub = a trusted group.** Per-node identity (per-node tokens / TOFU) was considered and declined to keep joining a one-paste operation. Node ids and session names are self-asserted within the group; rotate the token (`--stop-share` → `--share`) to revoke. External/unauthenticated callers remain fully blocked by construction (two-listener split + token gate). Documented in USAGE "Security, honestly", plus a new "Keeping an always-on hub up" note on supervising `cloudflared` (it can exit / silently drop its edge connection — run it under launchd/systemd and poll its metrics `/ready`, don't trust `pgrep`).
- **SSE robustness + direct-bind option** (from a live Mac↔VM test). The live test showed a Cloudflare **quick** tunnel buffers the hub→spoke `/link/stream` SSE — so the link establishes and a spoke advertises to the hub, but messages/roster pushed *to* a spoke never arrive (the spoke→hub HTTP path works; the hub→spoke SSE is swallowed). Two changes: (1) the bridge now sets `X-Accel-Buffering: no` on its SSE responses so streaming-aware proxies don't buffer; (2) a new `CC_BRIDGE_FED_BIND` env (default `127.0.0.1`) lets the fed listener bind `0.0.0.0` to be reached **directly** on a host's network (e.g. a cloud VM with a public IP, no tunnel) — still token-gated, but cleartext over plain HTTP unless TLS-fronted (Caddy / named tunnel). Net guidance: **quick tunnels are link-only; use a named tunnel, a direct fed-bind behind TLS, or self-host for real federation.**
- `claude-bridge start_bridge` now polls the ungated `/health/ping` for liveness (the full `/health` is token-gated when sharing is on).
- `claude-bridge --check` now shows the loopback fed port and that the tunnel points at it (not the main port).
- New install artifacts registered in the manifest and removed by `--uninstall`: `.cc-bridge-token`, `.cc-bridge-role`, `.cc-bridge-hub`, `.cc-bridge-node`. Uninstall also kills the tunnel child (but not the bridge — lesson #15).

### Fixed
- **The four claude-bridge lifecycle bugs (BUG-1–4).** `start`/`stop`/`restart` now act on the actual `:7400` **listener** (`lsof -ti:PORT -sTCP:LISTEN`, never the bare `lsof -ti:PORT` which also returns connected-client/Claude-session PIDs), so they correctly manage a bridge that wasn't started by the installer. `start` reports a clear error on a foreign-held port (or `--force` replaces it) instead of silently aborting (the `cat $PID_FILE`-under-`set -e` trap is guarded). `restart --force` SIGKILLs the listener and replaces it. `join` **restarts** the bridge when the token changes (the old token rejects `/link/reload` → BUG-3). `share --named-tunnel` closes a *mismatched* running tunnel before starting the requested one instead of silently reusing it (BUG-4).
- **Ghost remote sessions → 5-minute blocking-`ask` hang on a hub outage (G7).** When the hub link dropped, a spoke kept its last remote roster, so `resolveTarget` still treated a now-unreachable remote name as routable and a blocking `ask` to it waited the full 5-minute deadline ("calling bridge…") instead of failing fast. Fix: the spoke clears `remoteRoster` the instant the hub link drops (`scheduleSpokeReconnect` + `teardownHubStream`), so `list_sessions` shows only real local sessions during an outage and an `ask`/`notify` to a former-remote returns immediately with "not connected"; the roster repopulates on reconnect. Regression in `test-federation-chaos.mjs`.
- **Hooks silently stopped working once the local bridge had a token (sharing on).** `bridge-start-hook.sh` / `bridge-prompt-hook.sh` / `bridge-hook.sh` probed liveness with `curl -sf .../health`, but `/health` is token-gated when sharing is on (hub or spoke) → `401` → the hooks concluded "bridge down" and exited silently. Result: new sessions **stopped auto-registering** and **stopped getting the idle-listener (Monitor) nudge**. Fixed: hooks now use the ungated `/health/ping` for liveness and the ungated `/whoami?session_id=` for registration state (never the gated `/health`, and never carrying the token). Regression test `tests/test-hook-token-liveness.sh`. (lesson #26)
- **Federation message-durability gaps (found by the real-tunnel chaos run).** (1) A *qualified* `notify name@node` to a momentarily-offline-but-known spoke was dropped (resolved to "none") while the bare-name form queued losslessly — `resolveTarget`'s `@node` branch now uses the same offline-spoke fallback, so both forms are lossless (G3). (2) A question the answering spoke received and then lost to a crash was never re-delivered (it had been delivered, so was never in the relay queue) and the asker timed out — `flushPendingForwards` now also re-pushes any still-open question/notice addressed to a session on the reconnecting node, so the question reappears and the asker is answered (G4). (3) `name@node` addressing is now case-insensitive — the node part is sanitized/lowercased before matching, matching how node ids are stored (G6). Chaos-suite assertions flipped from "known gap" to assert the fixed behavior.
- **`reply()` and `register()` now validate their args** (the `broadcast({content:undefined})` crash-class, left unfinished). `reply()` rejected a non-string `answer` only *after* assigning it to `msg.answer` — which set the answer to a non-null junk value, un-pending the question (it's no longer `=== null`) and shipping garbage to the asker while the length-log threw. It now rejects a non-string `answer` before mutating. `register()` now rejects a non-string/blank `name` (it would otherwise pollute `nameToSSE`/the roster/the `.name` file) and coerces a non-string `description` to `""`. Covered in `test-tools.mjs` + the chaos suite.
- **Test harness couldn't restart a bridge on the same `TestBridge` instance** (surfaced by the chaos suite). `TestBridge.start()` never reset `this.sid`, so a second `start()` (modelling a crash+restart) found a stale session id and the SSE handshake guard `!this.sid` never captured the new `session=` line → a 5-min-style hang reported as "SSE handshake timeout". Also: the child's stdout was a piped-but-unread stream, so once the server logged ~64KB the synchronous `console.log` blocked its event loop. Fixes in `tests/lib.mjs`: reset `sid`/responses at the top of `start()`, and spawn stdout as `"ignore"` (discarded by the OS, matching production's redirect to the log file).
- **Idle-listener didn't survive a session resume/restart** (v2.6.2). A background `Monitor`
  dies with the old session process, but its `.monitor` stamp (a `/tmp` file) survived — and
  since a resume doesn't reliably fire `SessionEnd` (which would clear it), a resumed session
  showed `on` with no live listener, and the hook never re-armed it. Fix: a new `rearm` stamp
  state. `bridge-start-hook.sh` flips `on` → `rearm` on every (re)start; `bridge-hook.sh`
  re-nudges on the **next tool call** (any tool, not just ask/reply) when it sees `rearm`, with
  the name freshly resolved — so the listener comes back right after a resume. `off`
  (user-disabled) and absent (never armed) are left untouched. 4 new test assertions.
- **Bridge restart could kill the calling session, and a process-leak left 17-day-old orphans** (v2.6.1 — incident fixes):
  - `./claude-bridge --stop` / `--restart` now print a loud warning that they disconnect **every** Claude session whose MCP client is on the bridge — including the one running the command (when its tool transport drops, the harness kills it; graceful shutdown makes the disconnect tidy but can't prevent it). Run lifecycle commands from a **separate terminal**, never from a session bound to the bridge. A plain `--start` is safe.
  - `bridge-server.mjs` now has a `server.on("error")` handler that `process.exit(1)`s on `EADDRINUSE` instead of letting the catch-all `uncaughtException` swallow it — the old behaviour left a headless process that never bound a port and never exited (kept alive by the keepalive/gc intervals).
  - `start_bridge` now verifies the server actually serves `/health` (and reaps the spawned child on failure) instead of trusting the PID file, which is only written after a successful bind — so a bind failure no longer silently leaks an orphan.
  - Regression test added to `tests/test-process-mgmt.sh` (a second server on a busy port must exit, not orphan); DEVELOPER.md lesson #23.

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
- `claude-bridge --check` no longer shows a yellow `!` for the Desktop app when it's
  simply not configured — the Desktop app is optional, so a missing config is
  green-checkmark "ok" status, not a warning.

### Changed
- **Project name rename: `cc-bridge` → `claude-bridge`** in all user-visible places (README title, server banners, MCP `serverInfo.name`, hook output messages, Desktop config key `mcpServers["claude-bridge"]`, skill directory `~/.claude/skills/claude-bridge/`, skill `name:` frontmatter, JSON-LD `name`). `claude-bridge` auto-migrates: removes the legacy `~/.claude/skills/cc-bridge/` dir and the legacy `mcpServers["cc-bridge"]` Desktop key on re-install. Internal runtime paths (`/tmp/cc-bridge-*`, `CC_BRIDGE_*` env vars, `~/.claude/.cc-bridge-version`, `~/.claude/.cc-bridge-manifest`) are intentionally unchanged — they're implementation details and renaming them would break in-flight installs without benefit.
- Bumped to v2.4.0.

### Added
- **One-line installer** — `curl -fsSL https://vijay2411.github.io/claude-bridge/claude-bridge | bash`. Bootstrap script hosted on the Pages site clones the repo to `~/.local/share/claude-bridge` and runs the in-repo `claude-bridge`. Lives at `site/claude-bridge`.
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
- **Version tracking** — `claude-bridge` writes `~/.claude/.cc-bridge-version`
  on install and reports installed vs repo version on `--check`.
- **Install manifest** — `~/.claude/.cc-bridge-manifest` records every path
  the installer touched; the uninstaller reads it back so future versions
  can clean up files an older `claude-bridge` wouldn't know about. Hardcoded
  cleanup still runs as a belt-and-suspenders fallback.
- **`DEVELOPER.md`** — primary maintainer notes: owner's vision, 15
  hard-learned lessons, release checklist, what NOT to do.
- **`tests/` folder** — runnable test suite (`./tests/run-all.sh` or
  `npm test`). Covers tool behaviour, broadcast input validation,
  graceful shutdown SSE close event, hook MCP-check silencing, claude-bridge
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
- **Process management** — `./claude-bridge --start | --stop | --restart` and
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
  claude-bridge touches.
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
- Automated `claude-bridge` (CLI + Desktop), `--check`, `--uninstall`.
- README, USAGE.md, BRIDGE.md.

[Unreleased]: https://github.com/vijay2411/claude-bridge/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/vijay2411/claude-bridge/releases/tag/v2.2.0
[2.1.0]: https://github.com/vijay2411/claude-bridge/releases/tag/v2.1.0
[2.0.0]: https://github.com/vijay2411/claude-bridge/releases/tag/v2.0.0
