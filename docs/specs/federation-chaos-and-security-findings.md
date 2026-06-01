# Federation — chaos testing, security audit & tunnel research findings

Date: 2026-05-30. Branch: `feature/cross-network-federation` (v2.7.0).
Method: a local deterministic chaos harness (`tests/test-federation-chaos.mjs`, 30
assertions) + a **real** Mac-hub ↔ GCP-VM-spoke run over the named Cloudflare
tunnel `bridge.houserbot.com` + a 17-agent adversarial security workflow + tunnel
research. The live `:7400` bridge and `main` were never touched.

---

## 1. What is robust (validated, do not change)

**Federation logic — exhaustively exercised, all green:**
- 3-way roster merge (hub + 2 spokes) propagates within ~0.3s; `onLocalRosterChange` works across two spokes.
- **Spoke→hub→spoke routing**: `bob@spokeA` asks `carol@spokeB`, hub relays the question and routes the answer home. ✓
- Hard spoke crash (SIGKILL) → hub roster prunes the spoke **promptly** (stream-close, ~2s even over the tunnel); local sessions and the other spoke are unaffected.
- Hub crash + restart → spokes auto-reconnect (exponential backoff 1→2→5→…→30s) and the roster re-merges; messaging resumes.
- `name@node` collision: bare names resolve **local-first**; `@node` targets the remote one; the wrong side never receives it.
- Auth stays enforced under all chaos: fed port 401s without/with-wrong token, 404s local routes; main port 404s `/link/*`; `/health/ping` leaks no names.
- **Real tunnel:** baseline cross-net `ask`/`reply`/`notify` ✓; lossless queued-notice flush works when the spoke's `lastSeen` is fresh ✓; a deliberate **tunnel flap** (killed cloudflared) → spoke detects the drop (`HTTP 530 — retrying`, clean backoff, no hot-loop) → auto-reconnects within ~6s of the tunnel returning → roster re-merges → fresh ask works ✓.

**Security core — adversarially checked, sound:**
- The **two-listener split**: main `127.0.0.1:PORT` (all local routes, never tunneled) vs hub-only fed `127.0.0.1:FED_PORT` (token-gated `/link/*` + content-free `/health/ping` only, everything else 404s). The hole is closed *by construction*.
- `tokenOk` (length-check before `timingSafeEqual`, try/catch, rejects non-string headers, 503-before-401 guardrail, never fail-open on the tunneled surface). 256-bit CSPRNG token, `chmod 600`, token carried on the URL `#` fragment, **never logged**.
- `/link/reload` double-locked (loopback-peer + token), main-server-only.
- The additive-relay model (`injectRemote` puts a shape-identical object into the local store; idempotent on replay).
- Crash nets: `uncaughtException`/`unhandledRejection`, `server.on("error")→exit(1)` on **both** listeners.

**Verdict on the stated bar ("nobody with *unauthorized* access can hack this"): MET.** Every dangerous remote primitive requires the shared token. An anonymous internet attacker with the tunnel URL cannot register, ask, notify, read pending, or enumerate sessions.

---

## 2. Resilience gaps found by chaos testing (ranked)

### G1 — Lossless-reconnect window is unreliable (no spoke heartbeat) — **HIGH**
**The single most important finding.** The hub's relay queue (`pendingRelay`) is deleted by `spokeSweep` when a spoke is `dead && (now - lastSeen > 45s)`. But **the spoke sends no periodic heartbeat** — the `/link/heartbeat` endpoint exists and refreshes `lastSeen`, yet `connectToHub` never calls it; the 25s `ka` ping is hub→spoke and does **not** refresh `lastSeen`. So `lastSeen` only advances on actual message traffic. An idle spoke is *already* stale when it disconnects, and the next 15s sweep tick deletes its queue — dropping any message queued for it.

Proven live over the tunnel:
- Spoke idle ~46s, killed → notice queued at `08:28:28` → **pruned at `08:28:36` (~10s later)** → reconnect at `08:29:03` found an empty queue → **notice lost.**
- Repeat with a forward right before the kill (fresh `lastSeen`) → notice **delivered** on reconnect.

**Fix:** spoke POSTs `/link/heartbeat` every ~25s (sub-100s also satisfies the Cloudflare keepalive requirement — see §4). Then the 45s window counts from real disconnect. (Alternative/extra: set `lastSeen = now` on stream-close so the timer starts at disconnect.)

