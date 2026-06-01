#!/usr/bin/env node
/**
 * claude-bridge: MCP server enabling real-time Q&A between Claude Code sessions.
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
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

const PORT = parseInt(
  process.argv.find((_, i, a) => a[i - 1] === "--port") ??
    process.env.CC_BRIDGE_PORT ??
    "7400"
);

// Federation listener port. The MAIN server binds 127.0.0.1:PORT and serves ALL
// local routes — it is NEVER tunneled. When this node is a hub, a SECOND server
// binds 127.0.0.1:FED_PORT and serves ONLY the token-gated /link/* surface (plus
// content-free /health/ping). ONLY the fed port is exposed via the cloudflared
// tunnel, so the ungated local routes (/sse, /message, /pending, /whoami) can
// never be reached from the internet. See DEVELOPER.md (two-listener security).
const FED_PORT = parseInt(process.env.CC_BRIDGE_FED_PORT ?? String(PORT + 1));
// Fed-listener bind address. Default 127.0.0.1 — the secure norm, where ONLY a
// local cloudflared (quick or named tunnel) exposes it. Set CC_BRIDGE_FED_BIND=
// 0.0.0.0 to expose the fed port DIRECTLY on the host's network (e.g. a cloud VM
// with a public IP, no tunnel). Direct mode is still token-gated, but the token
// + traffic travel in cleartext over plain HTTP — put a TLS terminator (Caddy /
// named tunnel) in front for anything beyond a trusted-LAN / one-off test.
const FED_BIND = process.env.CC_BRIDGE_FED_BIND ?? "127.0.0.1";

// ─── Federation config (cross-network hub-and-spoke linking) ─────────────────
//
// Everything federation-related is gated behind FED.token / FED.role so that a
// standalone bridge (no token file, no hub URL) behaves byte-for-byte like the
// pre-federation server. See docs/specs/cross-network-federation*.md.
//
// Config lives in dotfiles under ~/.claude so a RUNNING bridge can hot-reload it
// without a restart (restarting drops every SSE client and can kill the calling
// session — DEVELOPER.md lesson #23a). `POST /link/reload` re-reads these files.
//
//   .cc-bridge-token  — shared secret; presence ⇒ "sharing on" (gate active)
//   .cc-bridge-role   — "hub" | "spoke" | "standalone" (default standalone-with-token = hub)
//   .cc-bridge-hub    — spoke only: the hub's https://host base URL
//   .cc-bridge-node   — this node's stable id (defaults to hostname)

const HOME = os.homedir();
const TOKEN_FILE = process.env.CC_BRIDGE_TOKEN_FILE ?? `${HOME}/.claude/.cc-bridge-token`;
const ROLE_FILE = process.env.CC_BRIDGE_ROLE_FILE ?? `${HOME}/.claude/.cc-bridge-role`;
const HUB_FILE = process.env.CC_BRIDGE_HUB_FILE ?? `${HOME}/.claude/.cc-bridge-hub`;
const NODE_FILE = process.env.CC_BRIDGE_NODE_FILE ?? `${HOME}/.claude/.cc-bridge-node`;

function sanitizeNode(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "node";
}

function readFileTrim(p) {
  try { return fs.readFileSync(p, "utf8").trim() || null; } catch { return null; }
}

/** Federation runtime state. Re-derived from disk by loadFedConfig(). */
const FED = {
  role: "standalone", // "hub" | "spoke" | "standalone"
  token: null,
  node: sanitizeNode(process.env.CC_BRIDGE_NODE ?? os.hostname()),
  hubUrl: null, // spoke only
};

// HUB side: node → { res:SSEResponse|null, sessions:[{name,description}], lastSeen:number }
const spokes = new Map();

// SPOKE side: outbound link to the hub.
let hubStream = null; // active https/http response object (for teardown)
let hubStreamReq = null; // active request (for teardown)
let remoteRoster = []; // [{name, description, node}] last snapshot pushed by the hub
let spokeReconnectTimer = null;
let spokeReconnectDelay = 1000; // backoff: 1s → 2s → 5s → … → 30s max
let spokeGen = 0; // bumped on each (re)connect attempt to invalidate stale callbacks
let spokeHeartbeatTimer = null; // periodic POST /link/heartbeat to keep the hub's lastSeen fresh
// Defaults: 25s heartbeat (sub-100s Cloudflare keepalive AND < the 45s stale-sweep),
// 45s stale cutoff, 15s sweep tick. Env-overridable so tests can drive the
// stale-prune timing deterministically; production never sets these.
const SPOKE_HEARTBEAT_MS = Number(process.env.CC_BRIDGE_HEARTBEAT_MS) || 25000;
const SPOKE_STALE_MS = Number(process.env.CC_BRIDGE_SPOKE_STALE_MS) || 45000;
const SPOKE_SWEEP_MS = Number(process.env.CC_BRIDGE_SPOKE_SWEEP_MS) || 15000;

// ── Hardening limits (Tier 2: DoS / resource caps) ──────────────────────────
// All generous enough that normal use never trips them; they exist to bound a
// flood or a buggy/hostile peer. Env-overridable.
const MAX_BODY_BYTES = Number(process.env.CC_BRIDGE_MAX_BODY) || 1_000_000; // 1MB cap on any POST body → 413
const MAX_SPOKE_NODES = Number(process.env.CC_BRIDGE_MAX_NODES) || 64;       // distinct federated nodes a hub will track
const MAX_SESSIONS_PER_NODE = Number(process.env.CC_BRIDGE_MAX_SESSIONS) || 256; // advertised sessions accepted per node
const RATE_MAX = Number(process.env.CC_BRIDGE_RATE_MAX) || 60;              // message-creating ops …
const RATE_WINDOW_MS = Number(process.env.CC_BRIDGE_RATE_WINDOW_MS) || 10_000; // … per source per this window
// Share each session's free-text description across the federation? Default OFF:
// descriptions can carry project/file context and a hub broadcasts the roster to
// every node. Local list_sessions always shows local descriptions regardless.
const SHARE_DESCRIPTIONS = process.env.CC_BRIDGE_SHARE_DESCRIPTIONS === "1";

// Token-bucket rate limiter keyed by source (sseId / spoke node). Bounds floods
// on the message-CREATING paths (ask/notify/broadcast, /link/forward); reads and
// register/reply are never limited.
const _rate = new Map(); // key → { tokens, last }
function rateOk(key) {
  const now = Date.now();
  let b = _rate.get(key);
  if (!b) { b = { tokens: RATE_MAX, last: now }; _rate.set(key, b); }
  b.tokens = Math.min(RATE_MAX, b.tokens + ((now - b.last) / RATE_WINDOW_MS) * RATE_MAX);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function loadFedConfig() {
  const token = readFileTrim(TOKEN_FILE);
  let role = readFileTrim(ROLE_FILE);
  const hubUrl = readFileTrim(HUB_FILE);
  const node = readFileTrim(NODE_FILE);

  FED.token = token;
  FED.node = sanitizeNode(node ?? process.env.CC_BRIDGE_NODE ?? os.hostname());
  FED.hubUrl = hubUrl;

  // Role inference: explicit role file wins; else token+hubUrl ⇒ spoke, token alone ⇒ hub.
  if (role === "hub" || role === "spoke" || role === "standalone") {
    FED.role = role;
  } else if (token && hubUrl) {
    FED.role = "spoke";
  } else if (token) {
    FED.role = "hub";
  } else {
    FED.role = "standalone";
  }

  // Guardrail: cannot be a hub or spoke without a token.
  if (!token && FED.role !== "standalone") FED.role = "standalone";
  if (FED.role === "spoke" && !hubUrl) FED.role = token ? "hub" : "standalone";
}

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Map<string, {name:string, description:string, connectedAt:number}>} */
const sessions = new Map(); // sseId → info

