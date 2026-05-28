// Shared helpers for claude-bridge tests.
//
// Spin up a temp bridge server on a non-default port, connect via SSE,
// dispatch tool calls, and read responses. Keep this file dependency-free
// (matches the bridge server itself — Node stdlib only).

import http from "node:http";
import { spawn } from "node:child_process";

export class TestBridge {
  constructor(port = 7402) {
    this.port = port;
    this.responses = new Map();
    this.sid = null;
    this.server = null;
    this.nextId = 1;
  }

  async start() {
    // Free the port if anything is squatting on it
    await new Promise((r) => {
      const k = spawn("sh", ["-c", `lsof -ti:${this.port} | xargs kill 2>/dev/null; true`]);
      k.on("close", () => r());
    });
    await sleep(500);

    const repoRoot = new URL("..", import.meta.url).pathname;
    this.server = spawn("node", [`${repoRoot}/bridge-server.mjs`], {
      env: { ...process.env, CC_BRIDGE_PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
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

  async pending(session, { peek = false } = {}) {
    const url = `http://localhost:${this.port}/pending?session=${encodeURIComponent(session)}${peek ? "&peek=1" : ""}`;
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

  async health() {
    return new Promise((resolve, reject) => {
      http
        .get(`http://localhost:${this.port}/health`, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(b));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on("error", reject);
    });
  }

  async stop({ signal = "SIGTERM" } = {}) {
    if (!this.server) return;
    this.server.kill(signal);
    await new Promise((r) => this.server.on("close", () => r()));
    this.server = null;
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
