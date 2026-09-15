# FinOps — Self-Hosted AI API Cost Management Platform

**Developed and maintained by Vidhi Sharma and kunal.sm**

A platform for tracking, governing, and optimizing spend on LLM APIs (OpenAI, Anthropic). Runs single-tenant on SQLite with zero setup for local/self-hosted use, or opts into Postgres — single-tenant or fully multi-tenant — for a hosted deployment. Real-time cost metering, budget enforcement, RBAC, PII/prompt-injection protection, shadow-spend detection, caching, shadow A/B model testing, and a themeable dashboard UI.

Runs on `localhost:4000` from VS Code with three commands: `npm install`, `npm run seed`, `npm start` (or `npm run serve` for crash auto-restart).

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite by default (via `node:sqlite`, no native compilation) — or Postgres (`FINOPS_DB_DRIVER=postgres`) for a hosted single-tenant or multi-tenant deployment
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

## Deployment modes

| Mode | Driver | Who it's for |
|---|---|---|
| **Single-tenant, local** (default) | SQLite | Self-hosted, one team, zero config |
| **Single-tenant, hosted** | Postgres (`FINOPS_DB_DRIVER=postgres`) | One customer's own hosted deployment |
| **Multi-tenant, hosted** | Postgres (`FINOPS_DB_DRIVER=postgres` + `FINOPS_MULTI_TENANT=true`) | Serving multiple customers from one deployment |

Multi-tenant isolation is **schema-per-tenant with a dedicated Postgres connection pool per tenant** (`server/tenancy.js`), not a shared pool with a per-request `search_path` reset — a tenant's connections are physically incapable of serving another tenant's query, by construction, rather than relying on every call site remembering to reset state. Identity/routing data (which tenants exist, which API keys/users belong to which tenant) lives in a separate shared `control_plane` schema; a request resolves its tenant there first, then gets routed to that tenant's own schema for everything else.

**Not yet supported in multi-tenant mode:** dashboard session login (`/api/auth/login`) — the session store is a single global in-memory map with no tenant concept, so it's deliberately disabled (`501`) rather than risk a cross-tenant leak. Use an `X-API-Key` in multi-tenant mode until this is built.

## Features

### Cost tracking & attribution
- Per-event cost from a local pricing catalogue with manual overrides
- Team/environment/git-branch tagging — missing tags warn, not reject
- Dashboards: cost over time, cost by team, cost by provider/model, untagged spend
- **Spend forecasting**: a simple moving-average projection (`GET /api/costs/forecast`) — averages recent daily spend (default: last 7 days) and extends it forward (default: 30 days). Deliberately not trend-aware or seasonal — a plain average, not linear regression, since sparse/bursty daily usage data would make a "smarter" model mostly overfit noise rather than add real signal. Refuses to forecast (`available: false`) with fewer than 3 days of data rather than returning a falsely-precise number off 1–2 noisy days

### Content safety & data protection
- **PII redaction** (on by default, opt out per-request via `X-Disable-PII-Redaction: true`): regex-based detection of email, SSN, credit card (Luhn-validated), phone, and IP address patterns. Redacts the *request* before it's sent upstream, cached, or persisted — the response is left untouched, since that's what the caller is paying for. Redact-and-continue, not block. Applied at both the proxy and ingest
- **Prompt-injection detection** (always on, not opt-out): rule-based pattern matching against known jailbreak/injection phrasings. Unlike PII redaction, this **blocks** the request (HTTP 400). Runs *before* PII redaction at both surfaces. Applied at both the proxy (before any upstream call) and ingest (scans the entire raw body). Both surfaces log to the alerts log with which named pattern(s) matched

### Governance (enforced live in the proxy)
- Token-bucket rate limiting per API key
- Circuit breaker: teams over budget auto-degrade to a cheaper same-provider model instead of being blocked
- Quarantine mode: flagged keys capped to 1 req/min pending admin approval
- Single-request anomaly detection: flags any one event costing more than 5x the 30-day rolling average for that provider/model
- **Model allow-listing**: restrict specific keys/teams to a pre-approved list of models. Off by default per scope; most-specific-wins precedence. Checked before budget/circuit-breaker logic. Manage via `/api/model-allowlist`
- **Token quotas**: cap raw input+output token consumption per key/team over a daily and/or weekly window, independent of model. Same off-by-default, most-specific-wins precedence. Manage via `/api/token-quotas`

