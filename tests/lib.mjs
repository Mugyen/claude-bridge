// Shared helpers for claude-bridge tests.
//
// Spin up a temp bridge server on a non-default port, connect via SSE,
// dispatch tool calls, and read responses. Keep this file dependency-free
// (matches the bridge server itself — Node stdlib only).

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

export class TestBridge {
  // `fed` (optional): { token, role, hub, node } — writes per-bridge temp config
  // files and points the server at them so federation is isolated from the
  // developer's real ~/.claude dotfiles. Omit for a pure standalone bridge.
  // `fedPort` (optional): the loopback fed-listener port (hub mode). Defaults to
  // port+1, matching the server's CC_BRIDGE_FED_PORT default. The cloudflared
  // tunnel — and therefore the spoke→hub /link/* traffic — targets THIS port,
  // not the main port. The main port serves /sse,/message,/pending,/whoami,
  // /health,/health/ping,/link/reload only.
  constructor(port = 7402, fed = null, fedPort = null) {
    this.port = port;
    this.fedPort = fedPort ?? port + 1;
    this.responses = new Map();
    this.sid = null;
    this.server = null;
    this.nextId = 1;
    this.fed = fed;
    this._tmp = `${os.tmpdir()}/cb-test-${port}-${process.pid}`;
  }

  _fedEnv() {
    // Always isolate the config-file paths to temp so a developer who has
    // --share'd their own machine doesn't accidentally turn test bridges into
    // hubs. Standalone bridges get empty temp files (= no token = no gate).
    const f = this.fed || {};
    const tok = `${this._tmp}.token`;
    const role = `${this._tmp}.role`;
    const hub = `${this._tmp}.hub`;
    const node = `${this._tmp}.node`;
    const expose = `${this._tmp}.expose`;
    fs.writeFileSync(tok, f.token || "");
    fs.writeFileSync(role, f.role || "");
    fs.writeFileSync(hub, f.hub || "");
    fs.writeFileSync(node, f.node || "");
    fs.writeFileSync(expose, f.expose || "");
    return {
      CC_BRIDGE_TOKEN_FILE: f.token ? tok : `${this._tmp}.notoken`,
      CC_BRIDGE_ROLE_FILE: role,
      CC_BRIDGE_HUB_FILE: hub,
      CC_BRIDGE_NODE_FILE: node,
      // Rooms store is ALWAYS isolated (same rationale as the token files): a
      // developer with a real room on their machine must not gate test bridges,
      // and tests must never write the real ~/.claude/.cc-bridge-rooms.json.
      CC_BRIDGE_ROOMS_FILE: `${this._tmp}.rooms`,
      CC_BRIDGE_EXPOSE_FILE: expose,
    };
  }

