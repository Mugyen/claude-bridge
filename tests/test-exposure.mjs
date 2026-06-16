// Per-session exposure + AIRLOCK zones (phase 3a): hidden sessions are invisible
// to the room, unreachable even by forged forwards, mute toward the room, and
// sealed off from exposed local sessions in BOTH directions. Toggling via the
// loopback /sessions/expose endpoint takes effect immediately.
// Hub on 7440 (fed 7441) with mixed-zone sessions; spoke on 7442.
import http from "node:http";
import { TestBridge, sleep, assert, reportAndExit } from "./lib.mjs";

const TOKEN = "exposure-test-token";
const hub = new TestBridge(7440, { token: TOKEN, role: "hub", node: "hub" });
const spoke = new TestBridge(7442, { token: TOKEN, role: "spoke", hub: "http://localhost:7441", node: "spokea" });

// Minimal extra SSE client so one bridge can host SEVERAL test sessions
// (TestBridge itself is one session). Mirrors lib.mjs's transport handling.
class SseClient {
  constructor(port) { this.port = port; this.sid = null; this.responses = new Map(); this.nextId = 1000 + Math.floor(Math.random() * 1000); }
  connect() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("sse timeout")), 5000);
      http.get(`http://localhost:${this.port}/sse`, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          const parts = buf.split("\n\n"); buf = parts.pop();
          for (const p of parts) {
            const dm = p.match(/^data: (.+)$/m);
            if (!dm) continue;
            const sm = dm[1].match(/session=([a-f0-9-]+)/);
            if (sm && !this.sid) { this.sid = sm[1]; clearTimeout(t); resolve(); continue; }
            try { const j = JSON.parse(dm[1]); if (j.id != null) this.responses.set(j.id, j); } catch {}
          }
        });
      }).on("error", (e) => { clearTimeout(t); reject(e); });
    });
  }
  async call(name, args = {}) {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${this.port}/message?session=${this.sid}`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, () => resolve());
      req.on("error", reject); req.write(body); req.end();
    });
    for (let i = 0; i < 60; i++) {
      if (this.responses.has(id)) return JSON.parse(this.responses.get(id).result.content[0].text);
      await sleep(100);
    }
    throw new Error(`timeout: ${name}`);
  }
}

let cHid = null, cHid2 = null;
try {
  await hub.start();
  await spoke.start();
  await sleep(1200);

  // Sessions: h_pub (exposed by default), h_hid + h_hid2 (register expose:false)
  await hub.call("register", { name: "h_pub", description: "exposed gateway" });
  cHid = new SseClient(7440); await cHid.connect();
  await cHid.call("register", { name: "h_hid", description: "private session", expose: false });
  cHid2 = new SseClient(7440); await cHid2.connect();
  await cHid2.call("register", { name: "h_hid2", description: "private session 2", expose: false });
  await spoke.call("register", { name: "s1", description: "remote member" });
  await sleep(1500);

  // ── 1. Roster: the room sees only exposed sessions
  let ls = await spoke.call("list_sessions", {});
  let names = (ls.sessions || []).map((x) => x.name);
  assert("roster: remote sees exposed session", names.includes("h_pub"), JSON.stringify(names));
  assert("roster: remote does NOT see hidden sessions", !names.includes("h_hid") && !names.includes("h_hid2"), JSON.stringify(names));

  // ── 2. Remote can't even resolve a hidden name
  let r = await spoke.call("ask", { to: "h_hid", question: "you there?" });
  assert("remote→hidden: unresolvable (not connected)", /not connected/i.test(r.error || ""), JSON.stringify(r));

  // ── 3. Forged forward addressed straight to the hidden name → dropped at injectRemote
  let raw = await hub.raw("POST", "/link/forward", { token: TOKEN, node: "spokea", json: { kind: "question", id: "forge-1", from: "s1", to: "h_hid", question: "psst, secrets?", ts: Date.now(), originNode: "spokea" } });
  assert("forged inbound: accepted at transport", raw.status === 200, `status=${raw.status}`);
  let inbox = await cHid.call("check_inbox", {});
  assert("forged inbound: NEVER delivered to the hidden session", (inbox.questions || []).every((q) => q.id !== "forge-1"), JSON.stringify(inbox.questions));

  // ── 4. Exposed session works normally with the room
  const askP = spoke.call("ask", { to: "h_pub", question: "room ping?" });
  await sleep(1500);
  inbox = await hub.call("check_inbox", {});
  if ((inbox.questions || []).length) await hub.call("reply", { message_id: inbox.questions[0].id, answer: "room pong" });
  r = await askP;
  assert("remote↔exposed: round-trip works", r && r.answer === "room pong", JSON.stringify(r));

  // ── 5. AIRLOCK: exposed ↔ hidden refused in BOTH directions
  r = await hub.call("ask", { to: "h_hid", question: "what did you learn?" });
  assert("airlock: exposed→hidden refused", /AIRLOCK/i.test(r.error || ""), JSON.stringify(r));
  r = await cHid.call("ask", { to: "h_pub", question: "relay this?" });
  assert("airlock: hidden→exposed refused", /AIRLOCK/i.test(r.error || ""), JSON.stringify(r));
  r = await cHid.call("notify", { to: "h_pub", content: "fyi" });
  assert("airlock: notify blocked too", /AIRLOCK/i.test(r.error || ""), JSON.stringify(r));

  // ── 6. The private zone is fully functional WITHIN itself
  const hidAsk = cHid.call("ask", { to: "h_hid2", question: "private ping?" });
  await sleep(1200);
  inbox = await cHid2.call("check_inbox", {});
  if ((inbox.questions || []).length) await cHid2.call("reply", { message_id: inbox.questions[0].id, answer: "private pong" });
  r = await hidAsk;
  assert("private zone: hidden↔hidden round-trip works", r && r.answer === "private pong", JSON.stringify(r));

  // ── 7. Hidden session is mute toward the room
  r = await cHid.call("ask", { to: "s1", question: "hello out there?" });
  assert("hidden→remote: refused (HIDDEN)", /HIDDEN/i.test(r.error || ""), JSON.stringify(r));

  // ── 8. Zone-scoped views
  ls = await cHid.call("list_sessions", {});
  names = (ls.sessions || []).map((x) => x.name).sort();
  assert("hidden caller sees only its zone", names.length === 2 && names.includes("h_hid") && names.includes("h_hid2"), JSON.stringify(names));
  ls = await hub.call("list_sessions", {});
  names = (ls.sessions || []).map((x) => x.name);
  assert("exposed caller sees its zone + the room (no hidden)", names.includes("h_pub") && names.includes("s1") && !names.includes("h_hid"), JSON.stringify(names));

  // ── 9. Scratchpads don't cross the line
  await cHid.call("broadcast", { content: "private-zone-secret" });
  r = await hub.call("read_scratchpad", { session: "h_hid" });
  assert("airlock: cross-zone scratchpad read restricted", /restricted/i.test(r.content || ""), JSON.stringify(r));
  r = await hub.call("read_scratchpad", {});
  const pads = typeof r.scratchpads === "object" ? Object.keys(r.scratchpads) : [];
  assert("airlock: read-all excludes the other zone", !pads.includes("h_hid"), JSON.stringify(pads));
  r = await hub.call("get_thread", { with_session: "h_hid" });
  assert("airlock: cross-zone thread history blocked", /AIRLOCK/i.test(r.error || ""), JSON.stringify(r));

  // ── 10. The toggle: expose → room sees + reaches it; hide → gone again
  raw = await hub.raw("POST", "/sessions/expose", { token: TOKEN, json: { name: "h_hid", expose: true } });
  assert("toggle: expose endpoint ok", raw.status === 200 && raw.body.ok, JSON.stringify(raw.body));
  await sleep(1500);
  ls = await spoke.call("list_sessions", {});
  names = (ls.sessions || []).map((x) => x.name);
  assert("toggle: room now sees the session", names.includes("h_hid"), JSON.stringify(names));
  const askHid = spoke.call("ask", { to: "h_hid", question: "now reachable?" });
  await sleep(1500);
  inbox = await cHid.call("check_inbox", {});
  const q = (inbox.questions || []).find((x) => x.question === "now reachable?");
  if (q) await cHid.call("reply", { message_id: q.id, answer: "yes, exposed now" });
  r = await askHid;
  assert("toggle: exposed session reachable from the room", r && r.answer === "yes, exposed now", JSON.stringify(r));
  raw = await hub.raw("POST", "/sessions/expose", { token: TOKEN, json: { name: "h_hid", expose: false } });
  await sleep(1500);
  ls = await spoke.call("list_sessions", {});
  names = (ls.sessions || []).map((x) => x.name);
  assert("toggle back: hidden again (room roster updated)", !names.includes("h_hid"), JSON.stringify(names));

  // ── 11. /sessions/exposure listing (drives `claude-bridge sessions`)
  raw = await hub.raw("GET", "/sessions/exposure", { token: TOKEN });
  const zones = Object.fromEntries((raw.body.sessions || []).map((x) => [x.name, x.expose]));
  assert("exposure listing: correct zones", zones.h_pub === true && zones.h_hid === false && zones.h_hid2 === false, JSON.stringify(zones));
} catch (e) {
  assert("unexpected error", false, e.stack || String(e));
} finally {
  await spoke.stop().catch(() => {});
  await hub.stop().catch(() => {});
}
reportAndExit();