### G2 — cloudflared can die mid-session and not restart — **HIGH (operational)**
During this session `bridge.houserbot.com` went 200→530 on its own: cloudflared logged `accept stream listener encountered a failure while serving` → `no more connections active and exiting` → process exited. It did **not** come back; I had to relaunch it. Matches cloudflared #724 (can die/disconnect; don't trust `pgrep`).
**Fix:** run cloudflared under a supervisor (launchd/systemd `Restart=always`), and/or poll its metrics `GET /ready` (200 = ≥1 edge connection) with a pinned `--metrics 127.0.0.1:<port>`. Document this in USAGE.

### G3 — Qualified `notify name@node` to an offline spoke is dropped — **MEDIUM**
`resolveTarget`'s hub-side offline-spoke fallback (lesson #25) only covers **bare** names. `notify carol@spokeb` while spokeB is briefly down resolves to `none` and is mis-queued on the hub instead of `markPendingRelay`'d → never relayed. The **bare** `notify carol` form **is** lossless.
**Fix:** add the offline-spoke scan to the `@node` branch of `resolveTarget` (or queue any unresolved remote-qualified target by node).

### G4 — In-flight question lost if the answerer's spoke crashes after receiving — **MEDIUM**
If a relayed question reaches a spoke (delivered while live) and that spoke crashes before replying, the hub never `markPendingRelay`'d it and `flushSpokeOutbound` only re-sends *locally-originated* messages — so reconnect re-delivers nothing and the asker times out at the 5-min `ask` deadline.
**Fix:** on spoke reconnect, re-push hub-side questions still `answer===null` addressed to that node (extend `flushPendingForwards` to scan `messages`, not just `pendingRelay`).

### G5 — Orphan-question adoption — **LOW**
An un-answered question keeps `to:"<name>"` for 30 days; a NEW *local* session later registering under that name inherits it as pending. Surprising for stable `CC_BRIDGE_SESSION` names.

### G6 — `@node` addressing is case-sensitive to the lowercased node id — **LOW (UX)**
`sanitizeNode` lowercases node ids, so the roster shows `name@mylaptop` and `ask("alice@MyLaptop")` fails. Either lowercase the node part of a qualified target in `resolveTarget`, or document it.

---

## 3. Security audit (insider / token-holder threat model)

The *external* bar is met (§1). These matter only if a token-holder turns malicious or a join link leaks — relevant because the stated long-term goal is "airtight." Full report retained from the audit workflow.

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| S1 | **High** | **Node-identity spoofing/takeover.** `X-Bridge-Node`/`payload.node` are the only identity source; nothing binds token→node. A token-holder can open `/link/stream` as a victim node (hub ends the incumbent — last-writer-wins), `register`-overwrite, or `unregister`-evict it. | Per-node tokens (or token→node HMAC); **minimum stopgap: first-writer-wins** on `/link/stream`+`/link/register` (refuse a node id already held by a different live stream). |
| S2 | Med | **Sender forgery / cross-session injection.** `injectRemote` writes `from`/`to` verbatim; `from` is never checked against the origin node's sessions, `to` can name any local session. Weaponizes the AI-to-AI "act on what you receive" protocol. | Make `from` server-derived + node-qualified from the *authenticated* node; validate it's in that node's advertised sessions. |
| S3 | Med | **Attacker-chosen `kind`.** A spoke can send `kind:"question"` for one-way content → un-clearable pending item that pins the target agent. | Allowlist `kind`; rate-limit injected pending questions per (origin, target). Use full UUIDs (the 8-hex id allows pre-claim). |
| S4 | Med | **Authenticated hub memory exhaustion / roster poisoning.** `/link/register` with no live stream still `spokes.set`s; sweep needs dead+stale(45s). Churned fake nodes + huge `sessions` bloat memory. | Cap node count + sessions/node; require a live stream within N s of register; bound `pendingRelay`. |
| S5 | Med | **Roster routing hijack.** A spoke advertising a victim's real session name → bare `ask` from a third node silently routes to the attacker (first-match). | Reject duplicate name claims across nodes; prefer `name@node` / first-owner-wins. |
| S6 | Low | No request-body size cap (`for await … body +=`), no rate limiting. | 256KB/1MB caps + 413; per-session/per-node token buckets; size-based eviction. |

**Plus a real correctness bug (any mode):** `reply()` never type-checks `answer`. A non-string `answer` is assigned to `msg.answer` *before* the length-log throws, leaving `answer===undefined` — which un-pends the question (`undefined !== null`) and ships garbage to the asker while returning an error to the replier. `register()` also doesn't type-check `name`. Guard both before mutating (the `broadcast({content:undefined})` lesson, unfinished here).

