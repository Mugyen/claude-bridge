// Tier 2 hardening: rate limiting, full-length message ids, request-body caps,
// federated-node/session caps. Timings/limits shrunk via env so the caps trip
// deterministically; production defaults are far higher.

process.env.CC_BRIDGE_RATE_MAX = "5";
process.env.CC_BRIDGE_RATE_WINDOW_MS = "60000"; // no meaningful refill within the test
process.env.CC_BRIDGE_MAX_BODY = "2000";        // 2KB body cap
process.env.CC_BRIDGE_MAX_NODES = "2";
process.env.CC_BRIDGE_MAX_SESSIONS = "3";

import http from "node:http";
import { TestBridge, assert, reportAndExit, sleep } from "./lib.mjs";

// POST a raw body to /message and return the HTTP status (used for the body cap).
function postMessage(port, sid, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${port}/message?session=${sid}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.write(body); req.end();
  });
}

const TOKEN = "harden-tok";
const STD = 7460;
const HUB = 7462, HUB_FED = 7463;

const std = new TestBridge(STD);
const hub = new TestBridge(HUB, { token: TOKEN, role: "hub", node: "hub" }, HUB_FED);
await std.start();
await hub.start();

try {
  await std.call("register", { name: "alice", description: "x" });

  // ── full-length message ids (S3: no 8-hex pre-claim) ──────────────────────
  const n = await std.call("notify", { to: "alice", content: "id check" });
  assert("message id is a full UUID (not 8 hex)", typeof n.message_id === "string" && n.message_id.length >= 32 && n.message_id.includes("-"), JSON.stringify(n));

  // ── rate limiting on message-creating tools (RATE_MAX=5; 1 used above) ─────
  // broadcast is the simplest creator. We already spent 1 token on the notify.
  let blocked = false, ok = 0;
  for (let i = 0; i < 8; i++) {
    const r = await std.call("broadcast", { content: `b${i}` });
    if (r.ok) ok++;
    else if (typeof r.error === "string" && /rate limit/i.test(r.error)) { blocked = true; break; }
  }
  assert("rate limit eventually blocks a burst of creators", blocked, `ok=${ok}`);
  assert("rate limit allowed a few before blocking (not zero)", ok >= 1 && ok <= 5, `ok=${ok}`);
  // reads are NOT rate-limited even after the creator budget is spent
  const lr = await std.call("list_sessions");
  assert("reads are not rate-limited", Array.isArray(lr.sessions), JSON.stringify(lr));

  // ── request-body cap → 413 (/message) ─────────────────────────────────────
  const big = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "broadcast", arguments: { content: "Z".repeat(5000) } } });
  const status = await postMessage(STD, std.sid, big);
  assert("oversized /message body → 413", status === 413, `status=${status}`);

  // ── request-body cap → 413 (/link/forward on the fed port) ────────────────
  const bigFwd = { kind: "notice", id: "x", from: "a", to: "b", content: "Z".repeat(5000), originNode: "na" };
  const fwd = await hub.raw("POST", "/link/forward", { token: TOKEN, node: "na", json: bigFwd });
  assert("oversized /link/forward body → 413", fwd.status === 413, JSON.stringify(fwd));

  // ── federated-node cap (MAX_NODES=2) ──────────────────────────────────────
  const a = await hub.raw("POST", "/link/register", { token: TOKEN, node: "na", json: { node: "na", sessions: [{ name: "s1" }] } });
  assert("1st node registers", a.status === 200, JSON.stringify(a));
  const b = await hub.raw("POST", "/link/register", { token: TOKEN, node: "nb", json: { node: "nb", sessions: [{ name: "s2" }] } });
  assert("2nd node registers (at cap)", b.status === 200, JSON.stringify(b));
  const c = await hub.raw("POST", "/link/register", { token: TOKEN, node: "nc", json: { node: "nc", sessions: [{ name: "s3" }] } });
  assert("3rd node rejected past MAX_NODES → 429", c.status === 429, JSON.stringify(c));
  // a node already known can still re-advertise (not a new node)
  const aAgain = await hub.raw("POST", "/link/register", { token: TOKEN, node: "na", json: { node: "na", sessions: [{ name: "s1" }, { name: "s1b" }] } });
  assert("known node can re-advertise past the cap", aAgain.status === 200, JSON.stringify(aAgain));

  // ── sessions-per-node cap (MAX_SESSIONS=3): over-long list is accepted (truncated), not rejected ──
  const many = await hub.raw("POST", "/link/register", { token: TOKEN, node: "nb", json: { node: "nb", sessions: Array.from({ length: 10 }, (_, i) => ({ name: `m${i}` })) } });
  assert("over-long session list accepted (truncated internally, not rejected)", many.status === 200, JSON.stringify(many));
} catch (e) {
  console.log(`\n✗✗ hardening test threw: ${e.message}\n${e.stack}`);
  assert("no uncaught exception", false, e.message);
} finally {
  await std.stop();
  await hub.stop();
  reportAndExit();
}