/** @type {Map<string, string>} name → sseId */
const nameToSSE = new Map();

/** @type {Map<string, {id:string, from:string, to:string, kind?:"question"|"notice", question?:string, answer?:string|null, content?:string, delivered?:boolean, ts:number, answeredAt?:number|null}>} */
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

  // Prune idle rate-limit buckets (full again ⇒ no recent activity) so the map
  // doesn't accumulate one entry per ever-seen sseId/node.
  const rateIdle = Date.now() - RATE_WINDOW_MS * 2;
  for (const [k, b] of _rate) if (b.last < rateIdle) _rate.delete(k);

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

// Sessions as advertised ACROSS the federation link. Strips the free-text
// description by default (it can carry project/file context, and the hub
// broadcasts the roster to every node) — opt in with CC_BRIDGE_SHARE_DESCRIPTIONS=1.
// Local list_sessions still shows local descriptions regardless.
function linkSessions() {
  return activeSessions().map((s) => (SHARE_DESCRIPTIONS ? { name: s.name, description: s.description } : { name: s.name }));
}

function getName(sseId) {
  return sessions.get(sseId)?.name;
}

function getThread(a, b) {
  const ids = threads.get(tkey(a, b)) || [];
  return ids.map((id) => {
    const m = messages.get(id);
    if (m.kind === "notice") {
      return { id: m.id, from: m.from, to: m.to, kind: "notice", content: m.content, delivered: !!m.delivered, ts: m.ts };
    }
    return { id: m.id, from: m.from, to: m.to, kind: "question", question: m.question, answer: m.answer, answered: m.answer !== null, ts: m.ts };
  });
}

function recentAnswered(a, b, n = 5) {
  return getThread(a, b).filter((m) => m.answered).slice(-n);
}

function getPendingFor(name) {
  // Questions awaiting a reply. Notices are one-way (no answer), so they're
  // explicitly excluded — they must never show up as something to reply to.
  return [...messages.values()].filter((m) => m.to === name && m.kind !== "notice" && m.answer === null);
}

// ─── Federation helpers ──────────────────────────────────────────────────────

function tokenOk(req) {
  // Gate is active only when a token is configured (sharing on). When standalone
  // (no token), endpoints stay open — preserving the pre-federation behaviour so
  // install.sh --check and the existing tests keep working. The loopback tunnel
  // makes remote requests look local, so we MUST require the token here and never
  // trust 127.0.0.1 (DEVELOPER.md: cross-network token insight).
  if (!FED.token) return true;
  const got = req.headers["x-bridge-token"];
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(FED.token);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/** True if the request's peer is the loopback interface. Used to lock down
 *  /link/reload on the main server (it must only be driven by a local caller —
 *  install.sh, tests — never through a tunnel). The main server is already bound
 *  to 127.0.0.1, so this is belt-and-suspenders, but it makes the intent explicit
 *  and survives a future rebind mistake. */
function isLoopback(req) {
  const a = req.socket?.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function pushThread(a, b, id) {
  const key = tkey(a, b);
  if (!threads.has(key)) threads.set(key, []);
  threads.get(key).push(id);
}

/** Merged roster: local sessions tagged "local" ∪ remote sessions tagged by node. */
function globalRoster() {
  const out = activeSessions().map((s) => ({ name: s.name, description: s.description, node: "local" }));
  if (FED.role === "hub") {
    for (const [node, sp] of spokes) {
      if (!sp.res) continue; // only live spokes
      for (const s of sp.sessions || []) {
        out.push({ name: s.name, description: s.description, node });
      }
    }
  } else if (FED.role === "spoke") {
    for (const s of remoteRoster) {
      out.push({ name: s.name, description: s.description, node: s.node });
    }
  }
  return out;
}

/**
 * Resolve a target name to local / remote / none.
 * Local-name-wins: a bare name that exists locally always routes locally; a
 * specific remote session is targeted as "name@node".
 */
function resolveTarget(to) {
  // Qualified "name@node" — explicit remote address.
  const at = to.lastIndexOf("@");
  if (at > 0) {
    const bareName = to.slice(0, at);
    // G6: node ids are sanitized (lowercased) at the source, so a qualified
    // "name@Node" target must be sanitized the same way or it never matches.
    const node = sanitizeNode(to.slice(at + 1));
    if (node === "local" || node === FED.node) {
      const sse = nameToSSE.get(bareName);
      if (sse && sseClients.has(sse)) return { kind: "local", sse, name: bareName };
      return { kind: "none" };
    }
    const remote = globalRoster().find((e) => e.name === bareName && e.node === node);
    if (remote) return { kind: "remote", node, name: bareName };
    // G3: a qualified target whose spoke is momentarily offline-but-known still
    // routes to that node, so the message queues and flushes on reconnect — the
    // same durability the bare-name path already has (lesson #25). Without this,
    // notify name@node to a briefly-down spoke was dropped while bare-name wasn't.
    if (FED.role === "hub") {
      const sp = spokes.get(node);
      if (sp && (sp.sessions || []).some((s) => s.name === bareName)) return { kind: "remote", node, name: bareName };
    }
    return { kind: "none" };
  }
  // Bare name — local wins.
  const sse = nameToSSE.get(to);
  if (sse && sseClients.has(sse)) return { kind: "local", sse, name: to };
  if (FED.role !== "standalone") {
    const remote = globalRoster().find((e) => e.name === to && e.node !== "local");
    if (remote) return { kind: "remote", node: remote.node, name: to };
    // Hub fallback: a name advertised by a spoke whose stream is momentarily down
    // (entry persists until the liveness sweep). Route to that node anyway so the
    // message queues and flushes when the spoke reconnects (lossless reconnect).
    if (FED.role === "hub") {
      for (const [node, sp] of spokes) {
        if ((sp.sessions || []).some((s) => s.name === to)) return { kind: "remote", node, name: to };
      }
    }
  }
  return { kind: "none" };
}

/**
 * Inject a forwarded message into THIS bridge's local store, shape-identical to a
 * locally-created one, so every existing delivery path (/pending, Stop hook,
 * idle-listener peek, check_inbox, blocking ask, get_thread, GC, migration) works
 * unchanged. Idempotent: replaying the same id is a no-op.
 *   fwd = { kind:"question"|"notice"|"answer", id, from, to, question?/content?, ts?, originNode? }
 */
function injectRemote(fwd) {
  // Allowlist kind + require the core fields are strings — a malformed/hostile
  // forward must not create a junk messages entry (S3 + the injectRemote
  // shape-validation note). Unknown kinds are dropped.
  if (!["question", "notice", "answer"].includes(fwd.kind)) return;
  if (typeof fwd.id !== "string" || !fwd.id) return;
  if (fwd.kind !== "answer" && (typeof fwd.from !== "string" || typeof fwd.to !== "string")) return;
  if (fwd.kind === "question") {
    if (messages.has(fwd.id)) return; // idempotent re-forward
    const msg = {
      id: fwd.id, from: fwd.from, to: fwd.to, question: fwd.question,
      answer: null, ts: fwd.ts ?? Date.now(), answeredAt: null,
      origin: { node: fwd.originNode },
    };
    messages.set(msg.id, msg);
    pushThread(fwd.from, fwd.to, msg.id);
    console.log(`${ts()} ⇄ injected remote question ${msg.id} ${fwd.from}@${fwd.originNode} → ${fwd.to}`);
  } else if (fwd.kind === "notice") {
    if (messages.has(fwd.id)) return; // idempotent
    // NO answer field — lesson #19: a notice with answer:null re-injects forever.
    const msg = {
      id: fwd.id, from: fwd.from, to: fwd.to, kind: "notice",
      content: fwd.content, delivered: false, ts: fwd.ts ?? Date.now(),
      origin: { node: fwd.originNode },
    };
    messages.set(msg.id, msg);
    pushThread(fwd.from, fwd.to, msg.id);
    console.log(`${ts()} ⇄ injected remote notice ${msg.id} ${fwd.from}@${fwd.originNode} → ${fwd.to}`);
  } else if (fwd.kind === "answer") {
    const msg = messages.get(fwd.id); // the original question, queued on this node
    if (msg && msg.answer === null) { // idempotent: already-answered is a no-op
      msg.answer = fwd.answer;
      msg.answeredAt = fwd.ts ?? Date.now();
      console.log(`${ts()} ⇄ injected remote answer for ${fwd.id} (${String(fwd.answer).length} chars)`);
    }
  }
}

/** Outbound JSON POST to the hub (spoke side). Always sends the token header. */
function hubPost(path, payload) {
  return new Promise((resolve) => {
    if (!FED.hubUrl || !FED.token) { resolve({ error: "not a spoke" }); return; }
    let u;
    try { u = new URL(path, FED.hubUrl); } catch { resolve({ error: "bad hub url" }); return; }
    const body = JSON.stringify(payload);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Bridge-Token": FED.token,
          "X-Bridge-Node": FED.node,
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data || "{}")); }
          catch { resolve({ status: res.statusCode }); }
        });
      }
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.on("timeout", () => { try { req.destroy(); } catch {} resolve({ error: "timeout" }); });
    try { req.write(body); req.end(); } catch (e) { resolve({ error: e.message }); }
  });
}

