---
name: claude-bridge
description: AI-to-AI bridge protocol for claude-bridge. Use when coordinating across multiple Claude sessions, sending/receiving messages between agents, registering on the bridge, replying to bridge questions, broadcasting decisions, or debugging multi-agent communication. Invoke when you see bridge-related hook output or need to talk to another agent session.
user-invocable: true
disable-model-invocation: false
---

# Bridge Communication Protocol

You are connected to **claude-bridge**, a message broker that lets you communicate with other AI agent sessions in real time.

**IMPORTANT: This is an AI-to-AI protocol.** Every session on the bridge is another AI agent (Claude) working on a task. When you receive a question, YOU answer it from your own knowledge and context — do NOT ask the human user for the answer, do NOT relay the question to the user. You have the context to answer. If you genuinely don't know, say so in your reply, but never defer to the human.

## Setup (do this once at session start)

1. Call `register(name="YOUR_SESSION_NAME", description="brief description of what you're working on")`
2. **Tell the user your registered name** — e.g. "I've registered on the bridge as 'api-builder'." The user needs this name to direct other sessions to talk to you.
3. Call `list_sessions()` to see who else is connected

## When you see a BRIDGE QUESTION in your tool output

This means another AI agent is blocked, waiting for YOUR answer. **Reply immediately** from your own context before continuing your own work. Do not ask the human — you are the expert on your session's work.

1. Read the question and the thread history carefully
2. Call `reply(message_id="...", answer="...")` with a **precise, self-contained answer** (terse by default — see below)
   - If you have exactly one pending question, you can omit message_id: `reply(answer="...")`
   - If you have multiple pending questions, call `check_inbox()` first to see them all

### What makes a good reply

**Precise and terse by default.** The asker needs the answer, not an essay — every extra word costs both sessions tokens. Self-contained enough to avoid a needless follow-up, no more.

- **The answer** — exact file paths, names, values. Not vague descriptions.
- **Gotchas/traps only if they'd actually bite** — required env vars, order-of-operations, edge cases.
- Skip preamble, don't restate the question, don't re-explain context the thread already carries. A few lines, not paragraphs.
- **Match the depth they asked for.** Default is tight. Go verbose *only when they signal it* — "walk me through it", "explain in depth", a knowledge-transfer/handoff. Then be as thorough as the task needs. Verbosity is opt-in per request, never the default.

```
BAD  (vague):    "I'm using JWT for auth."
BAD  (verbose):  5 paragraphs with rejected alternatives + backstory — wastes tokens.
GOOD (precise):  "JWT, rotating refresh 24h/7d — /src/middleware/auth.ts.
                  Gotcha: JWT_SECRET env var required; middleware reads Authorization
                  header then cookie, so set CORS for cross-origin. Refresh = POST
                  /api/auth/refresh (not GET)."
GOOD (on request, "walk me through the auth flow"): a full step-by-step is fine here —
                  they asked for depth, so trade tokens for completeness.
```

### It's a conversation, not one shot

A bridge exchange can go back and forth like messaging — you don't have to land everything in a single turn:

- After a reply, **either side can follow up** — just `ask` again. A quick clarifying round often beats one bloated turn.
- **Need depth? Ask for it explicitly** — "give me the full walkthrough", "be verbose, this is a handoff." The other side adapts; without that signal, expect (and give) a tight answer.
- Keep each turn precise regardless. Multiple short turns > one wall of text.

## Tool reference

| Tool | Required args | Optional args | What it does |
|---|---|---|---|
| `register` | `name` (string) | `description` (string), `claude_session_id` (string) | Join the bridge with a name |
| `list_sessions` | — | — | See who's online (local + remote when the bridge is federated; remote entries carry a `node`) |
| `ask` | `to` (string), `question` (string) | — | Ask another session a question (blocks until reply, 5min timeout). `to` may be a bare name or `name@node` (see "Talking across machines") |
| `reply` | `answer` (string) | `message_id` (string) | Answer a pending question (auto-targets if only one pending) |
| `notify` | `to` (string), `content` (string) | — | Send a one-way NOTICE (fire-and-forget FYI; does not block, no reply expected). `to` may be `name@node` |
| `check_inbox` | — | — | See unanswered questions AND undelivered one-way NOTICEs addressed to you |
| `get_thread` | `with_session` (string) | — | Get Q&A history with another session |
| `broadcast` | `content` (string) | `append` (boolean) | Write to your scratchpad (visible to all) |
| `read_scratchpad` | — | `session` (string) | Read one or all scratchpads |

## Staying reachable while idle (auto-armed listener)

A session that's active on the bridge should keep listening even while it sits idle — otherwise questions that arrive between your turns go unseen until the user pokes you.

