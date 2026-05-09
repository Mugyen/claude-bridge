#!/usr/bin/env node
/**
 * cc-bridge: MCP server enabling real-time Q&A between Claude Code sessions.
 *
 * Two interfaces:
 *   1. MCP over SSE — Claude Code sessions connect here for tools (ask, reply, etc.)
 *   2. HTTP REST    — Hook scripts curl here to check for pending questions
 *
 * Usage:
 *   node bridge-server.mjs                  # default port 7400
 *   node bridge-server.mjs --port 8888      # custom port
 *   CC_BRIDGE_PORT=8888 node bridge-server.mjs
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = parseInt(
  process.argv.find((_, i, a) => a[i - 1] === "--port") ??
    process.env.CC_BRIDGE_PORT ??
    "7400"
);

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Map<string, {name:string, description:string, connectedAt:number}>} */
const sessions = new Map(); // sseId → info

/** @type {Map<string, string>} name → sseId */
const nameToSSE = new Map();

/** @type {Map<string, {id:string, from:string, to:string, question:string, answer:string|null, ts:number, answeredAt:number|null}>} */
const messages = new Map();

/** @type {Map<string, string[]>} threadKey → [msgId, ...] */
const threads = new Map();

/** @type {Map<string, string>} sessionName → scratchpad */
const scratchpad = new Map();

/** @type {Map<string, string>} claudeSessionId → registered name (source of truth for hooks) */
const claudeIdToName = new Map();

// ─── Garbage Collection ────────────────────────────────────────────────────

const GC_INTERVAL = 60 * 60 * 1000; // 1 hour
const GC_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function gc() {
  const cutoff = Date.now() - GC_MAX_AGE;
  let pruned = 0;

  for (const [id, msg] of messages) {
    if (msg.ts < cutoff) {
      messages.delete(id);
      pruned++;
    }
  }

  for (const [key, ids] of threads) {
    const kept = ids.filter((id) => messages.has(id));
    if (kept.length === 0) threads.delete(key);
    else threads.set(key, kept);
  }

  for (const [sseId, info] of sessions) {
    if (!sseClients.has(sseId) && info.connectedAt < cutoff) {
      sessions.delete(sseId);
      if (nameToSSE.get(info.name) === sseId) nameToSSE.delete(info.name);
    }
  }

  for (const [cid, name] of claudeIdToName) {
    if (![...nameToSSE.values()].some((id) => sessions.get(id)?.name === name)) {
      // name no longer has an active session — check if it's orphaned
      const hasMessages = [...messages.values()].some((m) => m.from === name || m.to === name);
      if (!hasMessages) claudeIdToName.delete(cid);
    }
  }

  for (const [name] of scratchpad) {
    const hasActiveSession = [...sessions.values()].some((s) => s.name === name) &&
      [...nameToSSE.entries()].some(([n, id]) => n === name && sseClients.has(id));
    const hasMessages = [...messages.values()].some((m) => m.from === name || m.to === name);
    if (!hasActiveSession && !hasMessages) scratchpad.delete(name);
  }

  if (pruned > 0) console.log(`${ts()} 🧹 GC: pruned ${pruned} messages older than 30 days`);
}

setInterval(gc, GC_INTERVAL);

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tkey = (a, b) => [a, b].sort().join("↔");
const norm = (q) => q.toLowerCase().trim().replace(/\s+/g, " ");
const ts = () => new Date().toISOString().slice(11, 19);

function activeSessions() {
  const out = [];
  for (const [sseId, info] of sessions) {
    if (sseClients.has(sseId)) {
      out.push({ name: info.name, description: info.description });
    }
  }
  return out;
}

function getName(sseId) {
  return sessions.get(sseId)?.name;
}

function getThread(a, b) {
  const ids = threads.get(tkey(a, b)) || [];
  return ids.map((id) => {
    const m = messages.get(id);
    return { id: m.id, from: m.from, to: m.to, question: m.question, answer: m.answer ?? "(pending)", ts: m.ts };
  });
}

