# Operations cheat-sheet

A practical reference for running and debugging claude-bridge — ports, files,
safety rules, and the commands that matter. For the conceptual docs see
[USAGE.md](../USAGE.md); for the full federation walkthrough see
[CROSS-NETWORK.md](CROSS-NETWORK.md).

> **Secrets:** the room password and join links are secrets. The p2p ticket /
> any `#fragment` is the proof-of-access — never commit one or paste it publicly.

---

## 0. Safety rules (read once)

- **Run `start` / `stop` / `restart` from a plain terminal, NOT a Claude session bound to the bridge.** Restarting drops that session's MCP transport and the harness can SIGKILL it mid-command (DEVELOPER.md lesson #23). The room verbs (`room start`/`stop`/`join`/`leave`) hot-reload a *running* bridge and are safe — they don't restart it.
- **Kill a bridge by its LISTENER only:** `lsof -ti:PORT -sTCP:LISTEN | xargs kill`. Never `lsof -ti:PORT | xargs kill` — that also returns connected Claude-session PIDs.
- **`git pull` does NOT update a running bridge.** The server loads `bridge-server.mjs` once at startup. After pulling a server change, restart the bridge on that node (`claude-bridge restart`, from a non-bound terminal) — or just use `claude-bridge update`, which pulls + reinstalls + restarts. Hooks are the exception: re-read on every invocation, so hook fixes go live on pull alone.

---

## 1. Ports & files

| What | Where |
|---|---|
| Main bridge (local routes, never tunneled) | `127.0.0.1:7400` (`CC_BRIDGE_PORT`) |
| Fed link surface (when hosting a room; the link points here) | `127.0.0.1:7401` (`CC_BRIDGE_FED_PORT`, default `PORT+1`) |
| PID / logs | `/tmp/claude-bridge.pid`, `/tmp/claude-bridge-server.log`, `/tmp/claude-bridge-tunnel.{pid,url,log}` |
| Fed config | `~/.claude/.cc-bridge-{token,role,hub,node}` |
| Rooms store (owner) · room key · codes · history | `~/.claude/.cc-bridge-rooms.json` · `.cc-bridge-room-key` · `.cc-bridge-codes` · `.cc-bridge-room-history.jsonl` |

---

## 2. Host a room (e.g. on an always-on server)

```bash
claude-bridge install           # server-only install is auto-detected if no `claude` CLI
claude-bridge room start        # opens a password-protected room; prints a join code + password once
#   options: room create <name> [--open] [--e2ee] [--host-only] [--ttl 4h] [--stable <host> | --tailscale]
claude-bridge status            # Room "<name>" ● ACTIVE — you're hosting
```

## 3. Join a room (e.g. your laptop)

```bash
claude-bridge install
claude-bridge join <code>       # by speakable code (prompts for the password)
#   or: claude-bridge join '<invite-or-p2p-link>' [--password]
claude-bridge status            # In a room (member) via <link> — reachable
```
Your Claude sessions auto-register on the local bridge; `list_sessions` shows
remote sessions tagged with their `node`. Re-joining later is free (no password —
your membership token is reused) unless you were kicked.

---

## 4. Stable public URL (cloudflared named tunnel)

p2p (default) needs no setup. Use a named tunnel only when you need a fixed public
URL. One-time, on a machine with Cloudflare auth:

```bash
cloudflared tunnel login                          # → ~/.cloudflared/cert.pem
cloudflared tunnel create <name>                  # name it = the hostname
cloudflared tunnel route dns <name> <host>        # DNS route (persists per account)
```
Then host the room over it:
```bash
claude-bridge room create acme --stable <host>    # claude-bridge runs the named tunnel against the fed port
```
For an always-on room, run cloudflared under a supervisor (`launchd`/`systemd`,
`Restart=always`) against `http://localhost:$FED_PORT`. cloudflared can stay
running but lose its edge (Cloudflare `530`/`1033`) — poll its
`--metrics 127.0.0.1:<port>` `/ready` endpoint, don't trust `pgrep`.

---

## 5. Verify / inspect

```bash
claude-bridge health                                   # role, room, members, reachability
claude-bridge room list                                # rooms this machine hosts + state
claude-bridge room members                             # who's in the room (online/offline)
curl -s localhost:7401/health/ping                     # fed liveness (no token; shows role/node)
curl -s -H "X-Bridge-Token: $(cat ~/.claude/.cc-bridge-token)" localhost:7400/health   # full health
lsof -nP -iTCP -sTCP:LISTEN | grep -E '7400|7401'      # who's bound
```

## 6. Teardown

```bash
claude-bridge room leave        # spoke: leave the room → standalone (keeps token for a free re-join)
claude-bridge room stop         # owner: pause the room (keeps members + password; releases the code)
claude-bridge room delete <name># owner: destroy it (type the name to confirm)
claude-bridge stop              # stop the bridge process (from a non-bound terminal)
```

---

## 7. Troubleshooting (symptom → fix)

| Symptom | Fix |
|---|---|
| `start` printed nothing, bridge not up | foreign listener on `:7400` → `lsof -ti:7400 -sTCP:LISTEN \| xargs kill`, then `start` (or `restart --force`) |
| `join <code>` → "not found" | code expired or the room is stopped → ask the owner for a fresh code / the long link |
| spoke `status` shows "owner ○ unreachable" | owner offline or tunnel down → resumes when it's back (re-join is silent unless you were kicked) |
| messages reach the owner but not back to a spoke | an HTTP tunnel buffering SSE → use p2p, a cloudflared **named** tunnel, or tailscale |
| p2p spoke stuck on `ECONNREFUSED` | the local `dumbpipe` forwarder died → `claude-bridge doctor` prints the exact re-join command |
| killing `:7400` killed a Claude session | you used `lsof -ti:7400` (incl. clients) → add `-sTCP:LISTEN` |
| remote sessions show `node:"local"` / leak descriptions | that node runs **stale code** (pulled but not restarted) → restart its bridge so it loads the new server |
| something genuinely broken | open a session and say **`debug bridge`** — the read-only debugger diagnoses it |