### Caching — two independent, opt-in tiers
- **Exact-match** (`X-Enable-Cache: true`): identical provider+model+message requests return a cached response, with tracked cost savings
- **Semantic/near-duplicate** (`X-Enable-Semantic-Cache: true`): catches reworded prompts that mean the same thing. Local zero-dependency word-overlap mode by default, or real OpenAI embeddings if `FINOPS_EMBEDDING_API_KEY` is set

### Budgeting & alerts
- Multi-tier budgets (team/project/key), progressive alerts (50/80/90/100%), burn-rate alerts
- Delivery via Slack Incoming Webhook, a generic webhook (Discord/Teams/ntfy.sh/PagerDuty-compatible), and/or SMTP email; always logged locally regardless of delivery config

### Optimization engine
- Rule-based model-switch recommendations, each starting with an explicit caveat: cost-only estimate, quality unverified
- **Shadow A/B testing** (opt-in via `X-Enable-Shadow-Test: true`): a sample of real traffic is also sent to the recommended cheaper model, purely to compare — never affects what's returned to the client, non-streaming requests only. Once a model pair has enough samples (default 5), `/api/recommendations` reports a real measured confidence: `shadow-tested-similar` or `shadow-tested-diverges`
- Caching-opportunity heuristic for repeated/templated prompt patterns

### Shadow-spend reconciliation
- Upload a provider billing CSV (`date,provider,cost`) to compare reported vs. tracked spend per day/provider
- Re-uploading a period replaces prior numbers rather than double-counting

### Access control
- API keys (roles: admin, budget-manager, developer, viewer) for services/the proxy
- Session-based human login for the dashboard, `scrypt`-hashed passwords (single-tenant mode only — see "Deployment modes")
- Spec-compliant OIDC (SSO) client — needs your own identity provider app registration to fully activate

### Audit & data governance
- Immutable audit trail for all administrative actions (budget changes, key lifecycle, pricing overrides)
- Data export (JSON/CSV) and explicit-cutoff retention purging via `/api/data`
- FOCUS-spec export (`/api/data/export/focus`)

### Reliability & operations
- **Security:** Helmet security headers, IP-based login rate limiting (10 attempts / 15 min)
- **Logging:** structured JSON logs written to `logs/`, daily rotation
- **Backups:** automatic SQLite backup on boot and every 6 hours, retention-pruned; manual trigger via `npm run backup`
- **Crash recovery:** `npm run serve` runs a self-written supervisor that respawns the server on crash with exponential backoff

### FinOps as Code
- `finops.yaml` defines budgets declaratively; `POST /api/gitops/sync` pushes them in and removes any budget no longer in the file

### Testing
- 225 automated tests, all passing (`npm test`) — covering pricing math, governance, anomaly detection, PII redaction, prompt-injection detection, model allow-listing, token quotas, spend forecasting, RBAC, alert delivery, recommendations, shadow A/B testing, reconciliation, semantic caching, FOCUS export, and multi-tenant schema/pool isolation
- `scripts/mock-provider.js` — a local stand-in for the OpenAI/Anthropic APIs, so the full proxy flow can be exercised end-to-end at zero real API cost

### Client SDK
- `sdk/finops-client.js` — a zero-dependency wrapper for calling the proxy without hand-managing headers, supporting both standard and streaming requests

