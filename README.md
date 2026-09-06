# FinOps — Self-Hosted AI API Cost Management Platform

**Developed and maintained by Vidhi Sharma and kunal.sm**

A self-hosted platform for tracking, governing, and optimizing spend on LLM APIs (OpenAI, Anthropic) — built entirely on free, local tooling. Real-time cost metering, budget enforcement, RBAC, shadow-spend detection, and a themeable dashboard UI, with no cloud services, paid tiers, or signups required to run it.

Runs on `localhost:4000` from VS Code with three commands: `npm install`, `npm run seed`, `npm start` (or `npm run serve` for crash auto-restart).

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite via Node's built-in `node:sqlite` module — no native compilation required
- **Frontend:** Vanilla HTML/CSS/JS + Chart.js, zero build step, custom light/dark design system
- **Security:** Helmet (security headers), IP-based login rate limiting, `scrypt` password hashing
- **Testing:** Node's native test runner (`node --test`) — zero external test dependencies
- **Config:** `finops.yaml` for GitOps-style budget management

## Quick start

```bash
npm install
npm run seed      # populates ~2 weeks of sample usage data
npm run serve      # starts with auto-restart on crash (recommended)
# or: npm start    # starts without the supervisor
```

Open `http://localhost:4000`. On first run, auth is unlocked (bootstrap mode) until you create your first API key or user account — see "Bootstrap mode" below before exposing this beyond your own machine.

```bash
curl -X POST http://localhost:4000/api/auth/register -H "Content-Type: application/json" -d '{"username":"you","password":"a-real-password"}'
```

## Architecture

Two ways data gets in:

1. **Log Integrator** (`POST /api/ingest`) — webhook-style event recording.
2. **Gateway Proxy** (`POST /api/proxy/:provider`) — point your OpenAI/Anthropic client's `baseURL` here. Real-time metering, governance, and opt-in caching enforced in the request path, with full streaming (SSE) support.

Both write to the same `usage_events` table and share the same budgeting/alerting/reporting layer.

## Features

### Cost tracking & attribution
- Per-event cost from a local pricing catalogue with manual overrides
- Team/environment/git-branch tagging — missing tags warn, not reject
- Dashboards: cost over time, cost by team, cost by provider/model, untagged spend

### Content safety & data protection
- **PII redaction** (on by default, opt out per-request via `X-Disable-PII-Redaction: true`): regex-based detection of email, SSN, credit card (Luhn-validated), phone, and IP address patterns. Redacts the *request* before it's sent upstream, cached, or persisted — the response is left untouched, since that's what the caller is paying for. Redact-and-continue, not block — mangling a request that could otherwise succeed is worse than the risk here. Applied at both the proxy and ingest
- **Prompt-injection detection** (always on, not opt-out): rule-based pattern matching (not ML) against known jailbreak/injection phrasings ("ignore previous instructions", "reveal your system prompt", DAN-style persona overrides, etc.). Unlike PII redaction, this **blocks** the request (HTTP 400) rather than continuing — a detected injection attempt getting through even partially defeats the point. Runs *before* PII redaction at both surfaces, so a request that's about to be rejected doesn't first pay the cost of being redacted. Applied at both the proxy (before any upstream call — a blocked request never costs money against a real provider) and ingest (scans the entire raw body, since it's persisted verbatim and a payload in any field could be replayed into a real prompt later by some downstream feature). Both surfaces log to the alerts log with which named pattern(s) matched

### Governance (enforced live in the proxy)
- Token-bucket rate limiting per API key
- Circuit breaker: teams over budget auto-degrade to a cheaper same-provider model instead of being blocked
- Quarantine mode: flagged keys capped to 1 req/min pending admin approval
- Single-request anomaly detection: flags any one event costing more than 5x the 30-day rolling average for that provider/model — catches a runaway call immediately, rather than waiting for month-end budget totals to reflect it
- **Model allow-listing**: restrict specific keys/teams to a pre-approved list of models (e.g. "this key can only use `gpt-4o-mini`"). Off by default per scope — a key/team with no allow-list rows is completely unrestricted; only adding at least one entry activates the restriction for that key/team. When a key has its own entries, those take full precedence over its team's list (most-specific-wins, not a union). Checked before the budget/circuit-breaker logic, so a disallowed model is rejected before any spend calculation happens. Manage via `/api/model-allowlist`

### Caching — two independent, opt-in tiers
- **Exact-match** (`X-Enable-Cache: true`): identical provider+model+message requests return a cached response instead of re-calling the provider, with tracked cost savings
- **Semantic/near-duplicate** (`X-Enable-Semantic-Cache: true`): catches *reworded* prompts that mean the same thing. Local zero-dependency word-overlap mode by default, or real OpenAI embeddings if `FINOPS_EMBEDDING_API_KEY` is set (falls back to local mode if the embedding call fails). Kept as a separate opt-in from exact-match since a semantic hit returns a response to a *different* prompt than what was actually asked — a bigger trust assumption than exact-match, so it needs its own explicit flag

### Budgeting & alerts
- Multi-tier budgets (team/project/key), progressive alerts (50/80/90/100%), burn-rate alerts
- Delivery via Slack Incoming Webhook, a generic webhook (Discord/Teams/ntfy.sh/PagerDuty-compatible — posts `{ text, timestamp }`), and/or SMTP email; always logged locally regardless of whether any delivery channel is configured

### Optimization engine
- Rule-based model-switch recommendations, each starting with an explicit caveat: cost-only estimate, quality unverified
- **Shadow A/B testing** (opt-in via `X-Enable-Shadow-Test: true` on the proxy): a sample of real traffic is also sent to the recommended cheaper model, purely to compare — never affects what's returned to the client, fires only after the real response is already sent, non-streaming requests only. Once a specific (current → suggested) model pair has enough successful samples (`FINOPS_SHADOW_TEST_MIN_SAMPLES`, default 5), `/api/recommendations` stops saying "unverified" and reports a real measured confidence instead: `shadow-tested-similar` (average output similarity above `FINOPS_SHADOW_TEST_SIMILARITY_THRESHOLD`, default 0.8) or `shadow-tested-diverges` (below it — switching is actively discouraged in this case, not just unverified). Similarity is local word-overlap cosine similarity (same technique as the semantic cache's local mode) — a useful signal, not a substitute for reading sample outputs yourself. Control the added cost with `X-Shadow-Test-Sample-Rate` (0–1) since every shadow-tested request calls two models instead of one
- Caching-opportunity heuristic for repeated/templated prompt patterns