/**
 * Hub-side router for an inbound /link/forward from a spoke. Decides where the
 * message goes: a hub-local target → inject here; a question/notice for another
 * spoke → push to its stream (or queue); an answer → inject here if the asker is
 * hub-local (destNode is the hub / unset and the question is local), else push to
 * the owning spoke identified by destNode.
 */
function routeForward(payload) {
  try {
    if (payload.kind === "answer") {
      const dest = payload.destNode ? sanitizeNode(payload.destNode) : null;
      if (!dest || dest === FED.node) {
        injectRemote(payload); // asker is hub-local
      } else {
        const sp = spokes.get(dest);
        if (sp && sp.res && !sp.res.destroyed) {
          linkSend(sp, "forward", { kind: "answer", id: payload.id, answer: payload.answer, ts: payload.ts });
        }
        // If the asker's spoke is gone, the answer is dropped (asker timed out).
      }
      return;
    }
    // question | notice
    const target = resolveTarget(payload.to);
    if (target.kind === "local") {
      injectRemote(payload); // wakes the hub-local target via normal delivery
    } else if (target.kind === "remote") {
      relayForward(target.node, payload); // another spoke
    } else {
      // Unknown target on the hub: inject so it queues (30d TTL) and delivers if a
      // session by that name appears locally later (lesson #22 dead-letter caveat).
      injectRemote(payload);
    }
  } catch (e) {
    console.error(`${ts()} ✗ routeForward failed: ${e.message}`);
  }
}

/**
 * Route an answer back to the node where the asker lives (destNode).
 *  - Spoke: POST /link/forward to the hub (hub routes it home — possibly to
 *    another spoke). The payload carries destNode so the hub knows the asker.
 *  - Hub: if destNode is a spoke, push event:forward over that spoke's stream.
 */
function relayAnswer(destNode, payload) {
  try {
    const withDest = { ...payload, destNode };
    if (FED.role === "spoke") {
      hubPost("/link/forward", withDest); // fire-and-forget
    } else if (FED.role === "hub") {
      const sp = spokes.get(destNode);
      if (sp && sp.res && !sp.res.destroyed) {
        linkSend(sp, "forward", payload);
      }
    }
  } catch (e) {
    console.error(`${ts()} ✗ relayAnswer failed: ${e.message}`);
  }
}

/** Relay a question/notice toward its remote target. */
function relayForward(targetNode, payload) {
  try {
    if (FED.role === "spoke") {
      hubPost("/link/forward", payload);
    } else if (FED.role === "hub") {
      const sp = spokes.get(targetNode);
      if (sp && sp.res && !sp.res.destroyed) {
        linkSend(sp, "forward", payload);
      } else {
        // Target spoke offline: the message stays queued locally (30d TTL) and is
        // re-forwarded on reconnect via flushPendingForwards. Lesson #22: a stale
        // auto-generated remote name may never reconnect (dead-letter) — accepted.
        markPendingRelay(payload, targetNode);
      }
    }
  } catch (e) {
    console.error(`${ts()} ✗ relayForward failed: ${e.message}`);
  }
}

// ── Lossless reconnect bookkeeping (hub side) ────────────────────────────────
// Messages that couldn't be pushed to a spoke (offline) are remembered so they
// re-forward when that spoke's /link/stream reconnects. Reuses the durable
// `messages` store; this set just tracks which ids still need a push per node.
const pendingRelay = new Map(); // node → Set<msgId>

function markPendingRelay(payload, node) {
  if (!payload.id) return;
  if (!pendingRelay.has(node)) pendingRelay.set(node, new Set());
  pendingRelay.get(node).add(payload.id);
}

function pushForwardToSpoke(sp, m) {
  if (m.kind === "notice") {
    linkSend(sp, "forward", { kind: "notice", id: m.id, from: m.from, to: m.to, content: m.content, ts: m.ts, originNode: m.origin?.node ?? FED.node });
  } else {
    linkSend(sp, "forward", { kind: "question", id: m.id, from: m.from, to: m.to, question: m.question, ts: m.ts, originNode: m.origin?.node ?? FED.node });
  }
}

// Re-sync a (re)connected spoke: (1) drain the explicit relay queue, then (2)
// re-push any hub-known unanswered question / undelivered notice whose TARGET
// session lives on this node. (2) closes G4 — an in-flight message the spoke
// received and then lost to a crash was delivered (never queued in pendingRelay),
// so only a message-scan re-delivers it. injectRemote on the spoke is idempotent
// on id, so re-pushing a message the spoke still has is a harmless no-op.
function flushPendingForwards(node) {
  const sp = spokes.get(node);
  if (!sp || !sp.res || sp.res.destroyed) return;
  // (1) explicit relay queue
  const set = pendingRelay.get(node);
  if (set) {
    for (const id of [...set]) {
      const m = messages.get(id);
      if (m && !(m.kind === "notice" ? m.delivered : m.answer !== null)) pushForwardToSpoke(sp, m);
      set.delete(id);
    }
  }
  // (2) G4 in-flight recovery: re-push messages addressed to this node's sessions
  // that are still open (unanswered question / undelivered notice). Skip messages
  // that ORIGINATED on this node (don't echo them back to their source).
  const names = new Set((sp.sessions || []).map((s) => s.name));
  if (names.size) {
    for (const m of messages.values()) {
      if (m.origin?.node === node) continue;
      if (!names.has(m.to)) continue;
      if (m.kind === "notice" ? m.delivered : m.answer !== null) continue;
      pushForwardToSpoke(sp, m);
    }
  }
  console.log(`${ts()} ⇄ resynced spoke "${node}" (queue + in-flight)`);
}

