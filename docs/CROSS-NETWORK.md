# 🌐 Cross-Network Setup — connect bridges across machines

This is the **getting-started guide for linking two (or more) machines** so Claude
sessions on different computers/networks can talk to each other. If you only run
sessions on one machine, you don't need any of this — the bridge already works
locally out of the box.

For everyday local usage and the tool reference, see [USAGE.md](../USAGE.md).
For the CLI command list, run `claude-bridge help`.

---

## 🧠 The model in 30 seconds

- One machine is the **hub**. It opens a public tunnel (via `cloudflared`) and accepts links. Best choice: an always-on box with a stable connection (a cloud VM, a home server).
- Every other machine is a **spoke**. It makes an **outbound** connection to the hub. Spokes can be laptops behind NAT/firewalls — they never need to be reachable from outside.
- **Your sessions always stay on their own local bridge.** The link only carries bridge-to-bridge traffic. If the link drops, every machine keeps working locally; messages re-sync when it returns.
- A shared **token** is the trust boundary: everyone with the token is in the group. One token per hub is fine.

```
   Laptop A (spoke) ──┐                        ┌── Laptop C (spoke)
                      │   outbound link        │
   Laptop B (spoke) ──┼──────────────▶  HUB  ◀─┘
                      │              (cloud VM, tunnel open)
   sessions stay local on each machine; only the bridges talk over the tunnel
```

---

## ⚠️ Before you start (prerequisites)

| Need | Hub | Spoke | How to check |
|---|---|---|---|
| `claude-bridge` installed | ✅ | ✅ | `claude-bridge version` |
| `node`, `jq`, `curl` | ✅ | ✅ | `claude-bridge doctor` |
| Claude Code CLI | optional* | ✅ | `claude --version` |
| `cloudflared` | auto-installed by `share` | ❌ | `claude-bridge share` handles it |
| Network | must allow the tunnel out | must reach the internet | — |

\*A hub can be a **headless server** with no Claude CLI — it just relays. `claude-bridge install` detects that and installs in server-only mode (skips hooks/MCP/skill, still installs the command). You run sessions on the spokes.

> 🔐 **The token is a secret.** Anyone with it can join your group and see session names. Share the join link over a private channel; never paste it into a public repo, issue, or chat.

---

## 🚀 Step-by-step

### On the HUB (do this first)

1. **Install** (if not already):
   ```
   claude-bridge install      # or: curl -fsSL https://vijay2411.github.io/claude-bridge/install.sh | bash
   ```
2. **Start sharing.** This generates a token, auto-installs/updates `cloudflared`, opens a tunnel, and prints a **join link**:
   ```
   claude-bridge share
   ```
   - Want a **stable URL** that survives restarts? Use a Cloudflare named tunnel:
     ```
     claude-bridge share --named-tunnel bridge.example.com
     ```
3. **Copy the join link** it prints — it looks like:
   ```
   claude-bridge join 'https://something.trycloudflare.com#<TOKEN>'
   ```
4. **Verify the hub:**
   ```
   claude-bridge health      # role=hub, tunnel URL shown
   ```

> 💡 Run `share`/`stop`/`restart` from a **plain terminal**, not from a Claude session that's connected to this bridge (tearing down the link can kill that session). See [USAGE.md](../USAGE.md) lesson #23.

### On each SPOKE

1. **Install** (if not already): `claude-bridge install`
2. **Paste the join link** from the hub:
   ```
   claude-bridge join 'https://something.trycloudflare.com#<TOKEN>'
   ```
3. **Verify the spoke:**
   ```
   claude-bridge health      # role=spoke, "Hub: <url> (reachable)"
   ```

That's it. Within a few seconds the rosters merge.

---

## ✅ Confirm it works

On any machine, from a Claude session (or `claude-bridge health`):

- `list_sessions()` now shows sessions from **all** linked machines, each tagged with its node, e.g. `alice@laptop-a`, `builder@hub`.
- To message a session on another machine, address it by **`name@node`**:
  - `ask(to="builder@hub", question="…")`
  - `notify(to="alice@laptop-a", content="…")`
- A **bare name** resolves **local-first** — if two machines have a `builder`, `ask(to="builder")` hits your local one; use `builder@othernode` to reach the remote.

---

## 🔌 Stopping, disconnecting, reconnecting

| You want to… | Run | Where | Effect |
|---|---|---|---|
| Spoke leaves the group | `claude-bridge unlink` | spoke | back to standalone; **keeps the token** for a fast rejoin |
| Hub stops sharing | `claude-bridge stop-share` | hub | closes the tunnel, back to standalone; keeps the token |
| Spoke rejoin (token saved) | `claude-bridge join '<link>'` | spoke | re-links (get a fresh link if the hub re-shared) |
| Hub re-open | `claude-bridge share` | hub | new tunnel + join link (quick-tunnel URLs rotate; named tunnels stay constant) |
| Fully forget federation | `rm -f ~/.claude/.cc-bridge-{token,role,hub,node}` then `claude-bridge restart` (separate terminal) | either | wipes the token; no fast rejoin |

These commands flip a **running** bridge in place (no restart, no dropped sessions). Every one of them clears the previous link locally first — so even if the old hub is **down**, your machine cleans up its connection cleanly (no stuck "calling bridge", no ghost sessions).

If the link just **drops** (laptop sleeps, hub reboots, tunnel blips): do nothing. The spoke reconnects automatically with backoff, and any messages queued during the outage re-deliver once. Local work is never blocked.

---

## 🩺 Troubleshooting

| Symptom | Try |
|---|---|
| `share` says "cloudflared not found" | It auto-installs; if that's disabled, `brew install cloudflared` (macOS) — no Cloudflare account needed for a quick tunnel |
| Spoke `health` shows "Hub NOT reachable" | Hub is down, or its tunnel closed. Re-run `claude-bridge share` on the hub and re-`join` with the new link |
| Remote sessions don't appear in `list_sessions` | Give it a few seconds; check `claude-bridge health` on both ends shows the right role; confirm both used the **same token** |
| Join link "stopped working" | Quick-tunnel URLs rotate when `cloudflared` restarts — re-`share` on the hub for a fresh link, or use `--named-tunnel` for a permanent one |
| Two machines, same session name | Bare-name `ask` is local-first; reach the remote one as `name@node` |
| Something's genuinely broken | Open a session and say **`debug bridge`** — the read-only debugger will diagnose it and hand you a fix |

---

## 📌 Quick reference card

```
HUB:     claude-bridge share                         # → prints join link
         claude-bridge share --named-tunnel <host>   # stable URL
         claude-bridge stop-share                     # stop accepting links

SPOKE:   claude-bridge join 'https://<host>#<token>'  # link to the hub
         claude-bridge unlink                          # leave the group

ANY:     claude-bridge health      # role, topology, connected clients
         claude-bridge doctor      # deep check (tunnel, ports, drift, errors)
```