### Shadow-spend reconciliation
- Upload a provider billing CSV (`date,provider,cost`) to compare reported vs. tracked spend per day/provider
- Re-uploading a period replaces prior numbers rather than double-counting

### Access control
- API keys (roles: admin, budget-manager, developer, viewer) for services/the proxy
- Session-based human login for the dashboard, `scrypt`-hashed passwords
- Spec-compliant OIDC (SSO) client — needs your own identity provider app registration to fully activate

### Audit & data governance
- Immutable audit trail for all administrative actions (budget changes, key lifecycle, pricing overrides)
- Data export (JSON/CSV) and explicit-cutoff retention purging via `/api/data`
- FOCUS-spec export (`/api/data/export/focus`) — aligns usage-event export with the FinOps Open Cost & Usage Specification, for feeding into external BI/reporting tools that expect FOCUS-shaped data

### Reliability & operations
- **Security:** Helmet security headers (CSP, X-Frame-Options, etc.), IP-based login rate limiting (10 attempts / 15 min)
- **Logging:** structured JSON logs written to `logs/`, daily rotation
- **Backups:** automatic SQLite backup on boot and every 6 hours, retention-pruned; manual trigger via `npm run backup`
- **Crash recovery:** `npm run serve` runs a self-written supervisor that respawns the server on crash with exponential backoff

### FinOps as Code
- `finops.yaml` defines budgets declaratively; `POST /api/gitops/sync` pushes them in and removes any budget no longer in the file

### Testing
- 109 automated tests (`npm test`) covering pricing math, governance (rate limiting/quarantine/circuit breaker), anomaly detection, PII redaction, prompt-injection detection, model allow-listing, RBAC, alert delivery (mocked webhook/SMTP calls), recommendations, shadow A/B testing, reconciliation, semantic caching, and FOCUS export — including edge cases like malformed CSV input
- `scripts/mock-provider.js` — a tiny local stand-in for the OpenAI/Anthropic APIs, so the full proxy flow (governance, caching, semantic caching, cost logging) can be exercised end-to-end at zero real API cost. Point `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` at it in `.env`

### Client SDK
- `sdk/finops-client.js` — a zero-dependency wrapper for calling the proxy without hand-managing headers, supporting both standard and streaming requests

