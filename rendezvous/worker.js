// claude-bridge rendezvous — a phone book, not a relay.
//
// Maps short speakable codes ("mugyen-team", "blue-falcon-42") to full join
// links so people can say `claude-bridge join mugyen-team` instead of pasting a
// long URL. It NEVER relays bridge traffic and stores nothing but {code → link}.
//
// Policy (deliberate, owner-approved):
//   • OPEN namespace: anyone can publish any code, first-come-first-served.
//   • Per-code owner token: while a code is alive, only its publisher can
//     renew/update/release it. When the TTL lapses unrenewed, the code frees —
//     "the hub died, the name is up for grabs again."
//   • TTL'd: default 7 days, clamped 5 minutes…30 days. KV expiry is the GC.
//   • Lookups are open (that's the point) and lightly rate-limited.
//
// Deploy: wrangler deploy  (needs a KV namespace bound as RDV — see README.md)

const CODE_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const LINK_RE = /^(https?:\/\/|p2p:)[^\s]{1,2000}$/;
const DEFAULT_TTL = 7 * 24 * 3600;
const MIN_TTL = 300;
const MAX_TTL = 30 * 24 * 3600;
const LOOKUPS_PER_MIN = 30; // per IP, best-effort

const WORDS1 = ["amber", "blue", "coral", "delta", "ember", "frost", "green", "indigo", "jade", "lunar", "noble", "polar", "quiet", "rapid", "solar", "tidal", "umber", "vivid", "windy", "zesty"];
const WORDS2 = ["falcon", "badger", "comet", "dolphin", "eagle", "fox", "gecko", "heron", "ibis", "jaguar", "koala", "lynx", "marmot", "narwhal", "otter", "puffin", "quokka", "raven", "swift", "tapir"];

function randomCode() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(WORDS1)}-${pick(WORDS2)}-${Math.floor(Math.random() * 90) + 10}`;
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (code, obj) =>
  new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ip = req.headers.get("CF-Connecting-IP") || "local";

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Content-Type" } });

    if (url.pathname === "/" || url.pathname === "") {
      return json(200, { service: "claude-bridge rendezvous", usage: "claude-bridge join <code>", docs: "https://github.com/Mugyen/claude-bridge" });
    }

    const m = url.pathname.match(/^\/v1\/rooms(?:\/([a-z0-9-]+))?$/);
    if (!m) return json(404, { error: "not found" });
    const pathCode = m[1] || null;

    // ── GET /v1/rooms/<code> — resolve (open, rate-limited) ──────────────────
    if (req.method === "GET" && pathCode) {
      const rlKey = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
      const n = parseInt((await env.RDV.get(rlKey)) || "0") + 1;
      if (n > LOOKUPS_PER_MIN) return json(429, { error: "slow down" });
      await env.RDV.put(rlKey, String(n), { expirationTtl: 120 });

      const rec = await env.RDV.get(`c:${pathCode}`, "json");
      if (!rec) return json(404, { error: `no live code "${pathCode}" — it may have expired (codes free up when their hub stops renewing)` });
      return json(200, { code: pathCode, link: rec.link, expires_at: rec.expires_at });
    }

    // ── POST /v1/rooms — publish / renew / update ────────────────────────────
    if (req.method === "POST" && !pathCode) {
      let body;
      try { body = await req.json(); } catch { return json(400, { error: "bad json" }); }
      const code = body.code ? String(body.code).toLowerCase() : randomCode();
      if (!CODE_RE.test(code)) return json(400, { error: "code must be 3-40 chars of a-z, 0-9, hyphen" });
      if (typeof body.link !== "string" || !LINK_RE.test(body.link)) return json(400, { error: "link must be http(s)://… or p2p:… (≤2KB)" });
      const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, Number(body.ttl_seconds) || DEFAULT_TTL));

      const existing = await env.RDV.get(`c:${code}`, "json");
      let ownerToken = null;
      if (existing) {
        // Alive code: only its owner may renew/update.
        const presented = typeof body.owner_token === "string" ? await sha256(body.owner_token) : null;
        if (!presented || presented !== existing.owner_hash) {
          return json(409, { error: `"${code}" is taken until it expires`, expires_at: existing.expires_at, hint: `try "${code}-${Math.floor(Math.random() * 90) + 10}"` });
        }
        ownerToken = body.owner_token; // renewing owner keeps their token
      } else {
        ownerToken = crypto.randomUUID().replace(/-/g, "");
      }
      const expires_at = Date.now() + ttl * 1000;
      await env.RDV.put(`c:${code}`, JSON.stringify({ link: body.link, owner_hash: await sha256(ownerToken), expires_at }), { expirationTtl: ttl });
      return json(existing ? 200 : 201, { ok: true, code, expires_at, ...(existing ? {} : { owner_token: ownerToken }) });
    }

    // ── DELETE /v1/rooms/<code> — release early (owner only) ────────────────
    if (req.method === "DELETE" && pathCode) {
      let body = {};
      try { body = await req.json(); } catch {}
      const existing = await env.RDV.get(`c:${pathCode}`, "json");
      if (!existing) return json(404, { error: "no such code" });
      const presented = typeof body.owner_token === "string" ? await sha256(body.owner_token) : null;
      if (!presented || presented !== existing.owner_hash) return json(403, { error: "owner token required to release a live code" });
      await env.RDV.delete(`c:${pathCode}`);
      return json(200, { ok: true, released: pathCode });
    }

    return json(405, { error: "method not allowed" });
  },
};
