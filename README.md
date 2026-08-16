# FinOps MVP — Phase 1 (Log Integrator + Dashboard)

A fully free, local-first starting point for the API FinOps platform blueprint.
No cloud signups, no paid services, no Docker required — just Node.js.

## Stack
- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`) — a single file at `data/finops.db`
- **Frontend:** Plain HTML/JS + Chart.js (CDN) — no build step
- **Pricing:** Static baseline catalogue + manual override table (see `server/pricing.js`)

## Setup (in VS Code)

1. Open this folder in VS Code (`File > Open Folder`).
2. Open a terminal (`` Ctrl+` ``) and run:
   ```bash
   npm install
   npm run seed     # populates ~2 weeks of sample usage data
   npm start
   ```
3. Open http://localhost:4000 in your browser. You should see the dashboard populated with sample data.

Recommended free VS Code extensions (optional, not required to run):
- **SQLite Viewer** — inspect `data/finops.db` directly in the editor
- **REST Client** or **Thunder Client** — send test requests to `/api/ingest` without leaving VS Code
- **ESLint** — if you want linting as the codebase grows

## Sending real usage events

```bash
curl -X POST http://localhost:4000/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "model": "claude-sonnet",
    "team": "growth",
    "environment": "prod",
    "input_tokens": 1000,
    "output_tokens": 500
  }'
```

Missing `team` or `environment`? The event is still recorded (default is **warn, not reject** —
see the blueprint's gap notes on why hard-rejecting untagged traffic is risky) and shows up
under "Untagged" on the dashboard so you can see what's not being tracked properly.

## Fixing stale or missing pricing

The baseline catalogue in `server/pricing.js` has placeholder rates — check current vendor
pricing pages before relying on it for real billing. To correct a rate without touching code:

```bash
curl -X POST http://localhost:4000/api/pricing/override \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"claude-sonnet","input_per_1k":0.003,"output_per_1k":0.015}'
```

Overrides always take priority over the baseline catalogue.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | Record a usage event |
| GET | `/api/costs/summary` | Total spend, today's spend, event count |
| GET | `/api/costs/by-team` | Spend grouped by team |
| GET | `/api/costs/by-model` | Spend grouped by provider/model |
| GET | `/api/costs/over-time` | Daily spend series |
| GET | `/api/costs/untagged` | Spend with missing team/environment tags |
| GET | `/api/budgets` | List budgets |
| POST | `/api/budgets` | Create a budget (`scope_type`: team/project/key) |
| GET | `/api/budgets/status` | Budgets with spend-to-date and alert tier |
| GET | `/api/pricing/catalogue` | View baseline pricing |
| POST | `/api/pricing/override` | Correct/add a pricing rate |

## What's intentionally NOT here yet (see blueprint for full roadmap)

- **Gateway Proxy** (Phase 2) — this MVP is log-integrator only; nothing sits in your live request path
- **Alert delivery** (Slack/Email/PagerDuty) — `budgets/status` gives you the tier data; wiring up
  delivery is a short follow-on (a cron job calling this endpoint + a webhook is enough to start)
- **Quality/eval layer for optimization recommendations** — flagged as the highest-priority addition
  in the blueprint; not built yet since there's no recommendation engine in this MVP slice
- **Shadow AI detection, semantic caching, SSO/RBAC, SOC2 controls** — enterprise-phase features, not MVP

## Upgrading beyond free/local later

When you outgrow SQLite (rough guide: single-digit millions of events, or you need concurrent
writers), the natural next step per the blueprint is Postgres for metadata + ClickHouse or
TimescaleDB for the event table — the route files won't need to change much, only `db.js`.
