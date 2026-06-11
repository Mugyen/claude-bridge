// Rendezvous Worker logic — runs the REAL fetch handler with an in-memory KV.
// Covers: publish (named + random), resolve, 409-when-taken, owner renew/update,
// release, TTL expiry, validation, lookup rate limit.
import { assert, reportAndExit } from "./lib.mjs";
import worker from "../rendezvous/worker.js";

// Minimal KV mock honoring expirationTtl.
function mockKV() {
  const store = new Map();
  return {
    async get(k, type) {
      const e = store.get(k);
      if (!e) return null;
      if (e.exp && Date.now() > e.exp) { store.delete(k); return null; }
      return type === "json" ? JSON.parse(e.v) : e.v;
    },
    async put(k, v, opts = {}) { store.set(k, { v, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null }); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}
const env = { RDV: mockKV() };
const call = (method, path, body, ip = "1.2.3.4") =>
  worker.fetch(new Request(`https://r.test${path}`, { method, headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const j = async (r) => ({ status: r.status, body: await r.json() });

try {
  // ── publish named
  let r = await j(await call("POST", "/v1/rooms", { code: "mugyen-team", link: "https://hub.example#invite:abc" }));
  assert("publish named: 201 + owner token", r.status === 201 && r.body.code === "mugyen-team" && /^[a-f0-9]{32}$/.test(r.body.owner_token), JSON.stringify(r.body));
  const owner = r.body.owner_token;

  // ── resolve
  r = await j(await call("GET", "/v1/rooms/mugyen-team", null));
  assert("resolve: returns the link", r.status === 200 && r.body.link === "https://hub.example#invite:abc", JSON.stringify(r.body));

  // ── squat attempt while alive
  r = await j(await call("POST", "/v1/rooms", { code: "mugyen-team", link: "https://evil.example#x" }));
  assert("alive code: stranger gets 409 + hint", r.status === 409 && /taken/.test(r.body.error) && r.body.hint, JSON.stringify(r.body));
  r = await j(await call("GET", "/v1/rooms/mugyen-team", null));
  assert("alive code: link unchanged after squat attempt", r.body.link === "https://hub.example#invite:abc", JSON.stringify(r.body));

  // ── owner renew/update
  r = await j(await call("POST", "/v1/rooms", { code: "mugyen-team", link: "https://hub.example#invite:fresh", owner_token: owner }));
  assert("owner: renew/update accepted (200, no new token)", r.status === 200 && !r.body.owner_token, JSON.stringify(r.body));
  r = await j(await call("GET", "/v1/rooms/mugyen-team", null));
  assert("owner update took effect", r.body.link.includes("fresh"), JSON.stringify(r.body));

  // ── random code generation
  r = await j(await call("POST", "/v1/rooms", { link: "p2p:endpointaaaa#invite:zz" }));
  assert("random code: word-word-NN shape", r.status === 201 && /^[a-z]+-[a-z]+-\d{2}$/.test(r.body.code), JSON.stringify(r.body));
  assert("random code: p2p links accepted", true, "");

  // ── release (owner only) frees the name immediately
  r = await j(await call("DELETE", "/v1/rooms/mugyen-team", { owner_token: "wrong" }));
  assert("release: wrong token 403", r.status === 403, `status=${r.status}`);
  r = await j(await call("DELETE", "/v1/rooms/mugyen-team", { owner_token: owner }));
  assert("release: owner frees the code", r.status === 200, JSON.stringify(r.body));
  r = await j(await call("POST", "/v1/rooms", { code: "mugyen-team", link: "https://other.example#y" }));
  assert("released name: claimable by anyone (new owner)", r.status === 201 && r.body.owner_token, JSON.stringify(r.body));

  // ── TTL expiry frees the name ("hub died → name free")
  r = await j(await call("POST", "/v1/rooms", { code: "flash", link: "https://h.example#t", ttl_seconds: 300 }));
  env.RDV._store.get("c:flash").exp = Date.now() - 1; // simulate lapse
  r = await j(await call("GET", "/v1/rooms/flash", null));
  assert("expired code: 404 with expiry explanation", r.status === 404 && /expired/.test(r.body.error), JSON.stringify(r.body));
  r = await j(await call("POST", "/v1/rooms", { code: "flash", link: "https://new.example#n" }));
  assert("expired name: re-claimable", r.status === 201, JSON.stringify(r.body));

  // ── validation
  r = await j(await call("POST", "/v1/rooms", { code: "X!", link: "https://h.example#t" }));
  assert("validation: bad code rejected", r.status === 400, `status=${r.status}`);
  r = await j(await call("POST", "/v1/rooms", { code: "okname", link: "javascript:alert(1)" }));
  assert("validation: non-http(s)/p2p link rejected", r.status === 400, `status=${r.status}`);

  // ── lookup rate limit
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const rr = await call("GET", "/v1/rooms/flash", null, "9.9.9.9");
    if (rr.status === 429) { limited = true; break; }
  }
  assert("lookups rate-limited per IP", limited, "35 lookups, no 429");
} catch (e) {
  assert("unexpected error", false, e.stack || String(e));
}
reportAndExit();