## API reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | Record a usage event |
| POST | `/api/proxy/:provider` | Proxy a request to `openai`/`anthropic` (streaming + opt-in caching supported) |
| GET | `/api/costs/summary` \| `/by-team` \| `/by-model` \| `/over-time` \| `/untagged` | Cost dashboards |
| GET/POST | `/api/budgets` | List / create budgets |
| GET | `/api/budgets/status` | Budgets with spend-to-date and alert tier |
| GET | `/api/pricing/catalogue` | View baseline pricing |
| POST | `/api/pricing/override` | Correct/add a pricing rate |
| GET/POST | `/api/keys` | List / create API keys |
| POST | `/api/keys/:id/quarantine` \| `/approve` \| `/revoke` | Key governance actions |
| GET | `/api/alerts` | Alert log |
| POST | `/api/alerts/check-now` | Manually trigger budget/burn-rate checks |
| GET | `/api/model-allowlist` | List allow-list entries (optionally filter by `?scope_type=&scope_value=`) |
| POST | `/api/model-allowlist` | Add an entry (admin only) |
| DELETE | `/api/model-allowlist/:id` | Remove an entry (admin only) |
| GET | `/api/recommendations` | Optimization suggestions (model-switch confidence includes real shadow-test results once enough samples exist) |
| GET | `/api/shadow-test/summary` | Aggregated shadow A/B test results per model pair |
| GET | `/api/shadow-test/comparisons` | Recent raw shadow-test rows, including failures |
| POST | `/api/gitops/sync` | Sync budgets from `finops.yaml` |
| POST | `/api/auth/register` \| `/login` \| `/logout` | Human user accounts |
| GET | `/api/sso/login` \| `/callback` | OIDC SSO flow |
| POST | `/api/reconcile/upload` | Import a billing CSV |
| GET | `/api/reconcile/report` | Shadow-spend comparison report |
| GET | `/api/audit` | Audit trail (admin only) |
| GET | `/api/cache/stats` \| POST `/clear` | Exact-match cache statistics / manual clear |
| GET | `/api/semantic-cache/stats` \| POST `/clear` | Semantic cache statistics / manual clear |
| GET | `/api/data/export` | Export usage events (JSON/CSV) |
| GET | `/api/data/export/focus` | FOCUS-spec export (JSON/CSV) |
| DELETE | `/api/data/purge` | Retention purge (explicit cutoff required) |
| GET | `/api/backup` \| POST `/run` | List / trigger backups |

## Configuration

Copy `.env.example` to `.env`. One var worth understanding before you touch it: `FINOPS_HOST` (see "Bootstrap mode" below).

## Bootstrap mode

On a fresh install, before you've created your first API key or user, **every request is served as admin** — this is deliberate local-dev convenience, so there's no setup friction before you have credentials. Once you create a key or user, this window closes automatically and normal auth is enforced from then on.

The server binds to `127.0.0.1` (this machine only) by default, specifically so that bootstrap window can't be reached from anywhere else. If you set `FINOPS_HOST=0.0.0.0` to make the server reachable from other devices on your network (or a tunnel/port-forward), the bootstrap window becomes reachable from those devices too, until you create your first key/user — the server logs a loud one-time `[WARN]` on boot and on first bootstrap-mode access so this is never silent. Don't set `FINOPS_HOST=0.0.0.0` until you've created a real key or user, unless you're on a fully trusted private network.

## What's tested vs. what needs your own verification

**Tested live during development:** proxy metering (streaming + non-streaming, both providers), circuit breaker, rate limiting, quarantine, RBAC, GitOps sync, budget/burn-rate alerts, recommendations, reconciliation with dedupe, session login + SSO mechanics against a mock IdP, real-match caching (verified via call-count assertions), security headers, login rate limiting, automatic backups, and crash-restart via the supervisor.

**Needs your own verification:** a live request against your real OpenAI/Anthropic account (requires your own API key/billing), and a live SSO handshake against your real identity provider (requires your own app registration).

## Known gaps

- PII redaction and prompt-injection detection are both pattern-based, not ML classifiers — PII redaction will miss creative obfuscation and can occasionally false-positive (e.g. a 16-digit order ID that happens to pass Luhn); prompt-injection detection catches known common phrasings only and will not catch a novel or deliberately obfuscated attempt (base64, unicode homoglyphs, translation-based smuggling are explicitly out of scope for v1). Neither is a compliance guarantee on its own
- Shadow A/B testing (see Optimization engine above) covers non-streaming proxy requests only; a streaming request is never eligible for shadow testing
- Shadow-test similarity is local word-overlap cosine similarity (lexical), not true semantic/human quality judgment — a signal, not a substitute for reading sample outputs
- Single-process, single-tenant, local-only — no multi-region/hosted deployment
- SQLite backups are file copies, not point-in-time/incremental
- No payment/billing infrastructure (this tracks *other* API spend — it doesn't bill anyone for using it)

## License

MIT
