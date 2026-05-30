// Cross-network federation — CHAOS / resilience suite.
//
// Goes past the happy-path federation test: it crashes spokes and the hub mid-
// flight, restarts them, churns sessions, and routes spoke→hub→spoke, asserting
// the link self-heals and never double-delivers. Topology: one hub + two spokes,
// all on localhost over plain HTTP (the same code the real cloudflared tunnel
// carries — the tunnel is just transport, exercised separately in the live test).
//
// Scenarios:
//   1. 3-way roster merge (onLocalRosterChange across TWO spokes)
//   2. Cross-spoke routing: bob@spokea ⇄ carol@spokeb (hub relays both ways)
//   3. Spoke HARD crash (SIGKILL) → roster prunes promptly, local survives
//   4. Spoke restart → reconnect + lossless flush of a queued notice (exactly once)
//   5. Hub HARD crash + restart → spoke reconnects via backoff, roster re-merges
//   6. In-flight question loss gap (DOCUMENTED): spoke dies after receiving a
//      question, before replying → hub has no pendingRelay entry, asker would
//      time out. This asserts the KNOWN limitation so a future fix is noticed.
//   7. name@node collision: local-name-wins for a bare name; @node targets remote
//   8. Auth stays enforced throughout (fed port gating unaffected by chaos)
//
// Uses an inline minimal MCP-over-SSE Client so we can run several logical
// sessions on one bridge (lesson #2: one SSE per logical client).

import http from "node:http";
import { TestBridge, assert, reportAndExit, sleep } from "./lib.mjs";

const TOKEN = "chaos-token-abc123";
const HUB = 7440, HUB_FED = 7441;
const SA = 7442, SA_FED = 7443;
const SB = 7444, SB_FED = 7445;

// ── minimal MCP-over-SSE client (one logical session) ───────────────────────
class Client {
  constructor(port) { this.port = port; this.sid = null; this.responses = new Map(); this.nextId = 1; this.res = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`SSE handshake timeout @${this.port}`)), 6000);
      const req = http.get(`http://localhost:${this.port}/sse`, (res) => {
        this.res = res; let buf = "";
        res.on("data", (c) => {
          buf += c.toString(); const parts = buf.split("\n\n"); buf = parts.pop();
          for (const p of parts) {
            const m = p.match(/^data: (.+)$/m); if (!m) continue; const d = m[1];
            const sm = d.match(/session=([a-f0-9-]+)/);
            if (sm && !this.sid) { this.sid = sm[1]; clearTimeout(to); resolve(); continue; }
            try { const j = JSON.parse(d); if (j.id != null) this.responses.set(j.id, j); } catch {}
          }
        });
        res.on("error", () => {});
      });
      req.on("error", (e) => { clearTimeout(to); reject(e); });
    });
  }
  async call(tool, args = {}) {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
    await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${this.port}/message?session=${this.sid}`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        () => resolve());
      req.on("error", reject); req.write(body); req.end();
    });
    // `ask` BLOCKS server-side up to 5min until a reply; everything else returns
    // immediately. Use a long cap for ask so a not-yet-answered ask promise does
    // not spuriously reject (an unhandled rejection exits Node 25) before the test
    // drives the reply and awaits it.
    const cap = tool === "ask" ? 1800 : 150;
    for (let i = 0; i < cap; i++) {
      if (this.responses.has(id)) return JSON.parse(this.responses.get(id).result.content[0].text);
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${tool}`);
  }
  close() { try { this.res?.destroy(); } catch {} }
}

async function register(port, name, description = "chaos session") {
  const c = new Client(port);
  await c.connect();
  const r = await c.call("register", { name, description });
  if (r.ok !== true) throw new Error(`register ${name} failed: ${JSON.stringify(r)}`);
  return c;
}

// Poll `fn` until it returns truthy or timeout. Returns the truthy value or null.
async function until(fn, timeoutMs = 15000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(stepMs); }
  return null;
}

function rosterNames(list) { return (list.sessions || []).map((s) => (s.node && s.node !== "local" ? `${s.name}@${s.node}` : s.name)); }

// ── build the topology ──────────────────────────────────────────────────────
const hub = new TestBridge(HUB, { token: TOKEN, role: "hub", node: "hub" }, HUB_FED);
// NOTE: node ids are lowercased by the server's sanitizeNode(), so the roster
// renders them lowercase ("bob@spokea") and @node addressing must use the
// sanitized form. Use lowercase ids here to match (camelCase would never match).
const spokeA = new TestBridge(SA, { token: TOKEN, role: "spoke", node: "spokea", hub: `http://localhost:${HUB_FED}` }, SA_FED);
const spokeB = new TestBridge(SB, { token: TOKEN, role: "spoke", node: "spokeb", hub: `http://localhost:${HUB_FED}` }, SB_FED);

