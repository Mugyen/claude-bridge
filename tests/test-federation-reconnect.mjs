// Cross-network federation — lossless reconnect (Phase 1, assertion 7).
//
// While the spoke's link is down, the hub queues a notice for a spoke-local
// session (stored in the durable messages map). When the spoke reconnects, the
// hub re-pushes the queued forward and the spoke delivers it — no message lost.

import { TestBridge, assert, reportAndExit, sleep } from "./lib.mjs";

const TOKEN = "fed-reconnect-tok";
const HUB_PORT = 7405;
const SPOKE_PORT = 7406;
// Explicit fed ports (see test-federation.mjs for why) — the hub's loopback link
// surface, which the spoke connects to and the tunnel would expose.
const HUB_FED_PORT = 7415;
const SPOKE_FED_PORT = 7416;

const hub = new TestBridge(HUB_PORT, { token: TOKEN, role: "hub", node: "hub" }, HUB_FED_PORT);
let spoke = new TestBridge(SPOKE_PORT, { token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${HUB_FED_PORT}` }, SPOKE_FED_PORT);

await hub.start();
await spoke.start();
await sleep(1500);

try {
  await hub.call("register", { name: "alice", description: "hub" });
  await spoke.call("register", { name: "bob", description: "spoke" });
  await spoke.reloadFed({ token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${HUB_FED_PORT}` });
  await sleep(1200);

  // Confirm the link is up: hub sees bob.
  const before = await hub.call("list_sessions");
  assert("link up: hub sees bob", (before.sessions || []).some((s) => s.name === "bob"), JSON.stringify(before));

  // ── Drop the spoke's link (stop the spoke entirely) ──────────────────────
  await spoke.stop();
  await sleep(800);

  // Hub still knows bob's name was advertised (spoke entry persists until sweep),
  // so a notify queues on the hub as an un-pushed forward.
  const queued = await hub.call("notify", { to: "bob", content: "queued-while-down" });
  assert("hub accepts notify to bob while link is down (queues)", queued.ok === true, JSON.stringify(queued));

  // ── Bring the spoke back on the same port/node ───────────────────────────
  spoke = new TestBridge(SPOKE_PORT, { token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${HUB_FED_PORT}` }, SPOKE_FED_PORT);
  await spoke.start();
  await sleep(1500);
  await spoke.call("register", { name: "bob", description: "spoke" });
  await spoke.reloadFed({ token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${HUB_FED_PORT}` });

  // ── The queued notice should flush to the reconnected spoke ──────────────
  let delivered = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const peek = await spoke.pending("bob", { peek: true });
    if (peek.includes("queued-while-down")) { delivered = true; break; }
  }
  assert("queued notice flushes to the reconnected spoke (lossless)", delivered, "notice never arrived after reconnect");

  // Idempotency: it should appear exactly once via check_inbox.
  await spoke.pending("bob"); // consume
  const ib = await spoke.call("check_inbox");
  assert("flushed notice is not duplicated", !(ib.notices || []).some((n) => n.content === "queued-while-down"), JSON.stringify(ib));
} finally {
  try { await spoke.stop(); } catch {}
  await hub.stop();
  reportAndExit();
}
