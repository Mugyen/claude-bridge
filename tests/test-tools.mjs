// MCP tool behaviour: register, broadcast input validation, ask/reply round-trip,
// check_inbox, get_thread answered flag. Adds smoke coverage for everything in
// the TOOLS array. Add new tool tests here when you ship a new tool.

import { TestBridge, assert, reportAndExit } from "./lib.mjs";

const bridge = new TestBridge(7402);
await bridge.start();

try {
  // ── register ────────────────────────────────────────────────────────────
  const r = await bridge.call("register", { name: "alice", description: "test session" });
  assert("register returns ok", r.ok === true, JSON.stringify(r));

  // register input validation (must not pollute nameToSSE / roster / .name file)
  const rbad1 = await bridge.call("register", { name: 42 });
  assert("register rejects non-string name", typeof rbad1.error === "string", JSON.stringify(rbad1));
  const rbad2 = await bridge.call("register", { name: "   " });
  assert("register rejects blank name", typeof rbad2.error === "string", JSON.stringify(rbad2));
  // a non-string description is coerced to "" (not stored/broadcast as junk)
  const rdesc = await bridge.call("register", { name: "alice", description: { junk: true } });
  assert("register coerces non-string description", rdesc.ok === true, JSON.stringify(rdesc));

  // ── list_sessions ───────────────────────────────────────────────────────
  const ls = await bridge.call("list_sessions");
  assert("list_sessions includes us", ls.sessions?.some((s) => s.name === "alice"), JSON.stringify(ls));

  // ── broadcast input validation (Bug 1 regression test) ──────────────────
  const bad1 = await bridge.call("broadcast", { message: "wrong arg name" });
  assert("broadcast rejects {message}", typeof bad1.error === "string", JSON.stringify(bad1));

  const bad2 = await bridge.call("broadcast", {});
  assert("broadcast rejects empty args", typeof bad2.error === "string", JSON.stringify(bad2));

  const bad3 = await bridge.call("broadcast", { content: 42 });
  assert("broadcast rejects non-string content", typeof bad3.error === "string", JSON.stringify(bad3));

  const good = await bridge.call("broadcast", { content: "hello" });
  assert("broadcast accepts valid content", good.ok === true && good.length === 5, JSON.stringify(good));

  const appended = await bridge.call("broadcast", { content: "world", append: true });
  assert("broadcast append grows scratchpad", appended.ok === true && appended.length > 5, JSON.stringify(appended));

  // ── read_scratchpad ─────────────────────────────────────────────────────
  const sp = await bridge.call("read_scratchpad", { session: "alice" });
  assert("read_scratchpad returns content", typeof sp.content === "string" && sp.content.includes("hello"), JSON.stringify(sp));

  // ── check_inbox (no pending questions) ──────────────────────────────────
  const inbox = await bridge.call("check_inbox");
  assert("check_inbox returns pending_count", inbox.pending_count === 0, JSON.stringify(inbox));

  // ── get_thread (no thread) ──────────────────────────────────────────────
  const thread = await bridge.call("get_thread", { with_session: "bob" });
  assert("get_thread returns empty for unknown peer", Array.isArray(thread.messages) && thread.messages.length === 0, JSON.stringify(thread));

  // ── notify: input validation (no crash on bad input) ────────────────────
  const nbad1 = await bridge.call("notify", { to: "alice" });
  assert("notify rejects missing content", typeof nbad1.error === "string", JSON.stringify(nbad1));
  const nbad2 = await bridge.call("notify", { content: "hi" });
  assert("notify rejects missing to", typeof nbad2.error === "string", JSON.stringify(nbad2));
  const nbad3 = await bridge.call("notify", { to: "alice", content: 42 });
  assert("notify rejects non-string content", typeof nbad3.error === "string", JSON.stringify(nbad3));

  // ── notify: happy path, non-blocking (alice → alice) ────────────────────
  const n1 = await bridge.call("notify", { to: "alice", content: "FYI one" });
  assert("notify returns ok + message_id", n1.ok === true && typeof n1.message_id === "string", JSON.stringify(n1));
  assert("notify reports target online", n1.target_online === true, JSON.stringify(n1));

  // ── /pending delivers the NOTICE exactly once ───────────────────────────
  const p1 = await bridge.pending("alice");
  assert("/pending shows NOTICE banner with id + content",
    p1.includes("NOTICE from") && p1.includes(`id: ${n1.message_id}`) && p1.includes("FYI one"),
    JSON.stringify(p1));
  const p2 = await bridge.pending("alice");
  assert("/pending does not re-deliver the notice", !p2.includes("FYI one"), JSON.stringify(p2));

  // ── notify is NOT a pending question (reply/check_inbox ignore it) ──────
  const ibQ = await bridge.call("check_inbox");
  assert("notice never counts as a pending question", ibQ.pending_count === 0, JSON.stringify(ibQ));

  // ── check_inbox surfaces an undelivered notice once (Desktop path) ──────
  const n2 = await bridge.call("notify", { to: "alice", content: "FYI two" });
  const ib1 = await bridge.call("check_inbox");
  assert("check_inbox lists undelivered notice", (ib1.notices || []).some((x) => x.id === n2.message_id && x.content === "FYI two"), JSON.stringify(ib1));
  const ib2 = await bridge.call("check_inbox");
  assert("check_inbox does not re-deliver notice", !(ib2.notices || []).some((x) => x.id === n2.message_id), JSON.stringify(ib2));

  // ── get_thread includes the notice, labelled, with no answer ────────────
  const th = await bridge.call("get_thread", { with_session: "alice" });
  assert("get_thread includes a notice entry", (th.messages || []).some((m) => m.kind === "notice" && typeof m.content === "string"), JSON.stringify(th));

  // ── notify to an offline name queues instead of erroring ────────────────
  const noff = await bridge.call("notify", { to: "ghost-session", content: "later" });
  assert("notify to offline target queues (ok, target_online=false)", noff.ok === true && noff.target_online === false, JSON.stringify(noff));

  // ── peek mode must NOT consume (the idle-listener bug) ──────────────────
  // The monitor peeks to wake the agent; the notice must survive so the woken
  // agent can still read it via check_inbox. Only a non-peek read consumes.
  const n3 = await bridge.call("notify", { to: "alice", content: "FYI three" });
  const peek1 = await bridge.pending("alice", { peek: true });
  assert("peek shows the notice", peek1.includes("FYI three") && peek1.includes(`id: ${n3.message_id}`), JSON.stringify(peek1));
  const peek2 = await bridge.pending("alice", { peek: true });
  assert("peek does NOT consume (still there on second peek)", peek2.includes("FYI three"), JSON.stringify(peek2));
  const ibPeek = await bridge.call("check_inbox");
  assert("woken agent can still read the peeked notice via check_inbox", (ibPeek.notices || []).some((x) => x.id === n3.message_id), JSON.stringify(ibPeek));
  const peek3 = await bridge.pending("alice", { peek: true });
  assert("after check_inbox consumes it, peek is empty", !peek3.includes("FYI three"), JSON.stringify(peek3));

  // ── /pending resolves by STABLE claude_session_id (idle-listener path) ──────
  // Done LAST: registering on the shared TestBridge connection re-points its
  // identity, so it must not precede the alice-based assertions above.
  await bridge.call("register", { name: "cidder", description: "cid test", claude_session_id: "cid-xyz-123" });
  const cn = await bridge.call("notify", { to: "cidder", content: "via cid" });
  const pcid = await bridge.pending("cidder", { peek: true, cid: "cid-xyz-123" });
  assert("/pending?claude_session_id= resolves to the session's inbox", pcid.includes("via cid") && pcid.includes(`id: ${cn.message_id}`), JSON.stringify(pcid));
  const pbad = await bridge.pending("cidder", { cid: "cid-does-not-exist" });
  assert("/pending with an unknown claude_session_id returns empty (not 400)", pbad === "", JSON.stringify(pbad));

  // ── server still alive (Bug 2 regression test) ──────────────────────────
  const h = await bridge.health();
  assert("server still alive after bad inputs", h.status === "ok", JSON.stringify(h));
  assert("health reports a notices count", typeof h.notices === "number" && h.notices >= 1, JSON.stringify(h));
} finally {
  await bridge.stop();
  reportAndExit();
}