await hub.start();
await spokeA.start();
await spokeB.start();
await sleep(1800); // links open + initial advertise

let alice, bob, carol;

try {
  // ── 1. 3-way roster merge ──────────────────────────────────────────────────
  alice = await register(HUB, "alice", "hub session");
  bob = await register(SA, "bob", "spokeA session");
  carol = await register(SB, "carol", "spokeB session");
  await sleep(1500); // onLocalRosterChange propagation hub↔both spokes

  const hubR = await until(async () => {
    const l = await alice.call("list_sessions"); const n = rosterNames(l);
    return n.includes("bob@spokea") && n.includes("carol@spokeb") ? n : null;
  });
  assert("hub sees bob@spokea and carol@spokeb", !!hubR, JSON.stringify(hubR));

  const aR = await until(async () => {
    const l = await bob.call("list_sessions"); const n = rosterNames(l);
    return n.includes("alice@hub") && n.includes("carol@spokeb") ? n : null;
  });
  assert("spokeA (bob) sees alice@hub and carol@spokeb", !!aR, JSON.stringify(aR));

  const bR = await until(async () => {
    const l = await carol.call("list_sessions"); const n = rosterNames(l);
    return n.includes("alice@hub") && n.includes("bob@spokea") ? n : null;
  });
  assert("spokeB (carol) sees alice@hub and bob@spokea", !!bR, JSON.stringify(bR));

  // ── 2. Cross-spoke routing: bob@spokea asks carol@spokeb ───────────────────
  const askP = bob.call("ask", { to: "carol", question: "spoke-to-spoke: what node are you on?" });
  const sawQ = await until(async () => {
    const p = await spokeB.pending("carol", { peek: true });
    return p.includes("spoke-to-spoke") && /id: [a-z0-9-]+/.test(p);
  }, 20000);
  assert("cross-spoke question reached carol on spokeB (via hub relay)", !!sawQ, "never injected");
  if (sawQ) { const rep = await carol.call("reply", { answer: "I'm carol on spokeB" }); assert("carol replies", rep.ok === true, JSON.stringify(rep)); }
  const askR = await askP;
  assert("bob's cross-spoke ask returns carol's answer (answer relayed home)", askR.answer === "I'm carol on spokeB", JSON.stringify(askR));

  // ── 3. Spoke HARD crash (SIGKILL) → roster prunes promptly, local survives ──
  carol.close();
  await spokeB.stop({ signal: "SIGKILL" });
  const pruned = await until(async () => {
    const n = rosterNames(await alice.call("list_sessions"));
    return !n.includes("carol@spokeb") ? n : null;
  }, 20000);
  assert("hub roster drops carol promptly after spokeB SIGKILL", !!pruned, JSON.stringify(pruned));
  const stillLocal = rosterNames(await alice.call("list_sessions"));
  assert("hub still serves locally after spoke crash", stillLocal.includes("alice"), JSON.stringify(stillLocal));
  const spokeAOk = rosterNames(await bob.call("list_sessions"));
  assert("spokeA unaffected by spokeB crash (still sees alice@hub)", spokeAOk.includes("alice@hub"), JSON.stringify(spokeAOk));

  // ── 4. Queue notices while spokeB is DOWN, then restart → reconnect flush ───
  // 4a (primary, LOSSLESS): a BARE-name notice queues losslessly — resolveTarget's
  // hub-side offline-spoke fallback (lesson #25) finds carol in the dead-but-known
  // spoke entry and markPendingRelay's it; flushPendingForwards re-pushes on the
  // spoke's /link/stream reconnect.
  const nqBare = await alice.call("notify", { to: "carol", content: "bare-queued-marker" });
  assert("bare notify to offline carol is accepted", nqBare.ok === true, JSON.stringify(nqBare));
  // 4b (gap probe): the QUALIFIED carol@spokeb form does NOT hit that fallback —
  // the @node branch of resolveTarget has no offline-spoke scan, so it resolves to
  // none and the notice is mis-queued on the hub, never relayed. Captured as a gap.
  const nqQual = await alice.call("notify", { to: "carol@spokeb", content: "qualified-queued-marker" });
  assert("qualified notify to offline carol@spokeb returns ok (accepted)", nqQual.ok === true, JSON.stringify(nqQual));

  await spokeB.start();
  await sleep(1800);
  carol = await register(SB, "carol", "spokeB session v2");
  // BOTH the bare and the (G3-fixed) qualified notice should flush losslessly.
  // check_inbox consumes notices, so collect across reads until both are seen.
  const seen = new Set();
  await until(async () => {
    const ib = await carol.call("check_inbox");
    for (const n of (ib.notices || [])) {
      if ((n.content || "").includes("bare-queued-marker")) seen.add("bare");
      if ((n.content || "").includes("qualified-queued-marker")) seen.add("qual");
    }
    return seen.has("bare") && seen.has("qual");
  }, 25000);
  assert("LOSSLESS: bare-name queued notice delivers after spokeB reconnects", seen.has("bare"), [...seen].join(","));
  assert("G3 FIXED: qualified name@node queued notice ALSO delivers losslessly", seen.has("qual"), [...seen].join(","));
  // exactly once: neither marker re-appears on a subsequent read
  const again = await carol.call("check_inbox");
  const dupCount = (again.notices || []).filter((n) => /bare-queued-marker|qualified-queued-marker/.test(n.content || "")).length;
  assert("queued notices delivered exactly once (no duplicate after reconnect)", dupCount === 0, JSON.stringify(again));

  // ── 5. Hub HARD crash + restart → spoke reconnects via backoff, re-merges ───
  await hub.stop({ signal: "SIGKILL" });
  alice.close();
  await sleep(800);
  await hub.start();           // fresh hub, empty state, fed listener rebinds
  alice = await register(HUB, "alice", "hub session v2");
  await sleep(1000);
  // spokeA was never killed; its connectToHub backoff should re-link to the new hub
  const reMerged = await until(async () => {
    const n = rosterNames(await alice.call("list_sessions"));
    return n.includes("bob@spokea") ? n : null;
  }, 40000);
  assert("hub re-merges bob@spokea after a hub crash+restart (spoke auto-reconnect)", !!reMerged, JSON.stringify(reMerged));
  // and a fresh cross-net notify works post-recovery
  const postNotify = await alice.call("notify", { to: "bob@spokea", content: "post-hub-restart-ping" });
  assert("cross-net notify works after hub recovery", postNotify.ok === true, JSON.stringify(postNotify));
  const bobGot = await until(async () => {
    const ib = await bob.call("check_inbox");
    return (ib.notices || []).some((n) => (n.content || "").includes("post-hub-restart-ping")) ? ib : null;
  }, 15000);
  assert("bob receives the post-recovery notify", !!bobGot, JSON.stringify(bobGot));

  // ── 6. In-flight question loss gap (DOCUMENTED known limitation) ────────────
  // alice asks bob; bob's spoke crashes after receiving but before replying.
  const lostP = alice.call("ask", { to: "bob@spokea", question: "inflight-loss-probe" });
  lostP.catch(() => {}); // intentionally never answered (the answerer crashes) — don't let it reject unhandled
  const reached = await until(async () => {
    const p = await spokeA.pending("bob", { peek: true });
    return p.includes("inflight-loss-probe") ? true : null;
  }, 15000);
  assert("in-flight question reached bob before the crash", !!reached, "never reached");
  bob.close();
  await spokeA.stop({ signal: "SIGKILL" });
  // hub must stay responsive while the ask is outstanding + remote is dead
  const hubResponsive = await alice.call("list_sessions");
  assert("hub stays responsive while a remote ask is outstanding and the spoke is dead", Array.isArray(hubResponsive.sessions), JSON.stringify(hubResponsive));
  // restart spokeA + re-register bob. G4: on reconnect the hub re-pushes the
  // still-unanswered in-flight question to the node now hosting bob (the message
  // scan in flushPendingForwards), so it reappears in bob's inbox and the asker
  // can finally be answered.
  await spokeA.start();
  await sleep(1800);
  bob = await register(SA, "bob", "spokeA session v2");
  const reDelivered = await until(async () => {
    const ib = await bob.call("check_inbox");
    return (ib.questions || []).some((q) => (q.question || "").includes("inflight-loss-probe")) ? ib : null;
  }, 15000);
  assert("G4 FIXED: in-flight question re-delivered to the answerer after its spoke restarts", !!reDelivered, JSON.stringify(reDelivered));
  // and replying now unblocks the original asker (answer routes home across the link)
  const q4 = (reDelivered.questions || []).find((q) => (q.question || "").includes("inflight-loss-probe"));
  await bob.call("reply", { message_id: q4.id, answer: "recovered-after-crash" });
  const lostR = await lostP;
  assert("G4 FIXED: the asker's blocking ask completes after in-flight recovery", lostR.answer === "recovered-after-crash", JSON.stringify(lostR));

  // ── 7. name@node collision: local-name-wins; @node targets the remote ───────
  // register a SECOND "bob" on the hub (bob@hub) alongside bob@spokea.
  const bobLocal = await register(HUB, "bob", "hub-local bob");
  await sleep(1200);
  // alice asks bare "bob" → must hit the LOCAL bob (hub), not the remote one.
  const localAskP = alice.call("ask", { to: "bob", question: "which-bob-are-you" });
  const localBobSaw = await until(async () => {
    const ib = await bobLocal.call("check_inbox");
    return (ib.questions || []).some((q) => (q.question || "").includes("which-bob-are-you")) ? ib : null;
  }, 12000);
  assert("bare 'bob' resolves to the LOCAL hub bob (local-name-wins)", !!localBobSaw, JSON.stringify(localBobSaw));
  // NB: the hub-local "bob" also inherits the orphaned, never-answered inflight
  // question from scenario 6 (same to:"bob" name) — so there are 2 pending here and
  // an auto-target reply would be ambiguous. Reply to the which-bob id explicitly.
  if (localBobSaw) {
    const q = (localBobSaw.questions || []).find((x) => (x.question || "").includes("which-bob-are-you"));
    // reply input validation: a non-string answer must be rejected BEFORE it mutates
    // msg.answer (else it un-pends the question with a non-null junk value).
    const badReply = await bobLocal.call("reply", { message_id: q.id, answer: 42 });
    assert("reply rejects a non-string answer", typeof badReply.error === "string", JSON.stringify(badReply));
    const stillPending = await bobLocal.call("check_inbox");
    assert("rejected reply left the question still pending (not un-pended by junk)",
      (stillPending.questions || []).some((x) => x.id === q.id), JSON.stringify(stillPending));
    await bobLocal.call("reply", { message_id: q.id, answer: "hub-local-bob" });
  }
  const localAskR = await localAskP;
  assert("alice's bare-'bob' ask was answered by the local bob", localAskR.answer === "hub-local-bob", JSON.stringify(localAskR));
  // the remote bob@spokea must NOT have received it
  const remoteBobInbox = await bob.call("check_inbox");
  const remoteGotLocalAsk = (remoteBobInbox.questions || []).some((q) => (q.question || "").includes("which-bob-are-you"));
  assert("remote bob@spokea did NOT receive the bare-'bob' question", remoteGotLocalAsk === false, JSON.stringify(remoteBobInbox));
  // explicit @node still reaches the remote one
  const remoteAskP = alice.call("ask", { to: "bob@spokea", question: "qualified-remote-bob" });
  const remoteBobSaw = await until(async () => {
    const p = await spokeA.pending("bob", { peek: true });
    return p.includes("qualified-remote-bob") ? true : null;
  }, 15000);
  assert("'bob@spokea' explicitly targets the REMOTE bob", !!remoteBobSaw, "remote bob never saw qualified ask");
  if (remoteBobSaw) { await bob.call("reply", { answer: "remote-spokeA-bob" }); }
  const remoteAskR = await remoteAskP;
  assert("qualified ask answered by the remote bob", remoteAskR.answer === "remote-spokeA-bob", JSON.stringify(remoteAskR));
  // G6: a mixed-case @node target resolves (node ids are sanitized/lowercased).
  const g6 = await alice.call("notify", { to: "bob@SpokeA", content: "g6-case-probe" });
  assert("G6 FIXED: mixed-case 'bob@SpokeA' resolves to the remote spoke", g6.target_online === true && g6.to === "bob@spokea", JSON.stringify(g6));
  bobLocal.close();

  // ── 8. Auth still enforced after all the chaos ──────────────────────────────
  const noTok = await hub.raw("POST", "/link/register", { node: "x", json: { node: "x", sessions: [] } });
  assert("fed /link/register still 401s without token after chaos", noTok.status === 401, JSON.stringify(noTok));
  const wrongTok = await hub.raw("POST", "/link/register", { token: "nope", node: "x", json: { node: "x", sessions: [] } });
  assert("fed /link/register still 401s with WRONG token after chaos", wrongTok.status === 401, JSON.stringify(wrongTok));
  const fedLocalRoute = await hub.raw("GET", "/whoami", { onFed: true });
  assert("fed port still 404s a local route (/whoami) after chaos", fedLocalRoute.status === 404, JSON.stringify(fedLocalRoute));
  const mainLink = await hub.raw("POST", "/link/register", { token: TOKEN, node: "x", json: { node: "x", sessions: [] }, onMain: true });
  assert("main port still 404s /link/* after chaos", mainLink.status === 404, JSON.stringify(mainLink));
  const ping = await hub.healthPing();
  assert("hub /health/ping leaks no session names after chaos", ping.httpStatus === 200 && !JSON.stringify(ping.body).includes("alice"), JSON.stringify(ping.body));
} catch (e) {
  console.log(`\n✗✗ CHAOS THREW (uncaught in a scenario): ${e.message}\n${e.stack}`);
  assert("no uncaught exception in chaos scenarios", false, e.message);
} finally {
  for (const c of [alice, bob, carol]) { try { c?.close(); } catch {} }
  try { await spokeA.stop(); } catch {}
  try { await spokeB.stop(); } catch {}
  try { await hub.stop(); } catch {}
  reportAndExit();
}
