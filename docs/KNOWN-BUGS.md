# Known bugs — running log

Open issues found while operating/testing the federation branch. Each has a
symptom, root cause, workaround, and the intended fix. Update this as we go;
move items to "Fixed" (with the commit) when landed.

> Security note: never paste the actual bridge token into examples here. Use
> `<TOKEN>` or `$(cat ~/.claude/.cc-bridge-token)`.

---

## Open — install.sh / lifecycle

### BUG-1 — `--start` silently does nothing when a *foreign* server holds the port
- **Symptom:** `./install.sh --start` prints nothing and the new bridge isn't running; an unrelated/older bridge is still on `:7400`.
- **Root cause:** the old bridge has **no install-written PID file**, so `--start` skips its "already running" check, tries to start a new bridge → `EADDRINUSE` → the new process `exit(1)`s (lesson #23b). `start_bridge` then health-polls `:7400`, the *old* bridge answers `200`, so it "thinks" it's up and runs the success line `ok "Bridge started (PID $(cat $PID_FILE))"` — but `$PID_FILE` doesn't exist, so `cat` fails under `set -euo pipefail` → the script **aborts with no output**.
- **Workaround:** `lsof -ti:7400 -sTCP:LISTEN | xargs kill` (LISTENER only — *not* `lsof -ti:7400`, which also returns connected client PIDs and would kill your Claude sessions), then `./install.sh --start`.
- **Fix:** (a) guard the success `cat $PID_FILE` (`|| echo "?"`); (b) before starting, detect "port busy but not our PID" and print a clear message instead of dying.

### BUG-2 — lifecycle commands can't manage a bridge that lacks the install PID file
- **Symptom:** `--stop` / `--restart` are no-ops against a bridge started any other way (e.g. launched directly, or an old version), because they only act on `/tmp/claude-bridge.pid`.
- **Root cause:** `stop_bridge`/`start_bridge` key entirely off the PID file.
- **Workaround:** kill the listener by port (see BUG-1), then `--start`.
- **Fix:** `--restart` (and a `--force`) should target the actual `:7400` **listener** (`lsof -ti:PORT -sTCP:LISTEN`), not just the PID file, so it reliably replaces a foreign/stale bridge. This is the "install should kill the old servers" ask.

### BUG-3 — token-changing `--join`/`--share` can't hot-reload a running bridge (chicken-and-egg)
- **Symptom:** after `--join`/`--share` that changes the token, the dotfiles say one thing (e.g. `role=spoke`, new token) but the **running process** keeps its old role + old token. The hub then rejects the *correct* (new) token with `401`; a spoke never actually links.
- **Root cause:** `--share`/`--join` write the dotfiles then `POST /link/reload` to hot-reload the running bridge. But `/link/reload` is **token-gated by the OLD token** (and `install.sh` sends the NEW token) → `401` → the reload is silently dropped → the process never re-reads the new config. (lesson #27's "no restart needed" only holds when the token is unchanged — true for `--stop-share`/`--unlink`, false for `--join` and token-minting `--share`.)
- **Workaround:** `./install.sh --restart` after any token-changing `--join`/`--share`.
- **Fix:** drop the token gate on `/link/reload` — it's already **loopback-only**, and the main port's local routes (`/sse`,`/message`,`/pending`) are token-free anyway, so the token adds nothing there — *or* have `install.sh` `--restart` instead of `--reload` when the token changes. (DEVELOPER lesson #27 says "never make `/link/reload` token-free" for defense-in-depth; revisit that, since loopback-only is the real boundary.)

### BUG-4 — `--share --named-tunnel <h>` is ignored if any tunnel is already open
- **Symptom:** `./install.sh --share --named-tunnel bridge.houserbot.com` prints `Tunnel already open: https://<old-quick>.trycloudflare.com` and a join link with the **quick** URL — the named tunnel never starts.
- **Root cause:** the "tunnel already open" guard (`share_bridge()`, ~install.sh:632) runs **before** the `--named-tunnel` branch and `return`s without ever reading `$named_tunnel`. It reuses *any* running tunnel, even when a different (named) one was explicitly requested.
- **Workaround:** `./install.sh --stop-share` (closes the running tunnel + clears the PID/URL files), then `./install.sh --share --named-tunnel <h>`.
- **Fix:** only reuse the running tunnel if it matches the request — no `--named-tunnel` → reuse (current behavior); `--named-tunnel <h>` and the running URL is already `https://<h>` → reuse; otherwise **close the old tunnel and start the requested one**.

---

## Open — operational gotchas (not product bugs, but bit us)

### OPS-1 — launching a daemon over `ssh` doesn't detach with plain `&`/`nohup`/`setsid … &`
- **Symptom:** `ssh host '… cloudflared … &'` appears to run but the process isn't there afterward (empty log, no proc); the ssh call may also hang holding the channel.
- **Fix that works:** `ssh host 'setsid -f <cmd> >/tmp/x.log 2>&1 </dev/null'` — `setsid -f` double-forks and returns immediately, fully detached and surviving the ssh disconnect. (For reboot-survival use a systemd service instead.)

### OPS-2 — `lsof -ti:7400 | xargs kill` kills your Claude sessions
- `lsof -ti:PORT` returns the listener **and every connected client** (Claude MCP sockets). Always add `-sTCP:LISTEN` to target only the server. Same self-foot-gun family as the `pkill -f bridge-server.mjs` self-match (use the `[b]racket` trick / kill by PID).

### OPS-4 — `git pull` doesn't update a running bridge (stale-server roster anomaly)
- **Symptom:** after pulling code on a node, the bridge still behaves like the old version. Concretely (real incident): a hub bridge started before the description-strip + roster commits kept broadcasting the **old roster** even after `git pull` — so on the *spoke* side, that hub's remote sessions showed `node:"local"` **and** carried descriptions (which the current code strips from the cross-node roster). The proof was the asymmetry: the current side advertised with empty descriptions, the stale side broadcast them.
- **Root cause:** the server loads `bridge-server.mjs` **once at startup**; `git pull` updates the file on disk but not the running process. (Hooks differ — they're re-exec'd per invocation, so hook fixes go live on pull alone.)
- **Fix / habit:** after pulling a *server* change, **restart the bridge on that node** (`./install.sh --restart`, or kill the listener `lsof -ti:PORT -sTCP:LISTEN | xargs kill` / `pkill -f '[b]ridge-server.mjs'` then `--start`). A stale node ALSO silently lacks every server-side fix since it started (heartbeat, lossless reconnect, hardening), so this isn't just cosmetic. Note: `./install.sh --start` over ssh after a kill proved flaky (BUG-1/2 + ssh-detach) — the robust manual start is `setsid -f node bridge-server.mjs >> /tmp/claude-bridge-server.log 2>&1 </dev/null`.

### OPS-3 — cloudflared can die / silently lose its edge connection
- `bridge.houserbot.com` returning Cloudflare `530`/`1033` while the bridge is fine = cloudflared exited or disconnected. It is not supervised by `install.sh`. Relaunch it; for always-on, run under systemd/launchd `Restart=always` and poll its metrics `/ready` (don't trust `pgrep`). (G2 in the findings doc.)

---

## Open — federation (low priority)

### G7 — spoke showed a stale remote roster during a hub outage → blocking-ask hang — FIXED
- **Symptom:** when the hub went down, the spoke's `list_sessions`/`/health` kept showing the hub's remote sessions as ghosts until reconnect. Observed live: after the VM hub was SIGKILLed, the Mac still listed `dev/f97f@agent-sandbox` though they were gone.
- **Real impact (not cosmetic):** the ghost made `resolveTarget` still resolve the unreachable name as `remote`, so a **blocking `ask` to it would hang the full 5-minute deadline** ("calling bridge…") before timing out — instead of failing fast with "not connected". (`notify` is non-blocking, so it was only silently dropped.)
- **Root cause:** on link-drop the spoke scheduled a reconnect but never cleared `remoteRoster`; it was only replaced on the next roster broadcast.
- **Fix:** clear `remoteRoster` the moment the hub link drops — in `scheduleSpokeReconnect()` (covers all drop paths: stream end/error, connect-rejection, request error) and `teardownHubStream()`. While the hub is unreachable, `list_sessions` shows only real local sessions, and an `ask`/`notify` to a former-remote returns instantly with "not connected". Repopulated from the `/link/register` response + roster broadcast on reconnect (self-heals). Regression: `test-federation-chaos.mjs` (G7 cases — roster cleared on hub drop; ask fails fast `<10s`, not 5 min).

### G5 — orphan-question adoption
- An un-answered question keeps `to:"<name>"` for 30 days; a NEW *local* session later registering under that same name inherits it as pending. Rare for auto-generated names; surprising for stable `CC_BRIDGE_SESSION` names. Left documented, not changed (touching it risks the legit reconnect-migration path).

---

## Fixed — BUG-5: hooks used the token-gated `/health` for liveness → sessions stopped auto-registering/auto-arming
- **Symptom (field-reported):** once the local bridge had a token (sharing on — hub OR spoke), new Claude sessions **no longer auto-registered** on the bridge, and **no longer got nudged to arm the idle-listener (Monitor)**.
- **Root cause:** `bridge-start-hook.sh`, `bridge-prompt-hook.sh`, and `bridge-hook.sh` probed liveness with `curl -sf .../health`. The full `/health` is **token-gated when sharing is on**, so `-sf` saw `401` → the hooks concluded "bridge down" and exited silently. SessionStart skipped the register nudge (→ no auto-register), and PostToolUse never reached the Monitor nudge (it only fires for a registered session). Two hooks also parsed `/health`'s `.sessions` list, which is unavailable token-free. Pre-federation (standalone, no token) `/health` was open, so it only broke after a token was introduced. This is lesson #26 (liveness must use the ungated `/health/ping`) which the hooks were never updated to follow.
- **Fix:** all hook liveness checks now use the ungated **`/health/ping`**; registration state comes from the ungated **`/whoami?session_id=`** (keyed on session_id) instead of scanning `/health`'s session list — so hooks stay token-free (they must never carry the token). Regression test: `tests/test-hook-token-liveness.sh` (starts a token-bearing bridge, asserts all three hooks still emit). Verified live against the running spoke bridge.

## Fixed — BUG-6: askers never armed the idle-listener (advisory nudge skipped)
- **Symptom (field-reported):** a session that ASKED a question didn't arm its Monitor/idle-listener — it rationalized the arm-nudge as informational and moved on, so it would silently miss questions arriving while idle.
- **Root cause:** the arm-nudge is advisory `additionalContext` from PostToolUse, and for an asker it arrives **bundled with the answer** `ask()` was blocking on — the model fixates on the answer and skips the nudge. Nothing enforced it (lesson #18's "accepted trade-off").
- **Fix:** enforce at turn-end. PostToolUse marks `.engaged` on `ask`/`reply`; the Stop hook blocks the turn **once per engagement** (loop-safe `.armblocked` marker, re-armed on next ask/reply) with the arm instruction if the `.monitor` stamp isn't `on`/`off`. At Stop the answer is delivered, so it lands cleanly and `block` makes the agent act. Tests: `test-monitor-trigger.sh` 13–18. DEVELOPER lesson #18 updated.

## Fixed (this branch)
- G1 spoke heartbeat, G3 qualified-notify lossless, G4 in-flight re-push, G6 `@node` case-insensitivity, S3/S4/S6 (rate limit / body cap / node+session caps / full-UUID ids / `injectRemote` allowlist), info-leak (description-strip, log `0600`+rotate, no content in log), `reply()`/`register()` arg validation. See CHANGELOG `[Unreleased]`.
