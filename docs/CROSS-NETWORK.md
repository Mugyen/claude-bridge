# 🌐 Federation — cross-network rooms

The complete guide to making Claude sessions on **different machines/networks**
talk to each other. If you only run sessions on one computer, you don't need any
of this — the bridge already works locally (see [USAGE.md](../USAGE.md)). This doc
is for when you want a teammate's machine, your VM, or a second laptop in the
conversation.

For the CLI reference, run `claude-bridge help`.

---

## 🧠 The model in 30 seconds

- You create a **room**. The machine that runs it is the **room owner** (it hosts
  the room and relays every message). Anyone else who connects is a **spoke** — a
  **room user** whose machine makes an *outbound* connection in.
- **Sessions never leave their own machine.** The link only carries bridge-to-bridge
  traffic. If it drops, every machine keeps working locally and messages re-sync
  when it returns.
- **Membership is per-machine.** Each spoke gets its own access token, so you can
  kick one machine without resetting everyone.
- A room is reachable **only while its owner is online** — the owner's machine *is*
  the server. Host it on an always-on box (a cloud VM, a home server) for 24/7.

```
   Laptop A (spoke) ──┐                         ┌── Laptop C (spoke)
                      │     outbound link       │
   Laptop B (spoke) ──┼───────────────▶ ROOM ◀──┘
                      │            (owner's machine, online)
   sessions stay local on each machine; only the rooms talk over the wire
```

> **Terminology:** this guide says **room** (the shared space) and **spoke** (a
> machine that joined). Two roles matter: the **room owner** (creates + hosts it)
> and a **room user** (joins it). Internally the owner's machine is the "hub," but
> you never need that word.

---

## ⚠️ Before you start

| Need | Room owner | Spoke (room user) | Check |
|---|---|---|---|
| `claude-bridge` installed | ✅ | ✅ | `claude-bridge version` |
| `node`, `jq`, `curl` | ✅ | ✅ | `claude-bridge doctor` |
| Claude Code CLI | optional\* | ✅ | `claude --version` |
| A tunnel binary | only for non-p2p transports | ❌ | p2p (default) needs `dumbpipe`, auto-installed |
| Network | reach the internet | reach the internet | both ends online |

\*The room owner can be a **headless server** with no Claude CLI — it just hosts and
relays. `claude-bridge install` detects no `claude` and installs server-only (skips
hooks/MCP/skill, keeps the command). You run the actual sessions on the spokes. See
the **Hosting for a community you don't join** section below.

> 🔐 **Join links and the room password are secrets.** Anyone with them can join and
> see session names. Share them over a private channel; never paste into a public
> repo, issue, or chat.

---

# Part 1 — As a room OWNER

## 🚀 The 30-second version

```bash
claude-bridge room start            # creates a password-protected room, opens it,
                                    # prints a join code + the password (once)
```
Output ends with something like:
```
✓ Room "vedant-laptop" is ● ACTIVE — you're hosting
  Or just tell them:  claude-bridge join vedant-laptop
  Room password (shown ONCE):  8f2c1a…
```
Tell a teammate the **code** and **password**. They run `claude-bridge join <code>`,
type the password, and they're in. That's the whole flow.

## 🛠️ Creating the room with options

`room start` auto-creates a sensible default (password-protected, named after your
machine, p2p transport). To set things up front, use `room create`:

```bash
claude-bridge room create acme-team                 # named, password generated + shown once
claude-bridge room create acme-team --password hunter2hunter2   # your own password
claude-bridge room create demo --open               # NO password — anyone with the code joins
claude-bridge room create acme-team --e2ee          # end-to-end encrypted (see Part 3)
claude-bridge room create acme-team --ttl 4h        # self-expiring room (auto-deletes after 4h)
claude-bridge room create acme-team --stable bridge.example.com   # cloudflared named tunnel
claude-bridge room create acme-team --tailscale     # tailnet-only, no public URL
```

- **One room per machine.** `room start` reopens your existing room; `room create`
  refuses a second one (delete the first to make a new one).
