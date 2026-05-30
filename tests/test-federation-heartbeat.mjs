// Federation — spoke heartbeat keeps the hub's lossless-reconnect window honest.
//
// Regression for G1 (found by the real Mac↔VM tunnel chaos run): the hub sweeps a
// spoke's relay queue when it is dead AND lastSeen is stale. lastSeen only advances
// on message traffic, so WITHOUT a periodic heartbeat an IDLE spoke is already stale
// when it disconnects and its queued messages are deleted within one sweep tick.
//
// The fix: the spoke POSTs /link/heartbeat every SPOKE_HEARTBEAT_MS, so lastSeen
// stays fresh and the stale window counts from real disconnect.
//
// This test shrinks the timing via env (heartbeat 1.5s, stale 5s, sweep 1s) and:
//   1. idles the spoke for 7s (> stale) with ZERO message traffic, then crashes it;
//   2. asserts the hub's spoke entry SURVIVED (a notify still resolves bob@spoke,
//      target_online:true) — proving heartbeats kept lastSeen fresh. Without the
//      heartbeat the 7s-idle spoke would be stale-pruned on the first tick → the
//      notify would resolve to "none" (target_online:false, to:"bob").
//   3. waits past the stale window and asserts the entry IS finally pruned — so we
//      know the sweep still works (the heartbeat didn't make spokes immortal).

process.env.CC_BRIDGE_HEARTBEAT_MS = "1500";
process.env.CC_BRIDGE_SPOKE_STALE_MS = "5000";
process.env.CC_BRIDGE_SPOKE_SWEEP_MS = "1000";

import { TestBridge, assert, reportAndExit, sleep } from "./lib.mjs";

const TOKEN = "hb-token";
const HUB = 7446, HUB_FED = 7447, SP = 7448, SP_FED = 7449;

const hub = new TestBridge(HUB, { token: TOKEN, role: "hub", node: "hub" }, HUB_FED);
const spoke = new TestBridge(SP, { token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${HUB_FED}` }, SP_FED);

await hub.start();
await spoke.start();
await sleep(1500);

try {
  await hub.call("register", { name: "alice", description: "hub" });
  await spoke.call("register", { name: "bob", description: "spoke" });
  await sleep(1500);

  // Baseline: hub sees bob@spoke.
  const base = await hub.call("list_sessions");
  assert("baseline: hub sees bob@spoke", (base.sessions || []).some((s) => s.name === "bob" && s.node === "spoke"), JSON.stringify(base));

  // Idle 7s (> 5s stale cutoff) with NO message traffic. Heartbeats (every 1.5s)
  // keep the hub's lastSeen for the spoke fresh the whole time.
  await sleep(7000);

  // Crash the spoke. Its stream dies (dead=true) but lastSeen is ≤1.5s old.
  await spoke.stop({ signal: "SIGKILL" });
  await sleep(2000); // 1-2 sweep ticks run here; entry must NOT be pruned yet

  // The relay-queue entry survived → a bare notify resolves to the (offline-but-known)
  // remote spoke. This is the G1 fix: without the heartbeat the entry would already
  // be gone and this would resolve to a local-none dead-letter.
  const survived = await hub.call("notify", { to: "bob", content: "hb-window-probe-1" });
  assert("G1: spoke relay-entry SURVIVES an idle-then-crash (heartbeat kept lastSeen fresh)",
    survived.target_online === true && typeof survived.to === "string" && survived.to.endsWith("@spoke"),
    JSON.stringify(survived));

  // Now wait past the stale window from the last heartbeat (~kill time). The sweep
  // must finally prune the dead+stale spoke — proving we didn't make spokes immortal.
  await sleep(6000);
  const pruned = await hub.call("notify", { to: "bob", content: "hb-window-probe-2" });
  assert("sweep still prunes a genuinely-stale dead spoke (no immortal entries)",
    pruned.target_online !== true && pruned.to === "bob",
    JSON.stringify(pruned));
  const afterRoster = await hub.call("list_sessions");
  assert("hub roster no longer lists bob after prune", !(afterRoster.sessions || []).some((s) => s.name === "bob"), JSON.stringify(afterRoster));
} catch (e) {
  console.log(`\n✗✗ heartbeat test threw: ${e.message}\n${e.stack}`);
  assert("no uncaught exception", false, e.message);
} finally {
  try { await spoke.stop(); } catch {}
  await hub.stop();
  reportAndExit();
}