**Info disclosure:** the federation roster broadcasts every session's free-text `description` mesh-wide; message content (`question`/`content` slices) is logged to a world-readable `/tmp/claude-bridge-server.log` with no rotation. Strip `description` from the cross-node roster (or document it); `chmod 600` the log + rotate.

---

## 4. Tunnel robustness (research + live confirmation)

- **Named tunnel for production; quick tunnel is demo-only.** Cloudflare quick tunnels deliberately buffer SSE-over-GET (cloudflared #1449) — confirmed live earlier (hub→spoke roster/forward events buffered). The named tunnel streams correctly (confirmed live this session).
- **Add a sub-100s heartbeat on every long-lived stream, both directions** — interval **25s**, an SSE comment frame (`: ping`). Clears Cloudflare's ~100s read-timeout (524) with margin. The local `/sse` and hub→spoke `/link/stream` already ping at 25s; **the missing piece is the spoke→hub heartbeat (G1)** — one change fixes both keepalive and the lossless window.
- Response **must** be `Content-Type: text/event-stream` (the only thing Cloudflare reliably flushes; `X-Accel-Buffering`/chunked are *ineffective* on their own). Confirm the fed `/link/stream` sets it.
- Reconnect/backoff is already correct — add **jitter** (avoid thundering herd) and a **silent-stream watchdog** (reconnect if no data/heartbeat for ~2 intervals; proxies kill idle streams with no FIN). Consider `Last-Event-ID` for standards-based resume that dovetails with `flushPendingForwards`.
- Keep SSE (do not switch to WebSocket). A **Tailscale Serve** tier is worth documenting — per-peer WireGuard identity would directly remediate S1/S2.

---

## 5. Recommended fix order

1. **G1 spoke heartbeat** (also the §4 keepalive) — small, high value, removes the most surprising message-loss path.
2. **`reply()`/`register()` arg validation** — tiny correctness fix.
3. **S1 first-writer-wins** stopgap (+ S2 server-derived `from`) — converts "secure among mutual-trusters" → "secure even if a join link leaks."
4. **G3 qualified-notify fallback**, **G4 in-flight re-push** — close the remaining message-loss edges.
5. **G2 cloudflared supervisor** + USAGE docs; **info-leak** (roster description, log perms/rotation); **S4–S6** DoS hardening.

None are release-blockers *given* the docs state the trusted-group framing honestly; G1, the `reply()` bug, and S1 are the ones worth doing before calling federation "robust" / "airtight."

### Status (updated 2026-05-30)
- ✅ **G1 (spoke heartbeat)** — DONE. Spoke POSTs `/link/heartbeat` every 25s; regression test `tests/test-federation-heartbeat.mjs`.
- ✅ **`reply()`/`register()` arg validation** — DONE. Covered in `test-tools.mjs` + the chaos suite.
- ✅ **G3 (qualified-notify offline fallback)** — DONE. `resolveTarget`'s `@node` branch now uses the offline-spoke fallback, so `notify name@node` to a briefly-down spoke is lossless. Chaos assertion flipped to assert delivery.
- ✅ **G4 (in-flight re-push)** — DONE. `flushPendingForwards` now also scans `messages` and re-pushes any still-open question/notice addressed to a session on the reconnecting node — so a question the spoke received and lost to a crash is re-delivered and the asker is answered. Chaos assertion flipped.
- ✅ **G6 (`@node` case-insensitivity)** — DONE. The `@node` part is `sanitizeNode`-normalized before matching.
- ✅ **S3 (kind allowlist + full UUIDs), S4 (node/session caps), S6 (body cap + rate limit)** — DONE (`test-hardening.mjs`).
- ✅ **Info-leak** — DONE: descriptions no longer cross the link by default; message content removed from the log; log `0600` + rotated.
- ➖ **S1/S2/S5 (node identity)** — ACCEPTED, not engineered against (owner decision: "one shared token per hub is fine"). Per-node identity (TOFU/per-node tokens) was considered and **declined** to keep joining a one-paste op. The model is now stated honestly in USAGE "Security, honestly": one shared token = a trusted group; node ids/names are self-asserted within it; rotate the token to revoke. External/unauthenticated attackers remain fully blocked (the real bar).
- ✅ **G2 (cloudflared supervision)** — DONE (docs): USAGE "Keeping an always-on hub up" — run cloudflared under launchd/systemd `Restart=always`, poll its metrics `/ready` (don't trust `pgrep`). cloudflared is detect-and-instruct, so this is intentionally ops/docs not bridge code.
- ⬜ **G5 (orphan-adoption, low)** — left as documented minor behavior (a stable-named session reclaiming a pending question is sometimes desirable; changing it risks the legit reconnect-migration path).