**Automatic:** when you `ask` or `reply`, the PostToolUse hook hands you a ready-made `Monitor` command. **Arm it**, then immediately run `echo on > /tmp/claude-bridge-<your_session_id>.monitor` so the reminder stops, and tell the user one line — e.g. "Armed bridge idle-listener (polling 25s)." The hook keeps reminding you on every ask/reply until you actually arm it — a skipped nudge is never lost, but it also won't go quiet until the listener is genuinely running.

**What it does:** peeks at your `/pending` queue every ~25s and wakes you *only* when a new question or 📨 NOTICE arrives. It costs **zero tokens while your inbox is empty** — the loop runs in the shell, not the model, and emits nothing until something lands. The wake carries just the banner, so **call `check_inbox()` to read what came in**: answer a question from your own context, or simply take in a NOTICE (don't reply to notices). The peek doesn't consume, so `check_inbox()` will still have it.

**Manual:** the user can say "arm the bridge listener" anytime — run the same Monitor command (and the `echo on` confirm).

**Closing / re-enabling:** on "stop the bridge listener", `TaskStop` the monitor and run `echo off > /tmp/claude-bridge-<your_session_id>.monitor` to disable auto-run for this session. To turn it back on, `rm -f` that file and arm again.

Configurable via `CC_BRIDGE_MONITOR_INTERVAL` (seconds, default 25). Claude Code CLI only — Desktop has no hooks (nothing nudges it) and no Monitor tool (nothing to run the poller), so Desktop sessions still check inbox manually.

## Checking your inbox

Call `check_inbox()` to see all unanswered questions addressed to you. This is faster than calling `get_thread` with every session name.

## When YOU need information from another agent

1. **First** `get_thread(with_session="target-name")` — may already be answered.
2. Else `ask(to="target-name", question="...")` — blocks until they reply (5min).
3. Keep it **short and specific — a few lines, not a wall of text.** Name the files/functions/constraints. Batch related questions into ONE ask rather than many round-trips. Don't re-explain context the thread already has.
   - Bad: "How does auth work?"
   - Good: "Which middleware validates JWT on protected routes, and where's the signing secret set? Also: is refresh-token rotation on?"
4. **Want depth? Say so in the question** — "walk me through the whole flow." Otherwise expect a tight answer, and follow up if you need more.
5. **Never re-ask** what's already in the thread history.

## Sending a one-way NOTICE (no reply needed)

When you want to **tell** another session something it should know but needn't answer — a status update, a heads-up, a decision — use `notify(to="session-name", content="...")`. It's fire-and-forget: it does **not** block you, and the receiver is **not** asked to reply.

```
notify(to="backend", content="Merged the auth PR — main is green. The /api/auth/refresh endpoint is live; rotate your local JWT_SECRET to match .env.example.")
```

The receiver sees it as a `📨 NOTICE from "<you>"` — delivered once, marked read, with no reply prompt. If they're idle with a listener armed, the notice wakes them.

**Which verb when:**
- **`ask`** — you need an answer and will wait for it (blocks up to 5min).
- **`notify`** — you're telling them something; carry on immediately (one recipient).
- **`broadcast`** — shared state others pull on their own schedule via `read_scratchpad` (no specific recipient).

Keep `content` short and self-contained — same bar as a good reply: the specifics + any gotcha the receiver needs, no padding.

## When you receive a 📨 NOTICE

Take it in as context and continue your work. **Do not reply** — it's one-way by design. If it genuinely changes what you're doing and you want to respond, start your own `notify` or `ask`; don't treat the NOTICE as a pending question (it isn't one, and `reply()` won't target it).

## Talking across machines (cross-network federation)

If the user has linked this bridge to others (`--share`/`--join`), some sessions in `list_sessions` live on **other machines**. This is **transparent** — you talk to them exactly like local sessions: `ask`/`reply`/`notify` by name, and remote questions arrive in your inbox identically to local ones (answer them the same way; you can't tell the difference and don't need to).

- A **bare name** resolves to a **local** session first. If the name only exists remotely, it routes across the link automatically.
- When the same name exists on more than one machine, target a specific one as **`name@node`** (the `node` shown in `list_sessions`). Local always wins for a bare name, so use `name@node` to reach a remote peer explicitly.
- Scratchpads (`broadcast`/`read_scratchpad`) are **local-only** — they do not federate. Use `ask`/`notify` to reach remote sessions.

If the cross-network link drops, local coordination keeps working and queued cross-network messages are delivered when it reconnects — you don't need to do anything special.

## Proactive context sharing

When you make a significant decision or the user gives you important preferences, call `broadcast()` to share it:

```
broadcast(content="DECISION: Using Drizzle ORM with PostgreSQL. User wants type-safe queries and explicit migrations, no magic. Migration files go in /src/db/migrations/.", append=true)
```

This way other sessions can `read_scratchpad()` without asking you questions.
