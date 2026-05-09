#!/usr/bin/env node
/**
 * bridge-stdio.mjs — stdio-to-SSE adapter for Claude Desktop
 *
 * Claude Desktop only speaks MCP over stdio. This script:
 *   1. Connects to the bridge's SSE endpoint to get a session ID
 *   2. Reads JSON-RPC from stdin (Claude Desktop sends requests here)
 *   3. POSTs them to the bridge's /message endpoint
 *   4. Listens for SSE responses and writes them to stdout
 *
 * Usage:
 *   node bridge-stdio.mjs                  # default port 7400
 *   CC_BRIDGE_PORT=8888 node bridge-stdio.mjs
 */

import http from "node:http";
import readline from "node:readline";

const PORT = parseInt(process.env.CC_BRIDGE_PORT ?? "7400");
const BRIDGE = `http://localhost:${PORT}`;

let sseSessionId = null;
const pendingRequests = new Map();

function log(...args) {
  process.stderr.write(`[bridge-stdio] ${args.join(" ")}\n`);
}

function sendResponse(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + "\n");
}

function connectSSE() {
  return new Promise((resolve, reject) => {
    http.get(`${BRIDGE}/sse`, (res) => {
      let buf = "";

      res.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();

            if (eventType === "endpoint") {
              const match = data.match(/[?&]session=([^&]+)/);
              if (match) {
                sseSessionId = match[1];
                log(`connected, session=${sseSessionId}`);
                resolve();
              }
            } else {
              try {
                const msg = JSON.parse(data);
                if (msg.id != null && pendingRequests.has(msg.id)) {
                  sendResponse(msg);
                  pendingRequests.delete(msg.id);
                }
              } catch {}
            }
            eventType = null;
          } else if (line.startsWith(":")) {
            // keepalive ping, ignore
          }
        }
      });

      res.on("error", (err) => {
        log(`SSE error: ${err.message}`);
        process.exit(1);
      });

      res.on("end", () => {
        log("SSE connection closed");
        process.exit(1);
      });
    }).on("error", (err) => {
      reject(err);
    });
  });
}

function postMessage(rpc) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rpc);
    const req = http.request(
      `${BRIDGE}/message?session=${sseSessionId}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function handleRequest(rpc) {
  if (rpc.method === "notifications/initialized") {
    return;
  }

  if (rpc.method === "initialize") {
    sendResponse({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "cc-bridge", version: "2.1.0" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  // For tools/list and tools/call, forward to the bridge
  pendingRequests.set(rpc.id, true);

  try {
    await postMessage(rpc);
  } catch (err) {
    pendingRequests.delete(rpc.id);
    sendResponse({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: JSON.stringify({ error: `Bridge unreachable: ${err.message}` }) }] },
    });
  }
}

async function main() {
  try {
    await connectSSE();
  } catch (err) {
    log(`Cannot connect to bridge at ${BRIDGE}: ${err.message}`);
    log("Is the bridge server running? Start it with: node bridge-server.mjs");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const rpc = JSON.parse(line);
      handleRequest(rpc);
    } catch (err) {
      log(`bad input: ${err.message}`);
    }
  });

  rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });
}

main();