/** Write an SSE event to a spoke's link stream; prune the spoke on write error. */
function linkSend(sp, event, data) {
  if (!sp.res || sp.res.destroyed) { sp.res = null; return false; }
  try {
    sp.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (e) {
    // Prune-on-write-error: a dead spoke leaves the roster fast (lesson #9).
    sp.res = null;
    console.log(`${ts()} ✗ link write failed for spoke; pruned stream`);
    return false;
  }
}

/** Broadcast the merged roster to every live spoke (hub side). */
function broadcastRoster() {
  if (FED.role !== "hub") return;
  const nodes = {};
  nodes[FED.node] = linkSessions();
  for (const [node, sp] of spokes) {
    if (sp.res) nodes[node] = sp.sessions || [];
  }
  for (const [, sp] of spokes) {
    if (sp.res) linkSend(sp, "roster", { nodes });
  }
}

/** Hub liveness sweep: prune spokes whose stream is dead or stale, then rebroadcast. */
function spokeSweep() {
  if (FED.role !== "hub") return;
  let changed = false;
  const now = Date.now();
  for (const [node, sp] of spokes) {
    const dead = !sp.res || sp.res.destroyed;
    const stale = now - (sp.lastSeen || 0) > SPOKE_STALE_MS;
    if (dead && stale) {
      spokes.delete(node);
      pendingRelay.delete(node);
      changed = true;
      console.log(`${ts()} ✗ spoke "${node}" pruned (dead/stale)`);
    }
  }
  if (changed) broadcastRoster();
}
setInterval(spokeSweep, SPOKE_SWEEP_MS);

// ── Spoke outbound link client ───────────────────────────────────────────────

function spokeAdvertise() {
  if (FED.role !== "spoke") return Promise.resolve();
  return hubPost("/link/register", { node: FED.node, sessions: linkSessions() }).then((r) => {
    if (r && Array.isArray(r.roster)) {
      remoteRoster = r.roster.filter((e) => e.node !== FED.node);
    }
    return r;
  });
}

// Propagate a LOCAL session-set change (a register or a disconnect) to peers so
// the merged roster stays fresh: a spoke re-advertises to its hub; a hub
// re-broadcasts to its spokes. Without this, a session that joins or leaves
// AFTER the link is established never reaches the cross-network roster — so a
// message addressed to it can't route. (Found by the live Mac↔VM test: the
// initial advertise only fired on link connect.)
function onLocalRosterChange() {
  if (FED.role === "spoke") spokeAdvertise().catch(() => {});
  else if (FED.role === "hub") broadcastRoster();
}

function scheduleSpokeReconnect() {
  if (FED.role !== "spoke") return;
  // The hub link is down: drop the remote roster so we don't advertise GHOST
  // remote sessions (G7). Otherwise resolveTarget would still resolve a now-
  // unreachable remote name, and a blocking ask to it would hang the full 5-min
  // deadline instead of failing fast with "not connected". Repopulated from the
  // /link/register response + roster broadcast on the next successful connect.
  if (remoteRoster.length) { remoteRoster = []; console.log(`${ts()} ⇄ hub link down — cleared remote roster (no ghosts)`); }
  if (spokeReconnectTimer) return;
  const delay = spokeReconnectDelay;
  spokeReconnectDelay = Math.min(spokeReconnectDelay * 2, 30000);
  spokeReconnectTimer = setTimeout(() => {
    spokeReconnectTimer = null;
    connectToHub();
  }, delay);
}

function teardownHubStream() {
  spokeGen++; // invalidate any in-flight stream callbacks
  try { if (hubStreamReq) hubStreamReq.destroy(); } catch {}
  try { if (hubStream) hubStream.destroy(); } catch {}
  hubStream = null;
  hubStreamReq = null;
  remoteRoster = []; // link torn down → no ghosts (G7)
  if (spokeReconnectTimer) { clearTimeout(spokeReconnectTimer); spokeReconnectTimer = null; }
  if (spokeHeartbeatTimer) { clearInterval(spokeHeartbeatTimer); spokeHeartbeatTimer = null; }
}

function connectToHub() {
  if (FED.role !== "spoke" || !FED.hubUrl || !FED.token) return;
  const myGen = ++spokeGen;
  let u;
  try { u = new URL("/link/stream", FED.hubUrl); } catch { return; }
  const mod = u.protocol === "https:" ? https : http;

  // Advertise our sessions first (also primes the hub's roster).
  spokeAdvertise();

  const req = mod.request(
    u,
    {
      method: "GET",
      headers: { "X-Bridge-Token": FED.token, "X-Bridge-Node": FED.node, Accept: "text/event-stream" },
    },
    (res) => {
      if (myGen !== spokeGen) { try { res.destroy(); } catch {} return; }
      if (res.statusCode !== 200) {
        console.log(`${ts()} ✗ hub link rejected (HTTP ${res.statusCode}) — retrying`);
        try { res.destroy(); } catch {}
        scheduleSpokeReconnect();
        return;
      }
      console.log(`${ts()} ⇄ linked to hub ${FED.hubUrl} as node "${FED.node}"`);
      spokeReconnectDelay = 1000; // reset backoff on success
      hubStream = res;
      try { res.socket?.setKeepAlive(true, 15000); } catch {}

      // Re-advertise + re-flush any unrelayed local outbound messages on (re)connect.
      flushSpokeOutbound();

      // Periodic heartbeat keeps the hub's lastSeen for this spoke fresh. Without
      // it, lastSeen only advances on message traffic, so an IDLE spoke is already
      // stale when it disconnects and the hub's 45s stale-sweep deletes its relay
      // queue within one 15s tick — dropping queued messages (the lossless-reconnect
      // guarantee). With a 25s heartbeat the sweep window counts from real
      // disconnect. Also doubles as the sub-100s SSE keepalive for the link path.
      if (spokeHeartbeatTimer) clearInterval(spokeHeartbeatTimer);
      spokeHeartbeatTimer = setInterval(() => {
        if (myGen !== spokeGen) { clearInterval(spokeHeartbeatTimer); spokeHeartbeatTimer = null; return; }
        hubPost("/link/heartbeat", { node: FED.node });
      }, SPOKE_HEARTBEAT_MS);

      let buf = "";
      let event = null;
      res.on("data", (chunk) => {
        if (myGen !== spokeGen) return;
        buf += chunk.toString();
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const block of parts) {
          event = null;
          let dataLine = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLine = line.slice(6);
            else if (line.startsWith(":")) { /* keepalive */ }
          }
          if (event === "roster" && dataLine) {
            try {
              const obj = JSON.parse(dataLine);
              const next = [];
              for (const [node, sess] of Object.entries(obj.nodes || {})) {
                if (node === FED.node) continue;
                for (const s of sess) next.push({ name: s.name, description: s.description, node });
              }
              remoteRoster = next;
            } catch (e) { console.error(`${ts()} ✗ bad roster event: ${e.message}`); }
          } else if (event === "forward" && dataLine) {
            try { injectRemote(JSON.parse(dataLine)); }
            catch (e) { console.error(`${ts()} ✗ bad forward event: ${e.message}`); }
          } else if (event === "close") {
            console.log(`${ts()} ⇄ hub closed the link`);
          }
        }
      });
      res.on("end", () => { if (myGen === spokeGen) { hubStream = null; console.log(`${ts()} ⇄ hub link ended — reconnecting`); scheduleSpokeReconnect(); } });
      res.on("error", () => { if (myGen === spokeGen) { hubStream = null; scheduleSpokeReconnect(); } });
    }
  );
  req.on("error", (e) => {
    if (myGen !== spokeGen) return;
    console.log(`${ts()} ✗ hub link error: ${e.message} — retrying`);
    scheduleSpokeReconnect();
  });
  hubStreamReq = req;
  try { req.end(); } catch (e) { scheduleSpokeReconnect(); }
}

