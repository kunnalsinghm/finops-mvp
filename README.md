# FinOps — Self-Hosted AI API Cost Management Platform

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

Open `http://localhost:4000`. On first run, auth is unlocked (bootstrap mode) until you create your first API key or user account.

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

### Governance (enforced live in the proxy)
- Token-bucket rate limiting per API key
- Circuit breaker: teams over budget auto-degrade to a cheaper same-provider model instead of being blocked
- Quarantine mode: flagged keys capped to 1 req/min pending admin approval

### Caching
- Opt-in (`X-Enable-Cache: true`) exact-match request caching — identical provider+model+message requests return a cached response instead of re-calling the provider, with tracked cost savings
- Honest scope note: exact-match only, not semantic/embedding-based matching

### Budgeting & alerts
- Multi-tier budgets (team/project/key), progressive alerts (50/80/90/100%), burn-rate alerts
- Optional Slack delivery via Incoming Webhook; always logged locally

### Optimization engine
- Rule-based model-switch recommendations, each with an explicit caveat: cost-only estimate, quality unverified, test via shadow A/B first
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

### Reliability & operations
- **Security:** Helmet security headers (CSP, X-Frame-Options, etc.), IP-based login rate limiting (10 attempts / 15 min)
- **Logging:** structured JSON logs written to `logs/`, daily rotation
- **Backups:** automatic SQLite backup on boot and every 6 hours, retention-pruned; manual trigger via `npm run backup`
- **Crash recovery:** `npm run serve` runs a self-written supervisor that respawns the server on crash with exponential backoff

### FinOps as Code
- `finops.yaml` defines budgets declaratively; `POST /api/gitops/sync` pushes them in and removes any budget no longer in the file

### Testing
- 26 automated tests (`npm test`) covering pricing math, governance (rate limiting/quarantine/circuit breaker), RBAC, recommendations, and reconciliation — including edge cases like malformed CSV input

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
| GET | `/api/recommendations` | Optimization suggestions |
| POST | `/api/gitops/sync` | Sync budgets from `finops.yaml` |
| POST | `/api/auth/register` \| `/login` \| `/logout` | Human user accounts |
| GET | `/api/sso/login` \| `/callback` | OIDC SSO flow |
| POST | `/api/reconcile/upload` | Import a billing CSV |
| GET | `/api/reconcile/report` | Shadow-spend comparison report |
| GET | `/api/audit` | Audit trail (admin only) |
| GET | `/api/cache/stats` \| POST `/clear` | Cache statistics / manual clear |
| GET | `/api/data/export` | Export usage events (JSON/CSV) |
| DELETE | `/api/data/purge` | Retention purge (explicit cutoff required) |
| GET | `/api/backup` \| POST `/run` | List / trigger backups |

## Configuration

Copy `.env.example` to `.env`:


## What's tested vs. what needs your own verification

**Tested live during development:** proxy metering (streaming + non-streaming, both providers), circuit breaker, rate limiting, quarantine, RBAC, GitOps sync, budget/burn-rate alerts, recommendations, reconciliation with dedupe, session login + SSO mechanics against a mock IdP, real-match caching (verified via call-count assertions), security headers, login rate limiting, automatic backups, and crash-restart via the supervisor.

**Needs your own verification:** a live request against your real OpenAI/Anthropic account (requires your own API key/billing), and a live SSO handshake against your real identity provider (requires your own app registration).

## Known gaps

- No true output-quality evaluation layer for recommendations (cost-only, by design)
- Single-process, single-tenant, local-only — no multi-region/hosted deployment
- SQLite backups are file copies, not point-in-time/incremental
- No payment/billing infrastructure (this tracks *other* API spend — it doesn't bill anyone for using it)

## License

MIT