// Rooms (phase 3a): per-member tokens, invites, password gate, kick, persistence.
// Hub on 7430 (fed 7431), spoke on 7432. All state isolated via lib.mjs temp files.
import { TestBridge, sleep, assert, reportAndExit } from "./lib.mjs";

// Short join-rate window so the brute-force case can exhaust the bucket AND the
// later cases can wait it out (production: 10 per 60s).
process.env.CC_BRIDGE_JOIN_WINDOW_MS = "3000";

const HUB_TOKEN = "legacy-shared-token-7430";
const hub = new TestBridge(7430, { token: HUB_TOKEN, role: "hub", node: "hub" });
let spoke = null;

const ok = (r) => r && r.status >= 200 && r.status < 300;

try {
  await hub.start();

  // ── 1. Legacy mode: before any room exists, the shared token works as today
  let r = await hub.raw("POST", "/link/register", { token: HUB_TOKEN, node: "legacyspoke", json: { node: "legacyspoke", sessions: [] } });
  assert("legacy: shared token accepted before first room", ok(r), JSON.stringify(r));
  r = await hub.raw("POST", "/link/register", { token: "wrong", node: "x", json: { node: "x", sessions: [] } });
  assert("legacy: wrong token rejected", r.status === 401, `status=${r.status}`);

  // ── 2. room create (loopback admin on MAIN listener, token-gated)
  r = await hub.raw("POST", "/room/create", { token: HUB_TOKEN, json: { name: "team", password: "hunter2hunter2" } });
  assert("create: returns ok + room id", ok(r) && r.body.room && /^r_[a-f0-9]{8}$/.test(r.body.room.id), JSON.stringify(r.body));
  assert("create: owner recorded", r.body.room.owner === "hub", JSON.stringify(r.body.room));
  r = await hub.raw("POST", "/room/create", { token: HUB_TOKEN, json: { name: "second" } });
  assert("create: second room rejected (one active room in 3a)", r.status === 409, `status=${r.status}`);

  // ── 3. After first room: legacy shared token is DEAD on the fed surface
  r = await hub.raw("POST", "/link/register", { token: HUB_TOKEN, node: "legacyspoke", json: { node: "legacyspoke", sessions: [] } });
  assert("room mode: legacy shared token now 401 on /link/*", r.status === 401, `status=${r.status}`);
  r = await hub.raw("GET", "/health/ping", { onFed: true });
  assert("room mode: /health/ping stays ungated", ok(r), `status=${r.status}`);

  // ── 4. invite → /link/join exchange → member token
  r = await hub.raw("POST", "/room/invite", { token: HUB_TOKEN, json: {} });
  const invite = r.body.invite_code;
  assert("invite: code minted", ok(r) && typeof invite === "string" && invite.length >= 16, JSON.stringify(r.body));
  r = await hub.raw("POST", "/link/join", { json: { node: "spokea", invite_code: invite } });
  const memTok = r.body && r.body.member_token;
  assert("join: invite exchanged for member token", ok(r) && typeof memTok === "string" && memTok.length === 64, JSON.stringify(r.body));
  assert("join: response names the room", r.body.room && r.body.room.name === "team", JSON.stringify(r.body.room));

  // ── 5. member token works on the fed surface; full spoke link + message round-trip
  r = await hub.raw("POST", "/link/register", { token: memTok, node: "spokea", json: { node: "spokea", sessions: [] } });
  assert("member token accepted on /link/*", ok(r), `status=${r.status}`);
  spoke = new TestBridge(7432, { token: memTok, role: "spoke", hub: `http://localhost:${hub.fedPort}`, node: "spokea" });
  await spoke.start();
  await sleep(1200);
  await hub.call("register", { name: "hubber", description: "hub session" });
  await spoke.call("register", { name: "spoker", description: "spoke session" });
  await sleep(1200);
  const askP = spoke.call("ask", { to: "hubber", question: "room ping?" });
  await sleep(1500);
  const inbox = await hub.call("check_inbox", {});
  if (inbox.questions && inbox.questions.length) {
    await hub.call("reply", { message_id: inbox.questions[0].id, answer: "room pong" });
  }
  const answer = await askP;
  assert("cross-room ask/reply round-trip works on member token", answer && answer.answer === "room pong", JSON.stringify(answer));

  // ── 6. one-time invites + expiry
  r = await hub.raw("POST", "/room/invite", { token: HUB_TOKEN, json: { one_time: true } });
  const once = r.body.invite_code;
  r = await hub.raw("POST", "/link/join", { json: { node: "spokeb", invite_code: once } });
  assert("one-time invite: first use ok", ok(r), `status=${r.status}`);
  r = await hub.raw("POST", "/link/join", { json: { node: "spokec", invite_code: once } });
  assert("one-time invite: second use rejected", r.status === 401, `status=${r.status}`);
  r = await hub.raw("POST", "/room/invite", { token: HUB_TOKEN, json: { expires_in_seconds: -1 } });
  r = await hub.raw("POST", "/link/join", { json: { node: "spoked", invite_code: r.body.invite_code } });
  assert("expired invite rejected", r.status === 401, `status=${r.status}`);

  // ── 7. password join + wrong password
  r = await hub.raw("POST", "/link/join", { json: { node: "spokepw", password: "hunter2hunter2" } });
  assert("password join: correct password issues token", ok(r) && r.body.member_token, JSON.stringify(r.body));
  r = await hub.raw("POST", "/link/join", { json: { node: "spokepw2", password: "wrong-password" } });
  assert("password join: wrong password 401", r.status === 401, `status=${r.status}`);

  // ── 8. token rotation: valid re-join for an existing node invalidates the old token
  r = await hub.raw("POST", "/room/invite", { token: HUB_TOKEN, json: {} });
  r = await hub.raw("POST", "/link/join", { json: { node: "spokea", invite_code: r.body.invite_code } });
  const memTok2 = r.body.member_token;
  assert("rotation: re-join issues a new token", ok(r) && memTok2 && memTok2 !== memTok, "");
  r = await hub.raw("POST", "/link/register", { token: memTok, node: "spokea", json: { node: "spokea", sessions: [] } });
  assert("rotation: OLD token now rejected", r.status === 401, `status=${r.status}`);
  r = await hub.raw("POST", "/link/register", { token: memTok2, node: "spokea", json: { node: "spokea", sessions: [] } });
  assert("rotation: NEW token accepted", ok(r), `status=${r.status}`);

  // ── 9. members listing
  r = await hub.raw("GET", "/room/info", { token: HUB_TOKEN });
  const nodes = (r.body.room && r.body.room.members || []).map((m) => m.node).sort();
  assert("info: members listed", ok(r) && nodes.includes("spokea") && nodes.includes("spokepw"), JSON.stringify(nodes));

  // ── 10. kick severs + persists across restart
  r = await hub.raw("POST", "/room/kick", { token: HUB_TOKEN, json: { node: "spokea" } });
  assert("kick: ok", ok(r), JSON.stringify(r.body));
  await sleep(500);
  r = await hub.raw("POST", "/link/register", { token: memTok2, node: "spokea", json: { node: "spokea", sessions: [] } });
  assert("kick: token dead immediately", r.status === 401, `status=${r.status}`);
  r = await hub.raw("POST", "/room/kick", { token: HUB_TOKEN, json: { node: "hub" } });
  assert("kick: owner is unkickable", r.status === 400, `status=${r.status}`);
  await hub.stop();
  await hub.start(); // RESTART — revocation must survive
  r = await hub.raw("POST", "/link/register", { token: memTok2, node: "spokea", json: { node: "spokea", sessions: [] } });
  assert("restart: kicked member STAYS kicked (file persisted)", r.status === 401, `status=${r.status}`);
  r = await hub.raw("POST", "/link/join", { json: { node: "spokepw3", password: "hunter2hunter2" } });
  assert("restart: room + password survive restart", ok(r) && r.body.member_token, JSON.stringify(r.body));

  // ── 11. join rate limit (strict global bucket)
  let limited = false;
  for (let i = 0; i < 15; i++) {
    r = await hub.raw("POST", "/link/join", { json: { node: `brute${i}`, password: "bad" } });
    if (r.status === 429) { limited = true; break; }
  }
  assert("join: brute-force rate limit kicks in (429)", limited, "15 bad joins, no 429");
  await sleep(3500); // let the join bucket reset before the remaining cases

  // ── 12. room delete kills everything
  r = await hub.raw("POST", "/room/delete", { token: HUB_TOKEN, json: { confirm: "team" } });
  assert("delete: ok", ok(r), JSON.stringify(r.body));
  r = await hub.raw("POST", "/link/join", { json: { node: "late", password: "hunter2hunter2" } });
  assert("delete: joining a deleted room fails", r.status === 404 || r.status === 503, `status=${r.status}`);
  r = await hub.raw("POST", "/link/register", { token: HUB_TOKEN, node: "legacyspoke", json: { node: "legacyspoke", sessions: [] } });
  assert("delete: legacy shared-token mode resumes after delete", ok(r), `status=${r.status}`);

  // ── 13. TTL room expires
  r = await hub.raw("POST", "/room/create", { token: HUB_TOKEN, json: { name: "flash", ttl_seconds: 1 } });
  assert("ttl: ephemeral room created", ok(r), JSON.stringify(r.body));
  await sleep(1500);
  r = await hub.raw("POST", "/link/join", { json: { node: "tardy", password: "x" } });
  assert("ttl: expired room is gone (join 404/503)", r.status === 404 || r.status === 503, `status=${r.status}`);
} catch (e) {
  assert("unexpected error", false, e.stack || String(e));
} finally {
  if (spoke) await spoke.stop().catch(() => {});
  await hub.stop().catch(() => {});
}
reportAndExit();
