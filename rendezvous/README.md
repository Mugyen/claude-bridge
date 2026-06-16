# 🧭 claude-bridge rendezvous

A ~100-line Cloudflare Worker that turns long join links into speakable codes:

```bash
# hub                                          # joiner, anywhere
claude-bridge room invite --code               claude-bridge join mugyen-team
  → "tell them: claude-bridge join mugyen-team"
```

It's a **phone book, not a relay** — it maps `code → join link` and nothing else.
No bridge traffic ever touches it; if it's down, long links keep working.

## Policy

- **Open namespace**: anyone can publish any code, first-come-first-served.
- **Owner token per code**: returned once at publish; while a code is alive only
  its publisher can renew/update/release it. When the TTL lapses unrenewed, the
  code frees up — a dead hub's name becomes available again.
- **TTL'd**: default 7 days (clamped 5min–30d). Cloudflare KV expiry is the GC.
- **Open, rate-limited lookups** (30/min/IP).
- The code is *discovery only* — the resolved link still carries the invite /
  token / room key doing the actual security. Codes published by the CLI default
  to one-time invites, so a brute-forced code yields a dead link.

## Deploy (one time, ~5 minutes)

```bash
cd rendezvous
npx wrangler login                      # or CLOUDFLARE_API_TOKEN env
npx wrangler kv namespace create RDV    # paste the id into wrangler.toml
npx wrangler deploy
# optional custom domain: uncomment `routes` in wrangler.toml (e.g. r.houserbot.com)
```

Cost: $0 — free tier covers ~100k requests/day; entries are tiny and self-expire.

## Point the CLI at it

The CLI default is baked in `claude-bridge` (`DEFAULT_RENDEZVOUS`). Override per
machine without touching code:

```bash
echo "https://your-worker.example.com" > ~/.claude/.cc-bridge-rendezvous
# or: export CC_BRIDGE_RENDEZVOUS="https://your-worker.example.com"
```

## API (the whole contract)

| Call | Body | Returns |
|---|---|---|
| `POST /v1/rooms` | `{code?, link, ttl_seconds?, owner_token?}` | `201 {code, owner_token, expires_at}` · renew: `200` · taken: `409` |
| `GET /v1/rooms/<code>` | — | `200 {link, expires_at}` · `404` (expired/unknown) |
| `DELETE /v1/rooms/<code>` | `{owner_token}` | `200` · `403` |

Tested by `tests/test-rendezvous-worker.mjs` (runs the real fetch handler with an
in-memory KV) and `tests/test-rendezvous-cli.sh` (CLI against a local fake).
