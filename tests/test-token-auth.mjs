// Federation token-auth layer (foundational piece #1).
//
// When a token is configured (sharing on), /health and all /link/* require the
// X-Bridge-Token header. /health/ping stays UNGATED so liveness probes survive.
// When standalone (no token), /health stays open — the regression guard that
// install.sh --check and the existing tests keep working.

import { TestBridge, assert, reportAndExit } from "./lib.mjs";

const TOKEN = "test-token-abc123";

// ── Standalone bridge: no gate ─────────────────────────────────────────────
const plain = new TestBridge(7407);
await plain.start();
try {
  const h = await plain.health(); // no header
  assert("standalone /health open without token", h.status === "ok", JSON.stringify(h));

  const ping = await plain.healthPing();
  assert("standalone /health/ping ok, sharing=false", ping.body.status === "ok" && ping.body.sharing === false, JSON.stringify(ping));

  // Standalone is NOT a hub, so the fed listener is never bound — the link
  // surface is simply unreachable (connection refused). This is stronger than a
  // 503: there is no internet-reachable surface at all when not sharing.
  const linkOffFed = await plain.raw("POST", "/link/register", { json: { node: "x" } });
  assert("standalone fed port is not bound (link surface unreachable)", linkOffFed.status === 0, JSON.stringify(linkOffFed));

  // The main (loopback) server must NOT serve /link/* either — it returns 404.
  const linkOffMain = await plain.raw("POST", "/link/register", { json: { node: "x" }, onMain: true });
  assert("standalone main port does not serve /link/* (404)", linkOffMain.status === 404, JSON.stringify(linkOffMain));
} finally {
  await plain.stop();
}

// ── Sharing-on hub: gate active ────────────────────────────────────────────
const hub = new TestBridge(7407, { token: TOKEN, role: "hub", node: "hub" });
await hub.start();
try {
  // /health without token → 401
  const noTok = await hub.raw("GET", "/health");
  assert("gated /health → 401 without token", noTok.status === 401, JSON.stringify(noTok));

  // /health with wrong token → 401
  const wrong = await hub.raw("GET", "/health", { token: "nope" });
  assert("gated /health → 401 with wrong token", wrong.status === 401, JSON.stringify(wrong));

  // /health with correct token → 200
  const right = await hub.raw("GET", "/health", { token: TOKEN });
  assert("gated /health → 200 with correct token", right.status === 200 && right.body.status === "ok", JSON.stringify(right));
  assert("gated /health reports role=hub", right.body.role === "hub", JSON.stringify(right.body));

  // /health/ping stays ungated even when sharing on
  const ping = await hub.healthPing();
  assert("/health/ping ungated when sharing on (no names leaked)", ping.httpStatus === 200 && ping.body.sharing === true && ping.body.role === "hub", JSON.stringify(ping));
  assert("/health/ping carries no session list", ping.body.sessions === undefined, JSON.stringify(ping.body));

  // /link/register without token → 401
  const linkNo = await hub.raw("POST", "/link/register", { json: { node: "spoke1", sessions: [] } });
  assert("/link/register → 401 without token", linkNo.status === 401, JSON.stringify(linkNo));

  // /link/register with token → 200
  const linkOk = await hub.raw("POST", "/link/register", { token: TOKEN, node: "spoke1", json: { node: "spoke1", sessions: [{ name: "remote-a", description: "x" }] } });
  assert("/link/register → 200 with token", linkOk.status === 200 && linkOk.body.ok === true, JSON.stringify(linkOk));
  assert("/link/register replies hub node + roster", linkOk.body.node === "hub" && Array.isArray(linkOk.body.roster), JSON.stringify(linkOk.body));

  // ── SECURITY REGRESSION: two-listener separation closes the whole-port hole ──
  // Register a real local session so we can prove the tunneled (fed) surface
  // leaks no names and the local routes are absent from it.
  await hub.call("register", { name: "secret-session", description: "should never leak through the tunnel" });

  // (a) The MAIN port must NOT serve /link/* — it 404s.
  const mainLink = await hub.raw("POST", "/link/register", { token: TOKEN, json: { node: "x", sessions: [] }, onMain: true });
  assert("main port does NOT serve /link/* (404)", mainLink.status === 404, JSON.stringify(mainLink));

  // (b) The FED port must NOT serve the local routes — each 404s.
  for (const p of ["/sse", "/message", "/pending", "/whoami"]) {
    const r = await hub.raw("GET", `${p}?session=x`, { onFed: true });
    assert(`fed port does NOT serve ${p} (404)`, r.status === 404, `${p}: ${JSON.stringify(r)}`);
  }
  // The full /health is local-only too — not on the tunneled fed surface.
  const fedHealth = await hub.raw("GET", "/health", { token: TOKEN, onFed: true });
  assert("fed port does NOT serve /health (404)", fedHealth.status === 404, JSON.stringify(fedHealth));

  // (c) Any /link/* on the FED port WITHOUT the token → 401; WITH → ok.
  const fedNoTok = await hub.raw("POST", "/link/register", { json: { node: "y", sessions: [] }, onFed: true });
  assert("fed /link/register → 401 without token", fedNoTok.status === 401, JSON.stringify(fedNoTok));
  const fedTok = await hub.raw("POST", "/link/register", { token: TOKEN, json: { node: "y", sessions: [] }, onFed: true });
  assert("fed /link/register → 200 with token", fedTok.status === 200 && fedTok.body.ok === true, JSON.stringify(fedTok));

  // (d) /health/ping on the FED port returns NO session names (content-free).
  const fedPing = await hub.raw("GET", "/health/ping", { onFed: true });
  assert("fed /health/ping ok and ungated", fedPing.status === 200 && fedPing.body.status === "ok", JSON.stringify(fedPing));
  assert("fed /health/ping leaks no session names",
    fedPing.body.sessions === undefined && !JSON.stringify(fedPing.body).includes("secret-session"),
    JSON.stringify(fedPing.body));

  // (e) /link/reload is loopback-only AND token-gated; a wrong token → 401. (The
  // test connects over loopback, so isLoopback passes; the token check is what
  // rejects here — proving the defense-in-depth gate is active.)
  const reloadBad = await hub.raw("POST", "/link/reload", { token: "nope", json: {}, onMain: true });
  assert("/link/reload rejects a wrong token (401)", reloadBad.status === 401, JSON.stringify(reloadBad));
  const reloadOk = await hub.raw("POST", "/link/reload", { token: TOKEN, json: {}, onMain: true });
  assert("/link/reload accepts the correct token over loopback (200)", reloadOk.status === 200 && reloadOk.body.ok === true, JSON.stringify(reloadOk));
} finally {
  await hub.stop();
}

reportAndExit();
