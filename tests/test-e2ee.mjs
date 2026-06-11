// E2EE rooms (3b): random room key, sealed wire traffic, password-wrapped key
// distribution, hub-blind relay for spoke↔spoke, wrong-key degradation.
// Hub 7450 (fed 7451) + spokeA 7452 + spokeB 7454. Zero-dep crypto (node:crypto).
import crypto from "node:crypto";
import { TestBridge, sleep, assert, reportAndExit } from "./lib.mjs";

const TOKEN = "e2ee-test-token";
const PW = "e2ee-password-123";
const hub = new TestBridge(7450, { token: TOKEN, role: "hub", node: "hub" });
let spokeA = null, spokeB = null;
const ok = (r) => r && r.status >= 200 && r.status < 300;

try {
  await hub.start();

  // ── 1. create --e2ee returns the room key; store records e2ee
  let r = await hub.raw("POST", "/room/create", { token: TOKEN, json: { name: "vault", password: PW, e2ee: true } });
  const roomKey = r.body && r.body.room_key;
  assert("create --e2ee: returns a 64-hex room key", ok(r) && /^[a-f0-9]{64}$/.test(roomKey || ""), JSON.stringify(r.body));
  assert("create --e2ee: room flagged e2ee", r.body.room && r.body.room.e2ee === true, JSON.stringify(r.body.room));

  // ── 2. password join returns a WRAPPED key the joiner can unwrap locally —
  //       and the wrap is NOT derivable from what the hub stores (gate hash).
  r = await hub.raw("POST", "/link/join", { json: { node: "spokea", password: PW } });
  const tokA = r.body.member_token;
  const wrapped = r.body.wrapped_key;
  assert("password join: includes wrapped_key", ok(r) && wrapped && wrapped.salt && wrapped.ct, JSON.stringify(r.body));
  const wk = crypto.scryptSync(PW, Buffer.from(wrapped.salt, "hex"), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const di = crypto.createDecipheriv("chacha20-poly1305", wk, Buffer.from(wrapped.n, "hex"), { authTagLength: 16 });
  const buf = Buffer.from(wrapped.ct, "hex");
  di.setAuthTag(buf.subarray(buf.length - 16));
  const unwrapped = Buffer.concat([di.update(buf.subarray(0, buf.length - 16)), di.final()]).toString("utf8");
  assert("password join: unwrapped key matches the room key", unwrapped === roomKey, `${unwrapped.slice(0, 8)} vs ${roomKey.slice(0, 8)}`);

  // ── 3. invite join: no wrapped key in the response (key rides the link fragment)
  r = await hub.raw("POST", "/room/invite", { token: TOKEN, json: {} });
  r = await hub.raw("POST", "/link/join", { json: { node: "spokeb", invite_code: r.body.invite_code } });
  const tokB = r.body.member_token;
  assert("invite join: e2ee flagged, no wrapped_key (link carries it)", r.body.room.e2ee === true && !r.body.wrapped_key, JSON.stringify(r.body));

  // ── 4. spoke↔spoke round-trip, sealed end to end — the HUB relay path never
  //       stores these messages, and the wire payloads carry `enc` only.
  spokeA = new TestBridge(7452, { token: tokA, role: "spoke", hub: `http://localhost:${hub.fedPort}`, node: "spokea", roomKey });
  spokeB = new TestBridge(7454, { token: tokB, role: "spoke", hub: `http://localhost:${hub.fedPort}`, node: "spokeb", roomKey });
  await spokeA.start();
  await spokeB.start();
  await sleep(1500);
  await spokeA.call("register", { name: "alice", description: "spoke A session" });
  await spokeB.call("register", { name: "bob", description: "spoke B session" });
  await sleep(1500);
  const askP = spokeA.call("ask", { to: "bob", question: "secret handshake?" });
  await sleep(1800);
  let inbox = await spokeB.call("check_inbox", {});
  const q = (inbox.questions || []).find((x) => x.question === "secret handshake?");
  assert("e2ee: question arrives DECRYPTED at the destination", !!q, JSON.stringify(inbox.questions));
  if (q) await spokeB.call("reply", { message_id: q.id, answer: "wink wink" });
  r = await askP;
  assert("e2ee: sealed answer returns and decrypts at the asker", r && r.answer === "wink wink", JSON.stringify(r));
  // Hub blindness: the relayed exchange must not exist in the hub's store at all
  r = await hub.health(TOKEN);
  const hubMsgs = (r.pending ?? 0) + (r.answered ?? 0);
  assert("e2ee: hub stored NOTHING for the spoke↔spoke exchange", hubMsgs === 0, `pending+answered=${hubMsgs}`);

  // ── 5. a member with the WRONG key gets opaque ciphertext, not plaintext
  await spokeB.stop();
  spokeB = new TestBridge(7454, { token: tokB, role: "spoke", hub: `http://localhost:${hub.fedPort}`, node: "spokeb", roomKey: "ab".repeat(32) });
  await spokeB.start();
  await sleep(1500);
  await spokeB.call("register", { name: "bob", description: "wrong-key bob" });
  await sleep(1500);
  const askP2 = spokeA.call("ask", { to: "bob", question: "can you read me now?" });
  await sleep(2500);
  inbox = await spokeB.call("check_inbox", {});
  const leaked = (inbox.questions || []).some((x) => (x.question || "").includes("can you read me"));
  const opaque = (inbox.questions || []).some((x) => x.question === "[encrypted]");
  assert("wrong key: plaintext NEVER appears", !leaked, JSON.stringify(inbox.questions));
  assert("wrong key: message surfaces as [encrypted]", opaque, JSON.stringify(inbox.questions));
  askP2.catch(() => {});

  // ── 6. non-e2ee rooms unaffected: delete vault, create plain room, plaintext flows
  await hub.raw("POST", "/room/delete", { token: TOKEN, json: { confirm: "vault" } });
  r = await hub.raw("POST", "/room/create", { token: TOKEN, json: { name: "plain", password: PW } });
  assert("plain room: no room_key returned", ok(r) && !r.body.room_key && r.body.room.e2ee === false, JSON.stringify(r.body));
} catch (e) {
  assert("unexpected error", false, e.stack || String(e));
} finally {
  if (spokeA) await spokeA.stop().catch(() => {});
  if (spokeB) await spokeB.stop().catch(() => {});
  await hub.stop().catch(() => {});
}
reportAndExit();
