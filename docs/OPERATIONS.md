# Operations / command helper

A practical cheat-sheet for running and testing the federation — distilled from
real deploys. For the conceptual docs see `USAGE.md`; for open issues see
`KNOWN-BUGS.md`.

> **Secrets:** `<TOKEN>` = your hub's token, `cat ~/.claude/.cc-bridge-token`.
> Never commit the real token. Join links carry the token in the URL `#fragment`.

---

## 0. Safety rules (read once)
- **Run `--share` / `--join` / `--stop` / `--restart` from a plain terminal, NOT a Claude session bound to the bridge.** Restarting the bridge drops that session's MCP transport and the harness can SIGKILL it mid-command (lesson #23). Plain `--start` is safe.
- **Kill a bridge by its LISTENER only:** `lsof -ti:PORT -sTCP:LISTEN | xargs kill`. Never `lsof -ti:PORT | xargs kill` — that also returns connected Claude-session PIDs (OPS-2).
- **The fixed code lives on `feature/cross-network-federation`.** `git checkout` it on every machine before installing, or you'll run the old code.
- After any **token-changing** `--join`/`--share`, you currently must `--restart` (BUG-3).
- **`git pull` does NOT update a running bridge.** The server loads `bridge-server.mjs` once at startup — after pulling a *server* change, **restart the bridge on that node** (`./install.sh --restart`, or kill the listener + `--start`). Hooks are the exception: they're re-read on every invocation, so hook fixes go live on pull alone. Each machine has its own checkout, so `git pull` on **every** node, then restart its bridge. Symptom of a stale server: it broadcasts an old roster — cross-node **descriptions leak** and remote sessions are **mis-tagged `local`** (OPS-4).

---

## 1. Ports & files
| What | Where |
|---|---|
| Main bridge (local routes, never tunneled) | `127.0.0.1:7400` (`CC_BRIDGE_PORT`) |
| Fed link surface (hub mode; the tunnel points here) | `127.0.0.1:7401` (`CC_BRIDGE_FED_PORT`, default `PORT+1`) |
| PID / logs | `/tmp/claude-bridge.pid`, `/tmp/claude-bridge-server.log`, `/tmp/claude-bridge-tunnel.{pid,url,log}` |
| Fed config | `~/.claude/.cc-bridge-{token,role,hub,node}` |

---

## 2. Deploy a HUB (e.g. on a server)
```bash
git checkout feature/cross-network-federation
./install.sh                 # hooks + MCP + skill
./install.sh --start         # start the bridge on :7400
# from a SEPARATE terminal:
./install.sh --share                         # quick tunnel (ephemeral *.trycloudflare.com URL)
#   OR a stable named tunnel (see §4):
./install.sh --share --named-tunnel <your-host>
./install.sh --check         # role=hub, fed port, tunnel URL + join link
```
The printed **join command** is what spokes run.

## 3. Join as a SPOKE (e.g. your laptop)
```bash
git checkout feature/cross-network-federation
./install.sh
./install.sh --join 'https://<host>#<TOKEN>'   # paste the hub's exact join link
./install.sh --restart                          # needed today (token changed → BUG-3)
./install.sh --check                            # role=spoke, hub=<host>, link connected
```
Then **restart your Claude session** so its MCP attaches to the (re)started bridge; it auto-registers. `list_sessions` now shows remote sessions tagged with their `node`; address them by name or `name@node`.

---

## 4. Named tunnel (stable URL, reliable SSE) — the recipe that worked
Quick tunnels **buffer the hub→spoke SSE** (messages to a spoke stall). Use a named tunnel for anything real.

**One-time (per tunnel, on your machine with Cloudflare auth):**
```bash
cloudflared tunnel login                 # browser auth → ~/.cloudflared/cert.pem
cloudflared tunnel create <name>         # → ~/.cloudflared/<UUID>.json ; name it = the hostname for install.sh's --named-tunnel to work
cloudflared tunnel route dns <name> <host>   # DNS route (account-level, persists across machines)
```

**Run the named tunnel on the hub machine (origin = the fed port):**
```bash
# install.sh way (tunnel NAME must equal the hostname):
./install.sh --share --named-tunnel <host>
#   ⚠️ if a tunnel is already open, run ./install.sh --stop-share FIRST (BUG-4)

# robust manual way (by UUID — no cert/name-resolution needed):
cloudflared tunnel run --url http://localhost:7401 <UUID>
#   join link is then:  https://<host>#<TOKEN>
```

**Moving an existing named tunnel to another machine** (creds are account-bound; DNS route persists):
```bash
# stop it on the old machine first (one runner per tunnel):
pkill -f 'cloudflare[d] tunnel'                       # bracket trick avoids self-match
scp ~/.cloudflared/<UUID>.json ~/.cloudflared/cert.pem  newhost:~/.cloudflared/
# on newhost, start it DETACHED so it survives the ssh disconnect (OPS-1):
ssh newhost 'setsid -f cloudflared tunnel run --url http://localhost:7401 <UUID> >/tmp/cf.log 2>&1 </dev/null'
```

---

## 5. Verify / inspect
```bash
./install.sh --check                                   # role, ports, tunnel, link
curl -s localhost:7401/health/ping                     # hub liveness (no token; shows role/node)
curl -s https://<host>/health/ping                     # tunnel reaches which hub? → "node":"..."
curl -s -H "X-Bridge-Token: <TOKEN>" localhost:7400/health    # full health (token-gated when sharing)
lsof -nP -iTCP -sTCP:LISTEN | grep -E '7400|7401'      # who's bound
# token gate over the tunnel:
curl -s -X POST -d '{}' https://<host>/link/register                          # → 401
curl -s -H "X-Bridge-Token: <TOKEN>" -X POST -d '{"node":"x"}' https://<host>/link/register   # → 200
```

## 6. Teardown
```bash
# spoke:  ./install.sh --unlink
# hub:    ./install.sh --stop-share        # closes tunnel, keeps token for fast re-share
# stop the bridge (from a non-bound terminal):  ./install.sh --stop
```

---

## 7. Troubleshooting (symptom → cause → fix)
| Symptom | Cause | Fix |
|---|---|---|
| `https://<host>` → `530` / `1033` | cloudflared exited / lost edge (OPS-3) | relaunch cloudflared (§4); for always-on use systemd `Restart=always` |
| `--start` printed nothing, bridge not up | foreign server on `:7400`, no PID file (BUG-1) | `lsof -ti:7400 -sTCP:LISTEN \| xargs kill` then `--start` |
| hub rejects the correct token (`401`) | running process has an old token; reload was dropped (BUG-3) | `./install.sh --restart` |
| dotfiles say spoke but it's still a hub | token-change reload silently failed (BUG-3) | `./install.sh --restart` |
| `--share --named-tunnel` kept the quick tunnel | "already open" short-circuit ignores `--named-tunnel` (BUG-4) | `--stop-share` then `--share --named-tunnel <h>` |
| messages reach the hub but not back to a spoke | quick-tunnel SSE buffering | use a named tunnel (§4) |
| daemon won't stay up over ssh | plain `&`/`nohup` doesn't detach (OPS-1) | `setsid -f … </dev/null >log 2>&1` |
| killing `:7400` killed a Claude session | used `lsof -ti:7400` (incl. clients) (OPS-2) | add `-sTCP:LISTEN` |
| remote sessions show as `node:"local"` and/or carry descriptions | that node's bridge is running **stale code** (pulled but never restarted) — broadcasts the old roster format (OPS-4) | restart the bridge on that node so it loads the pulled `bridge-server.mjs` |