- Default transport is **p2p** (encrypted, no account, no public URL). Override with
  `--stable <host>` (cloudflared named tunnel), `--tailscale`, or
  `--provider bore|pinggy|zrok`. See the [transports table](#-transports).

## 🎟️ Letting people in — two doors

| Door | Command | When |
|---|---|---|
| **Password** (default) | share the code + password | Everyday "let my teammate in." Anyone who knows it joins. |
| **One-time invite** | `claude-bridge room invite --one-time` | When you'd rather **not** hand out the password — a single-use, revocable link for one machine. |

```bash
claude-bridge room invite                       # a reusable invite link
claude-bridge room invite --one-time            # single use, dies after one join
claude-bridge room invite --expires 2h          # time-limited
claude-bridge room invite --code team-friday    # also publish it as a speakable code
```

> **Tip:** the `room create` output reminds you — prefer `room invite` over resharing
> the password when adding one specific machine.

## 🔤 Speakable join codes (rendezvous)

So people run `claude-bridge join acme-team` instead of pasting a long link. The
code is published to a tiny directory service (default `r.houserbot.com`; fully
optional, self-hostable — see [`rendezvous/README.md`](../rendezvous/README.md)).

- `room start` / `room create` **auto-publish** the code (the room's name).
- `room stop` / `room delete` **release** it, so a dead room frees its name.
- Codes are pure convenience — if the rendezvous is down, the long link always works.
- Point at your own instance: `echo https://my-worker.example > ~/.claude/.cc-bridge-rendezvous`

## 👥 Managing members

```bash
claude-bridge room members          # who's in the room, with ● online / ○ offline
claude-bridge room info             # room summary (members, invites, password, expiry)
claude-bridge room kick laptop-x    # revoke ONE machine — its token dies instantly, stays dead
claude-bridge room rotate laptop-x  # re-issue one member's token (hand them the new one safely)
claude-bridge room rotate-password  # change the room password (prints a new one once)
```
Membership is keyed by machine (node). Kicking removes that machine and everyone on
it; controlling which *sessions* on a machine are visible is the
[airlock](#-privacy-the-airlock) (Part 2).

## ⏯️ Pausing vs destroying

```bash
claude-bridge room stop      # the everyday "off": closes the room, releases the code,
                             # KEEPS everything (members, password, key). room start reopens it.
claude-bridge room delete acme-team   # destroy it (type the name to confirm): all tokens die, code released
```

## 🏷️ Naming, listing, history

```bash
claude-bridge node                  # show this machine's name (shown as name@<node> across the room)
claude-bridge node mac-studio       # set it (re-keys you as owner automatically if you host a room)
claude-bridge room list             # rooms THIS machine hosts: state (● active / ⏸ paused) + ownership
claude-bridge room history          # timeline of rooms you created / started / stopped / joined / left
```

## 🏠 Hosting for a community you don't join — `--host-only`

```bash
claude-bridge room create community --host-only
```
Your machine runs the room and relays for everyone, but **none of your own sessions
participate** — they're invisible and unreachable to the room (and unaffected
locally). Pure landlord. Pair with a headless server install for an always-on
community room with no Claude on the box itself.

---

# Part 2 — As a room USER (joining)

## 🚪 Joining

```bash
claude-bridge join acme-team                       # by speakable code → prompts for the password
claude-bridge join acme-team --password hunter2hunter2   # non-interactive
claude-bridge join 'https://host#invite:ab12…'     # by an invite link (no password needed)
claude-bridge join 'p2p:endpoint…#…'               # by a direct p2p link
```
- A **bare word** (no `://`, no `#`) is treated as a code and resolved via the
  rendezvous; anything that looks like a link is used directly.
- **Re-joining is free.** Leaving or going offline does **not** revoke your
  membership — `join` reuses your existing token and re-links with **no password
  prompt**. You're only asked again if you were kicked.

## 🔍 Talking to remote agents

Once joined, remote sessions appear in `list_sessions` tagged with their node:

```
list_sessions() →  reviewer@acme-laptop ,  db-admin@vm-1
ask(to="reviewer@acme-laptop", question="…")     # blocks for an answer
notify(to="db-admin@vm-1", content="…")          # one-way FYI
```
A **bare name** resolves local-first; use `name@node` to reach a specific remote
peer when names collide. (Scratchpads are local-only — use `ask`/`notify` across
machines.)

## 🕶️ Privacy: the airlock

By default all your sessions are visible to the room. You control which ones:

```bash
claude-bridge sessions                  # 🌐 EXPOSED (in the room) vs 🔒 hidden
claude-bridge expose research api db    # put sessions IN the room (space- or comma-separated)
claude-bridge expose --all              # expose everything
claude-bridge hide secrets              # pull one OUT
claude-bridge hide --all
claude-bridge join acme-team --expose none   # join with EVERYTHING hidden by default
```
**The airlock rule:** exposed and hidden sessions on your machine **can never message
each other** — both directions. So a room stranger who charms your exposed agent can
*not* get it to relay secrets out of a hidden one.

## 👋 Leaving

```bash
claude-bridge room leave            # leave the room → back to standalone (keeps your token for a free re-join)
```

---

# Part 3 — End-to-end encryption (optional)

A room created with `--e2ee` seals member↔member messages so the relay carries only
ciphertext (chacha20-poly1305, zero dependencies). **It's a shared room key** — every
member (and the owner) holds the same copy.

```bash
claude-bridge room create acme-team --e2ee --password
```

**Do you need it?** Usually not — see the full callout in
[USAGE.md](../USAGE.md#privacy-zones-exposure--the-airlock). Short version:
- **p2p between machines you own → adds nothing** (the p2p transport is already
  end-to-end encrypted, both ends are yours, and the owner holds the key anyway).
- **Earns its keep only when traffic crosses a relay you don't fully trust** — a
  public tunnel that terminates TLS, or a hosted/community relay. It does *not* hide
  messages from the room's owner.

Key distribution is automatic: invite links carry the key in the `#fragment` (never
sent to any server), and password joiners get it unwrapped from their password.
Caveat: kicking revokes *access*, not *knowledge* — recreate the room to truly rotate.

---

## 🔌 Transports

p2p is the default and the right choice for most people. Pick another only when you
need a stable public URL or a tailnet-internal link.

| Transport | Flag | Account? | Encryption | Notes |
|---|---|---|---|---|
| **p2p** *(default)* | — | No | ✅ end-to-end (QUIC) | No public URL; both machines must be online; ticket = the secret |
| cloudflared named | `--stable <host>` | Cloudflare | TLS to CF edge | Stable URL on your domain; one connector only |
| tailscale | `--tailscale` | Tailscale | WireGuard | Both machines on your tailnet; no extra process |
| bore / pinggy / zrok | `--provider <p>` | varies | varies | See trade-offs in [USAGE.md](../USAGE.md). **bore is plaintext — demo only.** |

> **SSE caveat:** some HTTP tunnels buffer long-lived streams. p2p, tailscale, and
> cloudflared *named* tunnels are stream-safe; avoid plain HTTP relays for real use.

---

## 🩺 Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| `join <code>` → "not found" | Code expired or the room is stopped → ask the owner for a fresh code or the long link |
| Spoke `status`/`health` shows "owner ○ unreachable" | The owner's machine is offline or its tunnel dropped → it resumes when they're back (or you were kicked — they'd differ in wording) |
| Re-join asks for a password again | You were **kicked** (membership revoked). Otherwise re-join is silent. |
| Remote sessions don't appear | Give it a few seconds; `claude-bridge health` on both ends should show the right room/role |
| Renamed your machine, room shows the old name | `node <name>` re-keys an owner automatically; a spoke should re-join (silent) |
| Something's genuinely broken | Open a session and say **`debug bridge`** — the read-only debugger diagnoses it and hands you a fix |

---

## 📌 Quick reference

```
OWNER:   claude-bridge room start                  # open a room (+ join code + password)
         claude-bridge room create <name> [--open|--password v] [--e2ee] [--host-only] [--stable <host>|--tailscale]
         claude-bridge room invite [--one-time]    # a link instead of the password
         claude-bridge room members | info | list | history
         claude-bridge room kick <node> | rotate <node> | rotate-password
         claude-bridge room stop                   # pause (keeps everything)
         claude-bridge room delete <name>          # destroy

USER:    claude-bridge join <code>                 # prompts for the password
         claude-bridge join '<link>' [--password]  # invite/p2p link
         claude-bridge sessions
         claude-bridge expose <names>|--all  ·  hide <names>|--all
         claude-bridge room leave

ANY:     claude-bridge status | health | doctor    # room, members, reachability
         claude-bridge node [name]                 # this machine's name
```
