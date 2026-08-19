# FinOps Platform — Self-Hosted, Free/Local Stack

A self-hosted AI API cost-management platform: real-time usage metering, budget governance, optimization recommendations, and shadow-spend detection — built entirely on free, local tooling. No cloud services, no paid tiers, no signups required to run it.

Runs on `localhost:4000` from VS Code with three commands: `npm install`, `npm run seed`, `npm start`.

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite via Node's built-in `node:sqlite` module (no native compilation — avoids the Visual Studio Build Tools requirement that `better-sqlite3` and similar packages need on Windows)
- **Frontend:** Plain HTML/JS + Chart.js, served locally (no CDN dependency, no build step)
- **Config:** `finops.yaml` for GitOps-style budget management
- **Zero paid dependencies** anywhere in the stack

## Quick start

```bash
npm install
npm run seed      # populates ~2 weeks of sample usage data
npm start
```

Open `http://localhost:4000`. On first run, auth is unlocked (bootstrap mode) until you create your first API key or user account — after that, every request needs an `X-API-Key` or `X-Session-Token` header.

Create your first admin account:
```bash
curl -X POST http://localhost:4000/api/auth/register -H "Content-Type: application/json" -d '{"username":"you","password":"a-real-password"}'
```

## Architecture

Two ways data gets into the platform:

1. **Log Integrator** (`POST /api/ingest`) — webhook-style event recording. Low integration effort, works with any existing setup, ~zero latency impact.
2. **Gateway Proxy** (`POST /api/proxy/:provider`) — point your OpenAI/Anthropic client's `baseURL` here instead. Real-time metering, governance (rate limits, circuit breaker, quarantine) enforced in the request path itself. Supports both standard and streaming (SSE) responses.

Both paths write to the same `usage_events` table and share the same budgeting/alerting/reporting layer.

## Features

### Cost tracking & attribution
- Per-event cost computed from a local pricing catalogue, with manual overrides (`POST /api/pricing/override`) so a stale rate never silently corrupts numbers
- Tagging by team/environment/git-branch — missing tags **warn**, not reject, and show up under "Untagged" rather than breaking traffic or vanishing silently
- Dashboards: cost over time, cost by team, cost by provider/model, untagged spend

### Governance (enforced live in the proxy)
- **Rate limiting** — token-bucket per API key (60 req capacity, 1/sec refill by default)
- **Circuit breaker** — a team over budget gets auto-degraded to a cheaper same-provider model instead of hard-blocked (e.g. `gpt-4o` → `gpt-4o-mini`)
- **Quarantine mode** — a flagged key is capped to 1 request/minute until an admin approves it

### Budgeting & alerts
- Multi-tier budgets (team/project/key scope)
- Progressive alerts at 50/80/90/100% of budget, fired once per threshold per month
- Burn-rate alerts (projects month-end overspend from current daily pace)
- Delivered to Slack via Incoming Webhook if `SLACK_WEBHOOK_URL` is set in `.env`; always logged locally regardless

### Optimization engine
- Rule-based (not ML) same-provider model-switch recommendations, each with an explicit caveat: **cost-only estimate, output quality not evaluated, test via shadow A/B before switching production traffic**
- Caching-opportunity heuristic: flags high-volume, low-variance call patterns that might benefit from prompt caching

### Shadow-spend reconciliation
- Upload a provider billing CSV (`date,provider,cost`) via `POST /api/reconcile/upload`
- Compares reported vs. tracked spend per day/provider, flags meaningful gaps
- Re-uploading a period **replaces** prior numbers for those days rather than double-counting

### Access control
- **API keys** (`fk_...`) for programmatic/service access, with roles: `admin`, `budget-manager`, `developer`, `viewer`
- **Human login** — session-based auth for the dashboard, separate from API keys, passwords hashed with Node's built-in `scrypt`
- **SSO (OIDC)** — spec-compliant authorization-code-flow client. Mechanically verified against a mock IdP; wiring up a real identity provider (Okta/Azure AD/Google Workspace/Auth0) requires your own app registration — see `.env.example`

### FinOps as Code
- `finops.yaml` defines budgets declaratively; `POST /api/gitops/sync` pushes them in and removes any budget no longer in the file (prevents drift)

## API reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | Record a usage event |
| POST | `/api/proxy/:provider` | Proxy a real request to `openai` or `anthropic` (streaming supported) |
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

## Configuration

Copy `.env.example` to `.env`:

```
SLACK_WEBHOOK_URL=       # optional, for alert delivery
OIDC_ISSUER=             # optional, for SSO — your IdP's issuer URL
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=http://localhost:4000/api/sso/callback
PORT=4000
```

## What's tested vs. what needs your own verification

Tested live during development (mock providers matching real API contracts, not just unit-level assumptions): proxy metering for both streaming and non-streaming requests on both providers, circuit breaker degradation, rate limiting, quarantine, RBAC across all four roles, GitOps sync including drift removal, budget/burn-rate alert math, recommendation output, reconciliation import with dedupe, and session login + SSO mechanics against a mock identity provider.

Needs your own verification: a live request against your real OpenAI/Anthropic account (requires your own API key/billing), and a live SSO handshake against your real identity provider (requires your own app registration — only you can create that for your org).

## Known gaps

- No true output-quality evaluation layer for recommendations (cost-only, by design — see the caveat on every suggestion)
- No automated test suite; verification so far has been live manual testing during development
- Runs single-process, single-tenant, local-only — no deployment/hosting setup yet
- No configuration change audit trail beyond the alert log

## License

MIT