function recentAnswered(a, b, n = 5) {
  return getThread(a, b).filter((m) => m.answer !== "(pending)").slice(-n);
}

// ─── MCP Tool Definitions ───────────────────────────────────────────────────

const TOOLS = [
  {
    name: "register",
    description: "Register this session with the bridge. Call once at the start. Pass your claude_session_id (printed in the SessionStart message) so the hook can find your registered name even if you rename later.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Unique session name, e.g. "api-builder", "frontend"' },
        description: { type: "string", description: "What this session is working on" },
        claude_session_id: { type: "string", description: "The Claude Code session_id printed by the SessionStart hook. Required so the PostToolUse hook can resolve your canonical name." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_sessions",
    description: "List all active sessions on the bridge.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask",
    description:
      "Ask another session a question. BLOCKS until they reply (up to 5min). Check get_thread first to avoid repeats.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target session name" },
        question: { type: "string", description: "Specific, precise question. Reference file paths, function names, exact constraints. Build on previous answers." },
      },
      required: ["to", "question"],
    },
  },
  {
    name: "reply",
    description:
      "Reply to a pending question. Include: the answer, WHY, user preferences that influenced it, alternatives rejected, and gotchas.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string" },
        answer: { type: "string", description: "Detailed, self-contained answer." },
      },
      required: ["message_id", "answer"],
    },
  },
  {
    name: "get_thread",
    description: "Get Q&A history with a session. ALWAYS check before ask() to avoid repeats.",
    inputSchema: {
      type: "object",
      properties: { with_session: { type: "string" } },
      required: ["with_session"],
    },
  },
  {
    name: "broadcast",
    description: "Write to your scratchpad. Others can read it. Share decisions, constraints, status.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        append: { type: "boolean", description: "Append instead of replace" },
      },
      required: ["content"],
    },
  },
  {
    name: "read_scratchpad",
    description: "Read a session's scratchpad. Omit session to read all.",
    inputSchema: {
      type: "object",
      properties: { session: { type: "string" } },
    },
  },
];

// ─── Tool Execution ─────────────────────────────────────────────────────────