/** Spoke: re-forward any local outbound messages still awaiting relay (reconnect flush). */
function flushSpokeOutbound() {
  if (FED.role !== "spoke") return;
  // Re-forward our locally-originated, still-pending questions and undelivered
  // notices addressed to remote targets. Idempotent on the hub (messages.has(id)).
  for (const m of messages.values()) {
    const originLocal = !m.origin || m.origin.node === FED.node;
    if (!originLocal) continue;
    const t = resolveTarget(m.to);
    if (t.kind !== "remote") continue;
    if (m.kind === "notice") {
      if (m.delivered) continue;
      hubPost("/link/forward", { kind: "notice", id: m.id, from: m.from, to: m.to, content: m.content, ts: m.ts, originNode: FED.node });
    } else {
      if (m.answer !== null) continue;
      hubPost("/link/forward", { kind: "question", id: m.id, from: m.from, to: m.to, question: m.question, ts: m.ts, originNode: FED.node });
    }
  }
}

/** Apply a freshly-loaded FED config: (re)start or tear down the spoke link, the
 *  hub fed listener, etc. A SPOKE makes only OUTBOUND connections and never binds
 *  the fed port; only a HUB runs the inbound fed listener. */
function applyFedConfig() {
  if (FED.role === "spoke") {
    teardownHubStream();
    connectToHub();
  } else {
    teardownHubStream();
    remoteRoster = [];
  }
  if (FED.role === "hub") {
    // Become reachable: bring up the loopback fed listener (the tunneled surface).
    startFedListener();
  } else {
    // No longer a hub: gracefully close spoke streams and tear down the fed port.
    for (const [, sp] of spokes) {
      if (sp.res && !sp.res.destroyed) {
        try { sp.res.write("event: close\ndata: hub stopped sharing\n\n"); sp.res.end(); } catch {}
      }
    }
    spokes.clear();
    pendingRelay.clear();
    stopFedListener();
  }
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
      "Reply to a pending question. If message_id is omitted and you have exactly one pending question, it auto-targets that one.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Target message ID. Optional if you have exactly one pending question." },
        answer: { type: "string", description: "Detailed, self-contained answer." },
      },
      required: ["answer"],
    },
  },
  {
    name: "notify",
    description:
      "Send a one-way NOTICE to another session — a fire-and-forget FYI that does NOT block and does NOT expect a reply. Use for status updates, heads-ups, and decisions the other agent should know but needn't answer (e.g. \"merged the auth PR, main is green\"). For a question you need answered, use ask instead; for shared state others pull on demand, use broadcast.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target session name" },
        content: { type: "string", description: "The message to deliver. Self-contained — the receiver won't ask follow-ups." },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "check_inbox",
    description: "Check for unanswered questions and undelivered one-way NOTICEs addressed to you. Call this instead of polling get_thread with every session name.",
    inputSchema: { type: "object", properties: {} },
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

  // S6: rate-limit the message-CREATING tools per source (reads + register/reply
  // are never limited). Bounds an accidental loop or a hostile local client.
  if ((name === "ask" || name === "notify" || name === "broadcast") && !rateOk(`sse:${sseId}`)) {
    return { error: `rate limit exceeded (max ${RATE_MAX} per ${Math.round(RATE_WINDOW_MS / 1000)}s) — slow down` };
  }

  switch (name) {
    case "register": {
      const { name: sName, claude_session_id } = args;
      // Validate the name before it pollutes nameToSSE / the roster / the .name
      // file (the broadcast({content:undefined}) crash-class lesson).
      if (typeof sName !== "string" || !sName.trim()) {
        return { error: "register requires a non-empty string 'name'." };
      }
      // Coerce a non-string description to "" so it can't break roster JSON or
      // propagate a junk value across the federation roster.
      const description = typeof args.description === "string" ? args.description : "";
      const existing = nameToSSE.get(sName);
      if (existing && existing !== sseId && sseClients.has(existing)) {
        return { error: `Name "${sName}" is taken by another active session.` };
      }
      // Reconnect cleanup: if this claude_session_id was previously registered on a
      // different SSE connection (reconnect scenario), close the old connection and
      // retire the old name. This prevents ghost sessions from lingering.
      if (claude_session_id) {
        const oldName = claudeIdToName.get(claude_session_id);
        if (oldName && oldName !== sName) {
          const oldSSE = nameToSSE.get(oldName);
          if (oldSSE && oldSSE !== sseId) {
            // Close the stale SSE connection
            const oldRes = sseClients.get(oldSSE);
            if (oldRes && !oldRes.destroyed) oldRes.end();
            sseClients.delete(oldSSE);
            sessions.delete(oldSSE);
            nameToSSE.delete(oldName);
            // Migrate pending asks AND undelivered notices from old name to new name
            for (const m of messages.values()) {
              if (m.to === oldName && (m.answer === null || (m.kind === "notice" && !m.delivered))) {
                m.to = sName;
              }
            }
            console.log(`${ts()} ↪ reconnect: "${oldName}" → "${sName}" (old SSE closed, pending asks + notices migrated)`);
          }
        }
      }

      // Rename cleanup: if this sseId previously held a different name, retire it
      // so future ask(to="<old-name>") fails fast instead of dangling forever.
      const prev = sessions.get(sseId);
      if (prev && prev.name !== sName && nameToSSE.get(prev.name) === sseId) {
        nameToSSE.delete(prev.name);
        for (const m of messages.values()) {
          if (m.to === prev.name && (m.answer === null || (m.kind === "notice" && !m.delivered))) {
            m.to = sName;
          }
        }
        console.log(`${ts()} ↪ rename: "${prev.name}" → "${sName}" (old name retired, pending asks + notices migrated)`);
      }
      sessions.set(sseId, { name: sName, description, connectedAt: Date.now() });
      nameToSSE.set(sName, sseId);

      // Persist claude_session_id → name so the hook can resolve canonical name
      if (claude_session_id) {
        claudeIdToName.set(claude_session_id, sName);
        try {
          const namePath = `/tmp/claude-bridge-${claude_session_id}.name`;
          fs.writeFileSync(namePath, sName);
        } catch (e) {
          console.log(`${ts()} ⚠ could not write name file: ${e.message}`);
        }
      }

      console.log(`${ts()} ✓ registered: ${sName} — ${description}${claude_session_id ? ` (cid:${claude_session_id.slice(0, 8)})` : ""}`);
      onLocalRosterChange();
      return { ok: true, your_name: sName, active_sessions: activeSessions() };
    }

    case "list_sessions":
      return { sessions: FED.role === "standalone" ? activeSessions() : globalRoster() };

    case "ask": {
      if (!myName) return { error: "Call register() first." };
      const { to, question } = args;
      const target = resolveTarget(to);
      if (target.kind === "none") {
        const roster = (FED.role === "standalone" ? activeSessions().map((s) => s.name)
          : globalRoster().map((e) => (e.node === "local" ? e.name : `${e.name}@${e.node}`)));
        return { error: `"${to}" not connected. Active: ${roster.join(", ") || "(none)"}` };
      }

      // Dedup check (keyed on the bare name we resolved)
      const key = tkey(myName, target.name);
      for (const msgId of threads.get(key) || []) {
        const m = messages.get(msgId);
        if (m?.answer && m.kind !== "notice" && norm(m.question) === norm(question)) {
          console.log(`${ts()} ↩ dedup hit (${question.length} chars) → ${m.id}`);
          return { cached: true, message_id: m.id, question: m.question, answer: m.answer, note: "Already asked and answered. Previous answer returned." };
        }
      }

      // Queue locally (the poll loop watches this object regardless of where the
      // target lives — the answer lands on it via injectRemote for remote targets).
      const id = crypto.randomUUID(); // full 122-bit id: unguessable, no pre-claim/collision vector (S3)
      const msg = { id, from: myName, to: target.name, question, answer: null, ts: Date.now(), answeredAt: null, origin: { node: FED.node } };
      messages.set(id, msg);
      pushThread(myName, target.name, id);

      if (target.kind === "remote") {
        // Relay toward the owning node; the answer routes home via relayAnswer.
        console.log(`${ts()} ? ${myName} → ${target.name}@${target.node} (remote, ${question.length} chars) ${id}`);
        relayForward(target.node, { kind: "question", id, from: myName, to: target.name, question, ts: msg.ts, originNode: FED.node });
      } else {
        console.log(`${ts()} ? ${myName} → ${target.name} (${question.length} chars) ${id}`);
      }

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
      let msg;
      if (args.message_id) {
        msg = messages.get(args.message_id);
        if (!msg) return { error: `No message "${args.message_id}"` };
      } else {
        if (!myName) return { error: "Call register() first." };
        const pending = getPendingFor(myName);
        if (pending.length === 0) return { error: "No pending questions to reply to." };
        if (pending.length > 1) return { error: `${pending.length} pending questions — specify message_id. Use check_inbox() to see them.`, pending: pending.map((m) => ({ id: m.id, from: m.from, question: m.question.slice(0, 100) })) };
        msg = pending[0];
      }
      if (msg.answer !== null) return { error: "Already answered.", existing: msg.answer };
      // Validate BEFORE mutating: a non-string answer assigned here would set
      // answer to a non-null, non-string value — un-pending the question (it's no
      // longer === null) and shipping garbage to the asker while the length-log
      // below throws. Guard up front.
      if (typeof args.answer !== "string") return { error: "reply requires a string 'answer'." };
      msg.answer = args.answer;
      msg.answeredAt = Date.now();
      console.log(`${ts()} ← reply to ${msg.id} (${args.answer.length} chars)`);
      // If the question originated on another node, route the answer home.
      if (msg.origin && msg.origin.node && msg.origin.node !== FED.node) {
        relayAnswer(msg.origin.node, { kind: "answer", id: msg.id, answer: msg.answer, ts: msg.answeredAt });
      }
      return { ok: true, message_id: msg.id };
    }

    case "notify": {
      if (!myName) return { error: "Call register() first." };
      const { to, content } = args;
      if (typeof to !== "string" || typeof content !== "string") {
        return { error: "notify requires { to: string, content: string }" };
      }
      const target = resolveTarget(to);
      const id = crypto.randomUUID(); // full 122-bit id: unguessable, no pre-claim/collision vector (S3)
      // NO answer field — lesson #19.
      const msg = { id, from: myName, to: target.name ?? to, kind: "notice", content, delivered: false, ts: Date.now(), origin: { node: FED.node } };
      messages.set(id, msg);
      pushThread(myName, msg.to, id);

      if (target.kind === "remote") {
        console.log(`${ts()} 📨 ${myName} → ${target.name}@${target.node} (remote notice, ${content.length} chars) ${id}`);
        relayForward(target.node, { kind: "notice", id, from: myName, to: target.name, content, ts: msg.ts, originNode: FED.node });
        return { ok: true, message_id: id, to: `${target.name}@${target.node}`, target_online: true };
      }

      const online = target.kind === "local";
      console.log(`${ts()} 📨 ${myName} → ${msg.to} (notice, ${content.length} chars) ${id}`);
      const result = { ok: true, message_id: id, to: msg.to, target_online: online };
      if (!online) {
        const roster = (FED.role === "standalone" ? activeSessions().map((s) => s.name)
          : globalRoster().map((e) => (e.node === "local" ? e.name : `${e.name}@${e.node}`)));
        result.note = `"${to}" is not currently connected — the NOTICE is queued and delivers when a session named "${to}" next polls (within the 30-day TTL). Active: ${roster.join(", ") || "(none)"}`;
      }
      return result;
    }

    case "check_inbox": {
      if (!myName) return { error: "Call register() first." };
      const pending = getPendingFor(myName);
      // Undelivered one-way notices — return them and mark delivered (this is the
      // delivery path for hookless clients like the Desktop app).
      const notices = [...messages.values()].filter((m) => m.kind === "notice" && m.to === myName && !m.delivered);
      for (const n of notices) { n.delivered = true; n.deliveredAt = Date.now(); }
      return {
        session: myName,
        pending_count: pending.length,
        questions: pending.map((m) => ({
          id: m.id,
          from: m.from,
          question: m.question,
          asked_at: new Date(m.ts).toISOString(),
        })),
        notices: notices.map((m) => ({
          id: m.id,
          from: m.from,
          content: m.content,
          sent_at: new Date(m.ts).toISOString(),
        })),
      };
    }

    case "get_thread": {
      if (!myName) return { error: "Call register() first." };
      const history = getThread(myName, args.with_session);
      return { thread_with: args.with_session, count: history.length, messages: history };
    }

    case "broadcast": {
      if (!myName) return { error: "Call register() first." };
      if (typeof args.content !== "string") return { error: "broadcast requires { content: string, append?: boolean }" };
      const cur = scratchpad.get(myName) || "";
      const next = args.append ? cur + "\n" + args.content : args.content;
      scratchpad.set(myName, next);
      return { ok: true, session: myName, length: next.length };
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

// ─── Federation link surface (served ONLY on the fed listener) ───────────────
//
// The ONLY thing the cloudflared tunnel exposes is the fed listener (hub mode),
// and the ONLY paths it serves are the token-gated /link/* surface plus the
// content-free /health/ping. Everything else → 404. This is what closes the
// "whole-port tunnel" hole: a remote caller can never reach /sse, /message,
// /pending, /whoami or the full /health through the tunnel because they don't
// exist on this listener.
async function handleLinkRequest(req, res, url) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token, X-Bridge-Node");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Content-free liveness — ungated, leaks no session names / roster. Mirrors the
  // main server's /health/ping so a remote spoke (or a probe) can confirm the hub
  // is reachable through the tunnel without the token.
  if (req.method === "GET" && url.pathname === "/health/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", role: FED.role, node: FED.node, sharing: !!FED.token }));
    return;
  }

  if (!url.pathname.startsWith("/link/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // /link/reload is NOT exposed here — config hot-reload is a loopback-only
  // operation on the main server. Reject it explicitly on the tunneled surface.
  if (url.pathname === "/link/reload") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // No-token guardrail: you cannot be reachable as a hub without a token.
  if (!FED.token) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "federation disabled: no token" })); return; }
  if (!tokenOk(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }

  // GET /link/stream — hub → spoke SSE
  if (req.method === "GET" && url.pathname === "/link/stream") {
    if (FED.role !== "hub") { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not a hub" })); return; }
    const node = sanitizeNode(req.headers["x-bridge-node"] || "");
    if (!node) { res.writeHead(400); res.end("missing X-Bridge-Node"); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    try { req.socket.setKeepAlive(true, 15000); } catch {}
    const existing = spokes.get(node);
    // Close a stale stream for the same node (ghost avoidance, lesson #9).
    if (existing && existing.res && existing.res !== res && !existing.res.destroyed) {
      try { existing.res.end(); } catch {}
    }
    spokes.set(node, { res, sessions: existing?.sessions || [], lastSeen: Date.now() });
    console.log(`${ts()} ⇄ spoke "${node}" stream connected`);
    broadcastRoster();
    flushPendingForwards(node);

    const ka = setInterval(() => {
      const sp = spokes.get(node);
      if (!sp || !sp.res || sp.res.destroyed) { clearInterval(ka); return; }
      try { sp.res.write(`: ping ${Date.now()}\n\n`); } catch { sp.res = null; clearInterval(ka); }
    }, 25000);

    req.on("close", () => {
      clearInterval(ka);
      const sp = spokes.get(node);
      if (sp && sp.res === res) { sp.res = null; }
      console.log(`${ts()} ✗ spoke "${node}" stream closed`);
      broadcastRoster();
    });
    return;
  }

  // POST /link/* — JSON bodies
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" }); res.end(JSON.stringify({ error: "payload too large" })); return; }
    }
    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "bad json" })); return; }

    try {
      if (url.pathname === "/link/register") {
        if (FED.role !== "hub") { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "not a hub" })); return; }
        const node = sanitizeNode(payload.node || req.headers["x-bridge-node"] || "");
        if (!node) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing node" })); return; }
        const existing = spokes.get(node);
        // S4: bound the node count (reject NEW nodes past the cap) and the
        // advertised-sessions-per-node, so a hostile/buggy peer can't bloat the
        // roster + memory. A node already known can always re-advertise.
        if (!existing && spokes.size >= MAX_SPOKE_NODES) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `too many federated nodes (max ${MAX_SPOKE_NODES})` }));
          return;
        }
        let sess = Array.isArray(payload.sessions) ? payload.sessions : [];
        if (sess.length > MAX_SESSIONS_PER_NODE) sess = sess.slice(0, MAX_SESSIONS_PER_NODE);
        spokes.set(node, { res: existing?.res || null, sessions: sess, lastSeen: Date.now() });
        console.log(`${ts()} ⇄ spoke "${node}" registered (${sess.length} sessions)`);
        broadcastRoster();
        // Re-sync now that this node's session list is known — covers the race
        // where /link/register lands AFTER /link/stream connected (so the
        // stream-connect resync saw an empty session list). No-op if no stream.
        flushPendingForwards(node);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, node: FED.node, roster: globalRoster() }));
        return;
      }
      if (url.pathname === "/link/forward") {
        // A spoke is forwarding a message toward its destination node.
        const node = sanitizeNode(payload.originNode || req.headers["x-bridge-node"] || "");
        const sp = spokes.get(node);
        if (sp) sp.lastSeen = Date.now();
        // S6: bound a hostile/looping spoke flooding the hub with forwards. Legit
        // traffic is already bounded by the source session's executeTool limit; a
        // reconnect flush stays well under the cap.
        if (!rateOk(`node:${node}`)) { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "rate limit exceeded" })); return; }
        routeForward(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/link/heartbeat") {
        const node = sanitizeNode(payload.node || req.headers["x-bridge-node"] || "");
        const sp = spokes.get(node);
        if (sp) sp.lastSeen = Date.now();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, roster: globalRoster() }));
        return;
      }
      if (url.pathname === "/link/unregister") {
        const node = sanitizeNode(payload.node || req.headers["x-bridge-node"] || "");
        const sp = spokes.get(node);
        if (sp && sp.res && !sp.res.destroyed) { try { sp.res.end(); } catch {} }
        spokes.delete(node);
        pendingRelay.delete(node);
        console.log(`${ts()} ⇄ spoke "${node}" unregistered (graceful --unlink)`);
        broadcastRoster();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    } catch (e) {
      console.error(`${ts()} ✗ /link handler threw: ${e.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unknown link endpoint" }));
}

// ── Fed listener lifecycle (hub mode only) ───────────────────────────────────
// A SECOND http server bound to 127.0.0.1:FED_PORT. Brought up by applyFedConfig
// when this node becomes a hub; closed when it leaves hub mode (standalone/spoke
// never bind it — a spoke makes only OUTBOUND connections). Shares the process's
// in-memory state (same module scope). Same EADDRINUSE-fatal + graceful-shutdown
// treatment as the main server (lessons #7, #23b).
let fedServer = null;

function startFedListener() {
  if (fedServer) return; // already up
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${FED_PORT}`);
    Promise.resolve(handleLinkRequest(req, res, u)).catch((e) => {
      console.error(`${ts()} ✗ fed handler threw: ${e.message}`);
      try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "internal error" })); } catch {}
    });
  });
  srv.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`${ts()} ✗ fed port ${FED_PORT} already in use — exiting.`);
      process.exit(1);
    }
    console.error(`${ts()} ✗ fed server error: ${err.message}`);
    process.exit(1);
  });
  fedServer = srv;
  srv.listen(FED_PORT, FED_BIND, () => {
    console.log(`${ts()} ⇄ fed listener up on http://${FED_BIND}:${FED_PORT} (link surface${FED_BIND === "127.0.0.1" ? "; tunnel points here" : "; DIRECT/exposed — token-gated, cleartext unless TLS-fronted"})`);
  });
}

