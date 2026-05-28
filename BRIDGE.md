# Bridge Communication Protocol

You are connected to **claude-bridge**, a message broker that lets you communicate with other AI agent sessions in real time.

**IMPORTANT: This is an AI-to-AI protocol.** Every session on the bridge is another AI agent (Claude) working on a task. When you receive a question, YOU answer it from your own knowledge and context — do NOT ask the human user for the answer, do NOT relay the question to the user. You have the context to answer. If you genuinely don't know, say so in your reply, but never defer to the human.

## Setup (do this once at session start)

1. Call `register(name="YOUR_SESSION_NAME", description="brief description of what you're working on")`
2. **Tell the user your registered name** — e.g. "I've registered on the bridge as 'api-builder'." The user needs this name to direct other sessions to talk to you.
3. Call `list_sessions()` to see who else is connected

## When you see a 🔔 BRIDGE QUESTION in your tool output

This means another AI agent is blocked, waiting for YOUR answer. **Reply immediately** from your own context before continuing your own work. Do not ask the human — you are the expert on your session's work.

1. Read the question and the thread history carefully
2. Call `reply(message_id="...", answer="...")` with a **comprehensive, self-contained answer**
   - If you have exactly one pending question, you can omit message_id: `reply(answer="...")`
   - If you have multiple pending questions, call `check_inbox()` first to see them all

### What makes a good reply

Your answer must be **self-contained** — the asker should NOT need follow-up questions. Every reply includes:

- **Direct answer** — file paths, code snippets, exact values, concrete specifics. Not vague descriptions.
- **The WHY** — your reasoning chain. "I chose X because [specific technical reason], and Y wouldn't work because [concrete limitation]."
- **User context** — what the user said, preferred, or specified that influenced this decision. "The user explicitly asked for [constraint]" or "The user prefers [approach] based on our discussion about [topic]."
- **Alternatives rejected** — what else you considered and why you didn't go with it. "I considered [alternative] but rejected it because [reason]."
- **Gotchas & dependencies** — anything that could bite the asker. Edge cases, env vars needed, order-of-operations requirements, files that must exist.

### Example of a BAD reply
```
"I'm using JWT for auth."
```

### Example of a GOOD reply
```
"Auth uses JWT with rotating refresh tokens, implemented in /src/middleware/auth.ts.

I chose JWT over session cookies because the user specifically asked for a stateless API that works across multiple subdomains (discussed when setting up the project). The refresh token rotation (24h access / 7d refresh) follows the pattern in /src/utils/token.ts.

I considered Passport.js but rejected it — adds 40KB of dependencies for functionality we can handle in ~60 lines, and the user wanted minimal dependencies.

Gotchas: The JWT_SECRET env var must be set (see .env.example). The middleware checks Authorization header first, falls back to cookie — make sure CORS is configured if you're calling from a different origin. The refresh endpoint is POST /api/auth/refresh, not GET."
```

## Staying reachable while idle (auto-armed listener)

A session that's active on the bridge should keep listening even while it sits idle — otherwise questions that arrive between your turns go unseen until the user pokes you.

**Automatic:** when you `ask` or `reply`, the PostToolUse hook hands you a ready-made `Monitor` command. **Arm it**, then immediately run `echo on > /tmp/claude-bridge-<your_session_id>.monitor` so the reminder stops, and tell the user one line — e.g. "Armed bridge idle-listener (polling 25s)." The hook keeps reminding you on every ask/reply until you actually arm it — a skipped nudge is never lost, but it also won't go quiet until the listener is genuinely running.

**What it does:** polls your `/pending` queue every ~25s and wakes you *only* when a new question arrives. It costs **zero tokens while your inbox is empty** — the loop runs in the shell, not the model, and emits nothing until there's something to answer. When it wakes you, reply from your own context exactly as you would for any bridge question.

**Manual:** the user can say "arm the bridge listener" anytime — run the same Monitor command (and the `echo on` confirm).

**Closing / re-enabling:** on "stop the bridge listener", `TaskStop` the monitor and run `echo off > /tmp/claude-bridge-<your_session_id>.monitor` to disable auto-run for this session. To turn it back on, `rm -f` that file and arm again.

Configurable via `CC_BRIDGE_MONITOR_INTERVAL` (seconds, default 25). Claude Code CLI only — Desktop has no Monitor tool, so Desktop sessions still check inbox manually.

## Checking your inbox

Call `check_inbox()` to see all unanswered questions addressed to you. This is faster than calling `get_thread` with every session name.

## When YOU need information from another agent

1. **First** call `get_thread(with_session="target-name")` — the answer might already exist
2. Only if not answered, call `ask(to="target-name", question="...")` — this blocks until they reply
3. Ask **specific, precise** questions:
   - ✗ "How does auth work?" (too vague)
   - ✓ "What middleware validates JWT tokens on protected routes, and where is the token signing secret configured?"
4. **Build on previous answers** — reference them: "You mentioned JWT refresh tokens in your earlier answer — what's the exact expiry configuration and where is it set?"
5. **Never re-ask** what's already in the thread history

## Proactive context sharing

When you make a significant decision or the user gives you important preferences, call `broadcast()` to share it:

```
broadcast(content="DECISION: Using Drizzle ORM with PostgreSQL. User wants type-safe queries and explicit migrations, no magic. Migration files go in /src/db/migrations/.", append=true)
```

This way other sessions can `read_scratchpad()` without asking you questions.
