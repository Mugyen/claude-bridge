# Bridge Communication Protocol

You are connected to **cc-bridge**, a message broker that lets you communicate with other Claude Code sessions in real time.

## Setup (do this once at session start)

1. Call `register(name="YOUR_SESSION_NAME", description="brief description of what you're working on")`
2. Call `list_sessions()` to see who else is connected
3. Call `read_scratchpad()` to check if any session has shared context

## When you see a 🔔 BRIDGE QUESTION in your tool output

This means another session is blocked, waiting for your answer. **Reply immediately** before continuing your own work.

1. Read the question and the thread history carefully
2. Call `reply(message_id="...", answer="...")` with a **comprehensive, self-contained answer**

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

## When YOU need information from another session

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