function stopFedListener() {
  if (!fedServer) return;
  const srv = fedServer;
  fedServer = null;
  try { srv.close(); } catch {}
  console.log(`${ts()} ⇄ fed listener stopped`);
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
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: endpoint\ndata: http://localhost:${PORT}/message?session=${sid}\n\n`);
    // TCP keepalive tightens ghost de-merge: a dead client's socket errors faster
    // than the 30d TTL, so its name frees up within tens of seconds (lesson #9).
    try { req.socket.setKeepAlive(true, 15000); } catch {}
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
      onLocalRosterChange();
    });
    console.log(`${ts()} ⚡ SSE connected: ${sid}`);
    return;
  }

  // ── JSON-RPC messages (MCP) ───────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/message") {
    const sid = url.searchParams.get("session");
    if (!sid) { res.writeHead(400); res.end("missing session"); return; }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { res.writeHead(413, { "Connection": "close" }); res.end("payload too large"); return; }
    }
    let rpc;
    try { rpc = JSON.parse(body); } catch { res.writeHead(400); res.end("bad json"); return; }

    if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }

    let result;
    const isBlocking = rpc.method === "tools/call" && rpc.params?.name === "ask";

    switch (rpc.method) {
      case "initialize":
        result = { protocolVersion: "2024-11-05", serverInfo: { name: "claude-bridge", version: "2.3.0" }, capabilities: { tools: {} } };
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const { name: tn, arguments: ta } = rpc.params;
        if (isBlocking) {
          // For ask: return HTTP 202 immediately, send MCP response via SSE when ready
          res.writeHead(202); res.end();
          let tr;
          try { tr = await executeTool(sid, tn, ta ?? {}); }
          catch (err) { tr = { error: `tool '${tn}' threw: ${err.message}` }; console.error(`[bridge] tool '${tn}' threw:`, err); }
          sendSSE(sid, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(tr, null, 2) }] } });
          return;
        }
        let tr;
        try { tr = await executeTool(sid, tn, ta ?? {}); }
        catch (err) { tr = { error: `tool '${tn}' threw: ${err.message}` }; console.error(`[bridge] tool '${tn}' threw:`, err); }
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
    // peek = render without consuming. The idle-listener monitor peeks (it only
    // needs to detect "something new" to wake the agent); real delivery — and the
    // mark-delivered for one-way notices — happens via the PostToolUse hook
    // injection or check_inbox, where the content actually reaches the agent.
    const peek = url.searchParams.get("peek");

    const pending = [...messages.values()].filter((m) => m.to === session && m.kind !== "notice" && m.answer === null);
    const notices = [...messages.values()].filter((m) => m.to === session && m.kind === "notice" && !m.delivered);
    if (pending.length === 0 && notices.length === 0) { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(""); return; }

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

    // One-way NOTICEs — delivered exactly once, then marked delivered so they
    // never re-inject. The `id:` line lets the idle-listener dedupe; "NOTICE from"
    // is what its grep matches to wake a dormant session.
    for (const msg of notices) {
      const fromInfo = [...sessions.values()].find((s) => s.name === msg.from);

      out += `\n${"═".repeat(60)}\n`;
      out += `📨 NOTICE from "${msg.from}"`;
      if (fromInfo?.description) out += ` (${fromInfo.description})`;
      out += `\n${"═".repeat(60)}\n`;
      out += `id: ${msg.id}\n`;
      out += `${msg.content}\n\n`;
      out += `(FYI — no reply needed. This is a one-way message; take it in and continue.)\n`;
      out += `${"═".repeat(60)}\n`;

      // Only a non-peek read consumes the notice. A peeking idle-listener must
      // leave it undelivered so the woken agent can still read it via check_inbox.
      if (!peek) {
        msg.delivered = true;
        msg.deliveredAt = Date.now();
      }
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

  // ── GET /health/ping — UNGATED liveness (no session names) ─────────────
  // Always open, even when sharing is on, so install.sh --check and the test
  // health() helper can probe liveness without the token. Leaks no roster.
  if (req.method === "GET" && url.pathname === "/health/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", role: FED.role, node: FED.node, sharing: !!FED.token }));
    return;
  }

  // ── POST /link/reload — loopback-only hot-reload of federation config ──
  // Re-reads the dotfiles so --share/--join can flip a RUNNING bridge into
  // hub/spoke mode WITHOUT a restart (a restart drops every SSE client and can
  // kill the calling session — lesson #23a). Lives on the MAIN (loopback-only)
  // server, NOT the fed listener — it must never be tunneled. Defense-in-depth:
  // restricted to a loopback peer AND token-gated when a token is configured.
  if (req.method === "POST" && url.pathname === "/link/reload") {
    if (!isLoopback(req)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "forbidden: loopback only" })); return; }
    if (FED.token && !tokenOk(req)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    try {
      loadFedConfig();
      applyFedConfig();
      console.log(`${ts()} ⇄ federation reloaded: role=${FED.role} node=${FED.node}${FED.hubUrl ? ` hub=${FED.hubUrl}` : ""}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: FED.role, node: FED.node, sharing: !!FED.token }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /link/* — NOT served on the main (loopback) server ──────────────────
  // The federation link surface lives ONLY on the fed listener (hub mode), which
  // is the sole thing tunneled. Serving /link/* here would mean a tunnel that
  // (mis)pointed at the main port could reach the link surface; more importantly
  // the security tests assert the main port returns 404 for /link/*.
  if (url.pathname.startsWith("/link/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // ── GET /health ───────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/health") {
    // Gated when sharing is on (don't leak session names through the tunnel).
    // Standalone keeps it open — preserves install.sh --check + existing tests.
    if (FED.token && !tokenOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      role: FED.role,
      node: FED.node,
      sessions: FED.role === "standalone" ? activeSessions() : globalRoster(),
      pending: [...messages.values()].filter((m) => m.kind !== "notice" && !m.answer).length,
      answered: [...messages.values()].filter((m) => m.answer).length,
      notices: [...messages.values()].filter((m) => m.kind === "notice").length,
    }));
    return;
  }

  res.writeHead(404); res.end("not found");
});

process.on("uncaughtException", (err) => { console.error("[bridge] uncaught exception (kept running):", err); });
process.on("unhandledRejection", (err) => { console.error("[bridge] unhandled rejection (kept running):", err); });

// ─── PID file ──────────────────────────────────────────────────────────────
const PID_FILE = "/tmp/claude-bridge.pid";

function writePid() {
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// Graceful shutdown: close SSE connections cleanly so MCP clients don't crash
function shutdown(signal) {
  console.log(`\n[bridge] ${signal} received, closing ${sseClients.size} SSE connections...`);
  for (const [id, res] of sseClients) {
    if (!res.destroyed) {
      try { res.write("event: close\ndata: bridge shutting down\n\n"); } catch {}
      try { res.end(); } catch {}
    }
  }
  sseClients.clear();
  // Tear down federation: close spoke streams (hub) + the outbound hub link (spoke).
  for (const [, sp] of spokes) {
    if (sp.res && !sp.res.destroyed) {
      try { sp.res.write("event: close\ndata: bridge shutting down\n\n"); } catch {}
      try { sp.res.end(); } catch {}
    }
  }
  spokes.clear();
  teardownHubStream();
  stopFedListener();
  removePid();
  server.close(() => {
    console.log("[bridge] server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A startup bind failure (port already in use) is FATAL — exit instead of
// letting the catch-all uncaughtException handler swallow it. Without this, an
// EADDRINUSE leaves a headless process that never binds and never exits (kept
// alive by the keepalive/gc intervals) — the 17-day-orphan leak. See DEVELOPER.md.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`${ts()} ✗ port ${PORT} already in use — another bridge is running. Exiting.`);
    process.exit(1);
  }
  console.error(`${ts()} ✗ server error: ${err.message}`);
  process.exit(1);
});

// Bind the MAIN server to loopback ONLY. It serves every LOCAL route (/sse,
// /message, /pending, /whoami, /health, /health/ping, /link/reload) and must
// NEVER be tunneled or reachable from the LAN. The tunnel exposes the separate
// fed listener (127.0.0.1:FED_PORT, hub mode) instead. See DEVELOPER.md.
server.listen(PORT, "127.0.0.1", () => {
  writePid();
  // Load federation config from disk and bring up the link if we're a hub/spoke.
  try { loadFedConfig(); applyFedConfig(); } catch (e) { console.error(`${ts()} ✗ fed config load failed: ${e.message}`); }
  console.log(`\n${"═".repeat(42)}`);
  console.log(`  claude-bridge v2.7.0`);
  console.log(`  PID:     ${process.pid}`);
  console.log(`  SSE:     http://127.0.0.1:${PORT}/sse`);
  console.log(`  Health:  http://127.0.0.1:${PORT}/health`);
  console.log(`  Fed:     role=${FED.role} node=${FED.node}${FED.token ? ` (sharing on; link surface on 127.0.0.1:${FED_PORT})` : ""}`);
  console.log(`${"═".repeat(42)}\n`);
});
