// Cross-network federation — switching hubs + clearing a DOWN old hub.
//
// Pins the guarantee that every federation reload tears down the PREVIOUS hub
// link locally and synchronously (applyFedConfig → teardownHubStream), so:
//   1. switching spoke from hubA → hubB drops hubA's roster (no stale ghosts)
//      and brings hubB's sessions in;
//   2. unlinking while the (now) linked hub is DOWN still clears the roster to
//      local-only — the teardown does not depend on the old hub being reachable,
//      which is exactly the "previous hub might be down" case.
//
// teardownHubStream() is local: it destroys the outbound stream, clears
// remoteRoster, bumps spokeGen (so a late event from the old hub can't repopulate
// state), and clears the reconnect/heartbeat timers. This test exercises all of
// that through the same `/link/reload` path the CLI's join/unlink/share use.

import { TestBridge, assert, reportAndExit, sleep } from "./lib.mjs";

const TOKEN = "fed-switch-tok"; // single trusted-group token shared by both hubs
const A_PORT = 7440, A_FED = 7441;
const B_PORT = 7442, B_FED = 7443;
const S_PORT = 7444, S_FED = 7445;

const hubA = new TestBridge(A_PORT, { token: TOKEN, role: "hub", node: "huba" }, A_FED);
const hubB = new TestBridge(B_PORT, { token: TOKEN, role: "hub", node: "hubb" }, B_FED);
const spoke = new TestBridge(S_PORT, { token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${A_FED}` }, S_FED);

const names = (r) => (r.sessions || []).map((s) => s.name);

await hubA.start();
await hubB.start();
await spoke.start();
await sleep(1500);

try {
  await hubA.call("register", { name: "alice", description: "on hubA" });
  await hubB.call("register", { name: "carol", description: "on hubB" });
  await spoke.call("register", { name: "bob", description: "on spoke" });

  // ── Link spoke → hubA, confirm it sees hubA's session ────────────────────
  await spoke.reloadFed({ token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${A_FED}` });
  let sawAlice = false;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (names(await spoke.call("list_sessions")).includes("alice")) { sawAlice = true; break; }
  }
  assert("linked to hubA → spoke sees alice@huba", sawAlice, JSON.stringify(await spoke.call("list_sessions")));

  // ── SWITCH spoke → hubB (same token, hot reload) ─────────────────────────
  // The old hubA link must be torn down: alice disappears, carol appears.
  await spoke.reloadFed({ token: TOKEN, role: "spoke", node: "spoke", hub: `http://localhost:${B_FED}` });
  let cleared = false, sawCarol = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const n = names(await spoke.call("list_sessions"));
    cleared = !n.includes("alice");
    sawCarol = n.includes("carol");
    if (cleared && sawCarol) break;
  }
  assert("after switch → stale hubA roster cleared (no alice ghost)", cleared, JSON.stringify(await spoke.call("list_sessions")));
  assert("after switch → new hubB link live (sees carol@hubb)", sawCarol, JSON.stringify(await spoke.call("list_sessions")));

  // ── Old hub goes DOWN, then we unlink ────────────────────────────────────
  // Kill hubB entirely, then unlink the spoke. The local teardown must still
  // clear carol and drop to standalone, even though the hub is unreachable.
  await hubB.stop();
  await sleep(800);
  await spoke.reloadFed({ token: TOKEN, role: "standalone", node: "spoke" }); // == `claude-bridge unlink`
  await sleep(1000);

  const ping = await spoke.healthPing();
  assert("unlink while hub down → role standalone", ping.body.role === "standalone", JSON.stringify(ping.body));

  const finalNames = names(await spoke.call("list_sessions"));
  assert("unlink while hub down → roster cleared to local-only (no carol ghost)", !finalNames.includes("carol"), JSON.stringify(finalNames));
  assert("unlink while hub down → local session preserved (bob still listed)", finalNames.includes("bob"), JSON.stringify(finalNames));
} finally {
  await spoke.stop();
  await hubA.stop();
  try { await hubB.stop(); } catch {}
}

reportAndExit();