  // Rewrite the fed config files and hit /link/reload so a running bridge picks
  // up new role/hub/token without a restart (mirrors --share/--join).
  async reloadFed(fed) {
    this.fed = fed;
    this._fedEnv();
    // /link/reload is loopback-only AND token-gated when a token is configured —
    // mirror claude-bridge's fed_reload by sending the token header when present.
    const headers = { "Content-Type": "application/json", "Content-Length": 2 };
    if (fed && fed.token) headers["X-Bridge-Token"] = fed.token;
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${this.port}/link/reload`,
        { method: "POST", headers },
        (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }
      );
      req.on("error", reject);
      req.write("{}");
      req.end();
    });
  }

  async start() {
    // Reset per-connection state so the SAME instance can be restarted (the chaos
    // suite does stop()+start() to model a crash). Without this, a stale this.sid
    // from the previous start makes the handshake's `!this.sid` guard false, so the
    // new session= line is never captured and start() hangs to the 5s timeout.
    this.sid = null;
    this.responses.clear();

    // Free the main + fed ports if anything is squatting on them
    await new Promise((r) => {
      const k = spawn("sh", ["-c", `lsof -ti:${this.port} -ti:${this.fedPort} | xargs kill 2>/dev/null; true`]);
      k.on("close", () => r());
    });
    await sleep(500);

    const fedEnv = this._fedEnv();
    const repoRoot = new URL("..", import.meta.url).pathname;
    this.server = spawn("node", [`${repoRoot}/bridge-server.mjs`], {
      env: { ...process.env, CC_BRIDGE_PORT: String(this.port), CC_BRIDGE_FED_PORT: String(this.fedPort), ...fedEnv },
      // stdout → "ignore" (discarded by the OS, like production's redirect to the
      // log file). An unread PIPE fills its 64KB buffer once the server logs enough
      // and console.log blocks the event loop synchronously — which surfaced as an
      // /sse handshake timeout when restarting a server mid-test (chaos suite).
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Capture stderr if anything goes wrong
    this.server.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));

    await sleep(1500);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSE handshake timeout")), 5000);
      http
        .get(`http://localhost:${this.port}/sse`, (res) => {
          let buf = "";
          res.on("data", (chunk) => {
            buf += chunk.toString();
            const parts = buf.split("\n\n");
            buf = parts.pop();
            for (const p of parts) {
              const dm = p.match(/^data: (.+)$/m);
              if (!dm) continue;
              const data = dm[1];
              const sm = data.match(/session=([a-f0-9-]+)/);
              if (sm && !this.sid) {
                this.sid = sm[1];
                clearTimeout(timeout);
                resolve();
                continue;
              }
              try {
                const j = JSON.parse(data);
                if (j.id != null) this.responses.set(j.id, j);
              } catch {}
            }
          });
        })
        .on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
    });
  }

  async call(name, args = {}) {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    await new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${this.port}/message?session=${this.sid}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        () => resolve()
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    for (let i = 0; i < 60; i++) {
      if (this.responses.has(id)) {
        return JSON.parse(this.responses.get(id).result.content[0].text);
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for response to ${name}`);
  }

  async pending(session, { peek = false, cid = null } = {}) {
    // cid → resolve by stable claude_session_id (what the idle-listener uses);
    // otherwise by registered name (back-compat).
    const key = cid ? `claude_session_id=${encodeURIComponent(cid)}` : `session=${encodeURIComponent(session)}`;
    const url = `http://localhost:${this.port}/pending?${key}${peek ? "&peek=1" : ""}`;
    return new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(b));
        })
        .on("error", reject);
    });
  }

  // health(token) — pass a token to send the X-Bridge-Token header. Returns
  // { status:<httpStatus>, body:<parsed|raw> } so callers can assert on 401.
  async health(token = null) {
    const headers = token ? { "X-Bridge-Token": token } : {};
    return new Promise((resolve, reject) => {
      http
        .get(`http://localhost:${this.port}/health`, { headers }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => {
            let body;
            try { body = JSON.parse(b); } catch { body = b; }
            // Back-compat: existing tests do `(await bridge.health()).status === "ok"`.
            // In standalone (no token) /health returns {status:"ok",...} as before.
            if (body && typeof body === "object" && body.status) resolve(body);
            else resolve({ httpStatus: res.statusCode, body });
          });
        })
        .on("error", reject);
    });
  }

  // healthPing() — the ungated liveness probe (no session names).
  async healthPing() {
    return new Promise((resolve, reject) => {
      http
        .get(`http://localhost:${this.port}/health/ping`, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => { try { resolve({ httpStatus: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(e); } });
        })
        .on("error", reject);
    });
  }

  // Raw HTTP helper for /link/* and /health assertions with arbitrary headers.
  // Returns { status, body }.
  //
  // Port routing: /link/* (the federation link surface) lives ONLY on the fed
  // listener, so those calls default to fedPort. Everything else (/health,
  // /link/reload, /sse, ...) hits the main port. Pass { onMain:true } to force a
  // /link/* call at the MAIN port (used by the security tests that assert the
  // main port returns 404 for /link/*), or { onFed:true } to force any path to
  // the fed port (assert the fed port 404s for local routes).
  async raw(method, path, { token, node, json, onMain, onFed } = {}) {
    const headers = {};
    if (token) headers["X-Bridge-Token"] = token;
    if (node) headers["X-Bridge-Node"] = node;
    let port = this.port;
    if (onFed) port = this.fedPort;
    else if (onMain) port = this.port;
    else if (path.startsWith("/link/") && path !== "/link/reload") port = this.fedPort;
    let body = null;
    if (json !== undefined) { body = JSON.stringify(json); headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(body); }
    return new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${port}${path}`, { method, headers }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => { let parsed; try { parsed = JSON.parse(b); } catch { parsed = b; } resolve({ status: res.statusCode, body: parsed }); });
      });
      // A closed port (e.g. the fed listener when not a hub) yields ECONNREFUSED.
      // Surface it as { status:0, error } so security tests can assert "not bound"
      // rather than crash on an unhandled rejection.
      req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
      if (body) req.write(body);
      req.end();
    });
  }

  async stop({ signal = "SIGTERM" } = {}) {
    if (!this.server) return;
    this.server.kill(signal);
    await new Promise((r) => this.server.on("close", () => r()));
    this.server = null;
    // NB: `.rooms` is deliberately NOT deleted here — stop()+start() models a
    // restart, and room persistence across restarts is a tested guarantee.
    // The file is tiny and the path is pid-unique, so the tmpdir leak is benign.
    for (const ext of [".token", ".role", ".hub", ".node", ".expose"]) {
      try { fs.unlinkSync(`${this._tmp}${ext}`); } catch {}
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _pass = 0;
let _fail = 0;
const _failures = [];

export function assert(label, cond, detail = "") {
  if (cond) {
    _pass++;
    console.log(`  ✓ ${label}`);
  } else {
    _fail++;
    _failures.push(`${label}${detail ? ": " + detail : ""}`);
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  }
}

export function reportAndExit() {
  console.log(`\n${_pass} passed, ${_fail} failed`);
  if (_fail > 0) {
    console.log("\nFailures:");
    for (const f of _failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}