async function executeTool(sseId, name, args) {
  const myName = getName(sseId);

  switch (name) {
    case "register": {
      const { name: sName, description = "", claude_session_id } = args;
      const existing = nameToSSE.get(sName);
      if (existing && existing !== sseId && sseClients.has(existing)) {
        return { error: `Name "${sName}" is taken by another active session.` };
      }
      // Rename cleanup: if this sseId previously held a different name, retire it
      // so future ask(to="<old-name>") fails fast instead of dangling forever.
      // Also unblock any in-flight asks targeting the old name with an explanatory error.
      const prev = sessions.get(sseId);
      if (prev && prev.name !== sName && nameToSSE.get(prev.name) === sseId) {
        nameToSSE.delete(prev.name);
        for (const m of messages.values()) {
          if (m.to === prev.name && m.answer === null) {
            m.answer = `[bridge] "${prev.name}" was renamed to "${sName}" before answering. Re-ask under the new name if you still need this.`;
            m.answeredAt = Date.now();
          }
        }
        console.log(`${ts()} ↪ rename: "${prev.name}" → "${sName}" (old name retired, dangling asks failed)`);
      }
      sessions.set(sseId, { name: sName, description, connectedAt: Date.now() });
      nameToSSE.set(sName, sseId);

      // Persist claude_session_id → name so the hook can resolve canonical name
      if (claude_session_id) {
        claudeIdToName.set(claude_session_id, sName);
        // Also rewrite the on-disk name file to keep everything in sync
        try {
          const namePath = `/tmp/cc-bridge-${claude_session_id}.name`;
          fs.writeFileSync(namePath, sName);
        } catch (e) {
          console.log(`${ts()} ⚠ could not write name file: ${e.message}`);
        }
      }

      console.log(`${ts()} ✓ registered: ${sName} — ${description}${claude_session_id ? ` (cid:${claude_session_id.slice(0, 8)})` : ""}`);
      return { ok: true, your_name: sName, active_sessions: activeSessions() };
    }

    case "list_sessions":
      return { sessions: activeSessions() };

    case "ask": {
      if (!myName) return { error: "Call register() first." };
      const { to, question } = args;
      const targetSSE = nameToSSE.get(to);
      if (!targetSSE || !sseClients.has(targetSSE)) {
        return { error: `"${to}" not connected. Active: ${activeSessions().map((s) => s.name).join(", ") || "(none)"}` };
      }

      // Dedup check
      const key = tkey(myName, to);
      for (const msgId of threads.get(key) || []) {
        const m = messages.get(msgId);
        if (m?.answer && norm(m.question) === norm(question)) {
          console.log(`${ts()} ↩ dedup hit for "${question.slice(0, 50)}..."`);
          return { cached: true, message_id: m.id, question: m.question, answer: m.answer, note: "Already asked and answered. Previous answer returned." };
        }
      }

      // Queue
      const id = crypto.randomUUID().slice(0, 8);
      const msg = { id, from: myName, to, question, answer: null, ts: Date.now(), answeredAt: null };
      messages.set(id, msg);
      if (!threads.has(key)) threads.set(key, []);
      threads.get(key).push(id);
      console.log(`${ts()} ? ${myName} → ${to}: "${question.slice(0, 80)}"`);

      // Poll for answer
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        if (msg.answer !== null) {
          console.log(`${ts()} ✓ answer for ${id} (${msg.answer.length} chars)`);
          return { message_id: id, question: msg.question, answer: msg.answer };
        }
        await sleep(2000);
      }
      return { message_id: id, error: "Timeout: no reply within 5 minutes.", question };
    }

    case "reply": {
      const msg = messages.get(args.message_id);
      if (!msg) return { error: `No message "${args.message_id}"` };
      if (msg.answer !== null) return { error: "Already answered.", existing: msg.answer };
      msg.answer = args.answer;
      msg.answeredAt = Date.now();
      console.log(`${ts()} ← reply to ${args.message_id} (${args.answer.length} chars)`);
      return { ok: true, message_id: args.message_id };
    }

    case "get_thread": {
      if (!myName) return { error: "Call register() first." };
      const history = getThread(myName, args.with_session);
      return { thread_with: args.with_session, count: history.length, messages: history };
    }

    case "broadcast": {
      if (!myName) return { error: "Call register() first." };
      const cur = scratchpad.get(myName) || "";
      scratchpad.set(myName, args.append ? cur + "\n" + args.content : args.content);
      return { ok: true, session: myName, length: scratchpad.get(myName).length };
    }

    case "read_scratchpad": {
      if (args.session) return { session: args.session, content: scratchpad.get(args.session) || "(empty)" };
      const all = {};
      for (const [k, v] of scratchpad) all[k] = v;
      return { scratchpads: Object.keys(all).length ? all : "(none)" };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── SSE Client Management ──────────────────────────────────────────────────

/** @type {Map<string, http.ServerResponse>} */
const sseClients = new Map();

function sendSSE(sessionId, data) {
  const res = sseClients.get(sessionId);
  if (!res || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── SSE endpoint (MCP transport) ──────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/sse") {
    const sid = crypto.randomUUID().slice(0, 12);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: endpoint\ndata: http://localhost:${PORT}/message?session=${sid}\n\n`);
    sseClients.set(sid, res);

    // Keepalive: SSE comment every 25s prevents idle timeout on Claude Code's MCP client
    const ka = setInterval(() => {
      if (res.destroyed) { clearInterval(ka); return; }
      res.write(`: ping ${Date.now()}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(ka);
      sseClients.delete(sid);
      const info = sessions.get(sid);
      if (info) console.log(`${ts()} ✗ disconnected: ${info.name}`);
    });
    console.log(`${ts()} ⚡ SSE connected: ${sid}`);
    return;
  }

  // ── JSON-RPC messages (MCP) ───────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/message") {
    const sid = url.searchParams.get("session");
    if (!sid) { res.writeHead(400); res.end("missing session"); return; }

    let body = "";
    for await (const chunk of req) body += chunk;
    let rpc;
    try { rpc = JSON.parse(body); } catch { res.writeHead(400); res.end("bad json"); return; }

    if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }

    let result;
    const isBlocking = rpc.method === "tools/call" && rpc.params?.name === "ask";

    switch (rpc.method) {
      case "initialize":
        result = { protocolVersion: "2024-11-05", serverInfo: { name: "cc-bridge", version: "2.0.0" }, capabilities: { tools: {} } };
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const { name: tn, arguments: ta } = rpc.params;
        if (isBlocking) {
          // For ask: return HTTP 202 immediately, send MCP response via SSE when ready
          res.writeHead(202); res.end();
          const tr = await executeTool(sid, tn, ta ?? {});
          sendSSE(sid, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(tr, null, 2) }] } });
          return;
        }
        const tr = await executeTool(sid, tn, ta ?? {});
        result = { content: [{ type: "text", text: JSON.stringify(tr, null, 2) }] };
        break;
      }
      default:
        result = { error: { code: -32601, message: `Unknown: ${rpc.method}` } };
    }

    sendSSE(sid, { jsonrpc: "2.0", id: rpc.id, result });
    res.writeHead(202); res.end();
    return;
  }

  // ── GET /pending — for hook scripts ───────────────────────────────────
  if (req.method === "GET" && url.pathname === "/pending") {
    const session = url.searchParams.get("session");
    if (!session) { res.writeHead(400); res.end("missing ?session="); return; }

    const pending = [...messages.values()].filter((m) => m.to === session && m.answer === null);
    if (pending.length === 0) { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(""); return; }

    let out = "";
    for (const msg of pending) {
      const recent = recentAnswered(session, msg.from, 3);
      const fromInfo = [...sessions.values()].find((s) => s.name === msg.from);

      out += `\n${"═".repeat(60)}\n`;
      out += `🔔 BRIDGE: Question from "${msg.from}"`;
      if (fromInfo?.description) out += ` (${fromInfo.description})`;
      out += `\n${"═".repeat(60)}\n`;

      if (recent.length > 0) {
        out += `\nThread history (DO NOT repeat — build on these):\n`;
        for (const p of recent) {
          out += `  [${p.from}] Q: ${p.question}\n`;
          out += `  [${p.to === msg.from ? session : msg.from}] A: ${p.answer}\n\n`;
        }
      }

      out += `NEW QUESTION (id: ${msg.id}):\n  "${msg.question}"\n\n`;
      out += `→ Call reply(message_id="${msg.id}", answer="...") NOW.\n`;
      out += `  Include: direct answer with specifics • WHY this choice •\n`;
      out += `  user preferences that influenced it • alternatives rejected • gotchas\n`;
      out += `${"═".repeat(60)}\n`;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(out);
    return;
  }

  // ── GET /whoami — for hook scripts to resolve canonical name ──────────
  if (req.method === "GET" && url.pathname === "/whoami") {
    const cid = url.searchParams.get("session_id");
    if (!cid) { res.writeHead(400); res.end("missing ?session_id="); return; }
    const name = claudeIdToName.get(cid);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ session_id: cid, name: name ?? null }));
    return;
  }

  // ── GET /health ───────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      sessions: activeSessions(),
      pending: [...messages.values()].filter((m) => !m.answer).length,
      answered: [...messages.values()].filter((m) => m.answer).length,
    }));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n${"═".repeat(42)}`);
  console.log(`  cc-bridge v2.0`);
  console.log(`  SSE:     http://localhost:${PORT}/sse`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`${"═".repeat(42)}\n`);
});