## API reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | Record a usage event |
| POST | `/api/proxy/:provider` | Proxy a request to `openai`/`anthropic` (streaming + opt-in caching supported) |
| GET | `/api/costs/summary` \| `/by-team` \| `/by-model` \| `/over-time` \| `/untagged` | Cost dashboards |
| GET | `/api/costs/forecast` | Simple moving-average spend projection (`?lookback_days=&horizon_days=`) |
| GET/POST | `/api/budgets` | List / create budgets |
| GET | `/api/budgets/status` | Budgets with spend-to-date and alert tier |
| GET | `/api/pricing/catalogue` | View baseline pricing |
| POST | `/api/pricing/override` | Correct/add a pricing rate |
| GET/POST | `/api/keys` | List / create API keys |
| POST | `/api/keys/:id/quarantine` \| `/approve` \| `/revoke` | Key governance actions |
| GET | `/api/alerts` | Alert log |
| POST | `/api/alerts/check-now` | Manually trigger budget/burn-rate checks |
| GET/POST | `/api/model-allowlist` | List / add allow-list entries |
| DELETE | `/api/model-allowlist/:id` | Remove an entry (admin only) |
| GET/POST | `/api/token-quotas` | List / add quotas |
| DELETE | `/api/token-quotas/:id` | Remove a quota (budget-manager or admin) |
| GET | `/api/recommendations` | Optimization suggestions |
| GET | `/api/shadow-test/summary` \| `/comparisons` | Shadow A/B test results |
| POST | `/api/gitops/sync` | Sync budgets from `finops.yaml` |
| POST | `/api/auth/register` \| `/login` \| `/logout` | Human user accounts (single-tenant mode) |
| GET | `/api/sso/login` \| `/callback` | OIDC SSO flow |
| POST | `/api/reconcile/upload` | Import a billing CSV |
| GET | `/api/reconcile/report` | Shadow-spend comparison report |
| GET | `/api/audit` | Audit trail (admin only) |
| GET | `/api/cache/stats` \| POST `/clear` | Exact-match cache statistics / manual clear |
| GET | `/api/semantic-cache/stats` \| POST `/clear` | Semantic cache statistics / manual clear |
| GET | `/api/data/export` \| `/export/focus` | Export usage events (JSON/CSV) / FOCUS-spec export |
| DELETE | `/api/data/purge` | Retention purge (explicit cutoff required) |
| GET/POST | `/api/backup` \| `/run` | List / trigger backups |

## Configuration

Copy `.env.example` to `.env`. Vars worth understanding before you touch them: `FINOPS_HOST` (see "Bootstrap mode"), `FINOPS_DB_DRIVER` and `FINOPS_MULTI_TENANT` (see "Deployment modes").

## Bootstrap mode

On a fresh install, before you've created your first API key or user, **every request is served as admin** in single-tenant mode — deliberate local-dev convenience. Once you create a key or user, this window closes automatically. (Multi-tenant mode has no bootstrap window — see "Deployment modes.")

The server binds to `127.0.0.1` by default, so the bootstrap window can't be reached from anywhere else. Setting `FINOPS_HOST=0.0.0.0` exposes it network-wide, including the bootstrap window, until you create your first key/user — the server logs a loud one-time `[WARN]` on boot and on first bootstrap-mode access.

## What's tested vs. what needs your own verification

**Tested live during development:** proxy metering (streaming + non-streaming, both providers), circuit breaker, rate limiting, quarantine, RBAC, GitOps sync, budget/burn-rate alerts, recommendations, reconciliation with dedupe, session login + SSO mechanics against a mock IdP, exact-match caching, security headers, login rate limiting, automatic backups, crash-restart via the supervisor, and multi-tenant schema creation / connection pool isolation.

**Needs your own verification:** a live request against your real OpenAI/Anthropic account (requires your own API key/billing), a live SSO handshake against your real identity provider (requires your own app registration), and the proxy under real production-like concurrent load — the test suite exercises correctness, not throughput/latency under load.

## Known gaps

- Token quotas are checked using consumption *so far*, not including the current request — the request that crosses the threshold is still allowed through; only the next request after that is blocked. Deliberate: no provider exposes token cost before generating the response
- PII redaction and prompt-injection detection are both pattern-based, not ML classifiers — neither is a compliance guarantee on its own, and both can be evaded by a sufficiently motivated obfuscation (base64, homoglyphs, translation-based smuggling are explicitly out of scope for v1)
- Shadow A/B testing covers non-streaming proxy requests only
- Shadow-test similarity is local word-overlap cosine similarity (lexical), not true semantic/human quality judgment
- SQLite backups are file copies, not point-in-time/incremental; Postgres deployments are responsible for their own backup strategy (not yet covered by `scripts/backup.js`)
- No payment/billing infrastructure (this tracks *other* API spend — it doesn't bill anyone for using the platform itself; no Stripe or subscription-management integration yet)
- No Docker image or CI/CD pipeline yet — deployment is manual
- No commitment/prepaid-credit tracking (burn-down against a prepaid balance) yet
- No scheduled weekly digest/briefing (Slack/email) — alerting is event-triggered, not summarized on a cadence
- No `feature_id`/`customer_id` tagging on ingest, so no cost-per-feature or cost-per-customer breakdown yet
- No fraud/compromised-key detection (usage-pattern shift, new geography, sudden volume spike distinct from the existing single-request anomaly check)
- Dashboard session login is not yet supported in multi-tenant mode (see "Deployment modes") — API-key auth only

## License

MIT