# FinOps Guard

[![CI](https://github.com/kunnalsinghm/finops-mvp/actions/workflows/ci.yml/badge.svg)](https://github.com/kunnalsinghm/finops-mvp/actions/workflows/ci.yml)

**A self-hosted gateway that meters, governs and optimizes what you spend on LLM APIs** (OpenAI, Anthropic) and self-hosted GPU inference.

Point your OpenAI or Anthropic client at it and every call is priced, attributed to a team, checked against budgets and policies, and recorded, in the request path, with streaming supported. Run it on SQLite with zero setup, or on Postgres for a hosted single-tenant or multi-tenant deployment.

*Developed and maintained by Vidhi Sharma and kunal.sm.*

## What you get

| | |
|---|---|
| **Cost tracking** | Per-call cost from a pricing catalogue; breakdowns by team, model, feature, customer, project, cost center and region; forecasting; prepaid-commitment tracking; weekly briefings |
| **Budget enforcement** | Soft (degrade to a cheaper model) and hard (`402`) limits, progressive alerts, burn-rate alerts, token quotas, per-key rate limits |
| **Safety** | PII redaction, prompt-injection blocking, model allow-lists, data-residency checks, tool-call governance with human approval |
| **Anomaly and fraud detection** | Org-wide anomalies, plus per-key fraud signals that can auto-quarantine a key |
| **Optimization** | Model-switch recommendations, exact and semantic caching, shadow A/B testing against a cheaper model |
| **Access control** | Six API-key roles, dashboard logins, invitations, password reset by email, OIDC single sign-on |
| **Operations** | Health and readiness probes, graceful shutdown, verified backups, versioned migrations, a durable metering spool |
| **Multi-tenancy** | Schema-per-tenant on Postgres, tenant lifecycle, quotas and an operator overview |
| **Interfaces** | Dashboard UI, REST API under `/api/v1`, OpenAPI document, zero-dependency client SDK, FinOps-as-Code via `finops.yaml` |

Full detail for every item: [docs/features.md](docs/features.md).

## Quick start

You need **Node.js 22 or newer** (the SQLite driver, `node:sqlite`, is built in; CI and the Docker image run Node 22).

```bash
npm install
npm run seed      # optional: ~2 weeks of sample usage data
npm run serve     # starts with auto-restart on crash (or: npm start)
```

Open `http://localhost:4000`.

**Docker**

```bash
docker compose up --build                      # SQLite (default)
docker compose --profile postgres up --build   # Postgres
```

### First five minutes

A fresh install is in **bootstrap mode**: every request is served as admin until you create the first API key or user, which closes that window (see [Bootstrap mode](#bootstrap-mode)). Create the key first.

```bash
# 1. Create your first admin API key. The response contains the key_id; keep it.
curl -X POST http://localhost:4000/api/keys \
  -H "Content-Type: application/json" \
  -d '{"label":"my-first-key","role":"admin"}'

# 2. Create a dashboard login (needs the key from step 1, because bootstrap mode is now closed).
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" -H "X-API-Key: fk_..." \
  -d '{"username":"you","password":"a-real-password","role":"admin"}'

# 3. Send an LLM call through the gateway.
curl -X POST http://localhost:4000/api/proxy/openai \
  -H "Content-Type: application/json" \
  -H "X-API-Key: fk_..." \
  -H "X-Provider-Key: sk-your-real-openai-key" \
  -H "X-Team: growth" -H "X-Environment: dev" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

The response is the provider's, unchanged, plus headers such as `X-FinOps-Cost-USD`. Your provider key is forwarded and never stored. Sign in to the dashboard with the username and password from step 2.

To try it without spending anything, run the local stand-in provider in a second terminal and point the gateway at it:

```bash
node scripts/mock-provider.js                                          # listens on :5001
OPENAI_BASE_URL=http://localhost:5001/v1/chat/completions npm start    # in the first terminal
```

### Use it from code

Either change your client's `baseURL` to `http://localhost:4000/api/proxy/openai` (or `anthropic`) and send the headers above, or use the bundled client:

```js
const { FinOpsClient } = require("./sdk/finops-client");
const client = new FinOpsClient({
  baseUrl: "http://localhost:4000",
  apiKey: "fk_...",          // your FinOps Guard key
  providerKey: "sk-...",     // your real provider key
  team: "growth",
  environment: "prod",
});
const reply = await client.chat("openai", {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hello" }],
});
```

Events from systems that do not go through the gateway can be sent to `POST /api/ingest`.

## How it works

Two ways data gets in:

1. **Gateway proxy** (`POST /api/proxy/:provider`): metering, governance and opt-in caching in the request path, with streaming (SSE).
2. **Log integrator** (`POST /api/ingest`): webhook-style recording of events you already have.

Both write to the same `usage_events` table, which feeds budgets, alerts, reports and attribution. Self-hosted GPU cost goes in `gpu_usage_events` and is blended with API spend into one per-team view.

The proxy calls the provider first and records the usage afterwards, so a recording failure cannot undo spend that already happened. If the write fails, the response still goes back to the caller and the event is spooled to disk for `npm run replay-spool` (details in [docs/guarantees.md](docs/guarantees.md)).

**Stack:** Node.js and Express; SQLite (`node:sqlite`) or Postgres; vanilla HTML/CSS/JS with Chart.js and no build step; Helmet, `scrypt` password hashing and login rate limiting; optional Stripe billing; Node's built-in test runner.

## Deployment modes

| Mode | Driver | Who it's for |
|---|---|---|
| **Single-tenant, local** (default) | SQLite | Self-hosted, one team, zero config |
| **Single-tenant, hosted** | Postgres (`FINOPS_DB_DRIVER=postgres`) | One customer's own hosted deployment |
| **Multi-tenant, hosted** | Postgres + `FINOPS_MULTI_TENANT=true` | Serving several customers from one deployment |

Multi-tenant mode isolates each tenant in its own Postgres schema with its own connection pool, and routes every request through a shared control-plane schema. Operators manage tenants through `/api/platform/*`, which is gated by `FINOPS_PLATFORM_ADMIN_TOKEN`. How it works, and what it proves: [docs/multi-tenancy.md](docs/multi-tenancy.md).

**Run a single instance for now.** Dashboard sessions, SSO state and rate-limit buckets are held in memory, and there is no shared job lock, so a second instance behind a load balancer breaks logins and runs every scheduled job twice. The plan to lift this is [RFC 0001](docs/rfcs/0001-horizontal-scaling-and-iac.md); graceful shutdown, its first step, is done.

## Configuration

Copy `.env.example` to `.env`. Everything works without any of these set. The ones you are most likely to need:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `FINOPS_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` exposes the server, including bootstrap mode, to your network |
| `FINOPS_TRUST_PROXY` | none | Trust `X-Forwarded-For` from your load balancer so per-IP rate limits see the real client. A hop count (`1`) or a list of proxy IPs/CIDRs (`10.0.0.0/8,192.168.1.5`). Invalid values, including `true`, stop the server from starting |
| `FINOPS_DB_DRIVER` | `sqlite` | `sqlite` or `postgres` |
| `FINOPS_POSTGRES_URL` | none | Connection string; required for Postgres |
| `FINOPS_DB_PATH` | `data/finops.db` | SQLite file |
| `FINOPS_MULTI_TENANT` | off | `true` enables multi-tenant mode (Postgres only) |
| `FINOPS_PLATFORM_ADMIN_TOKEN` | none | Enables `/api/platform/*`; unset means those routes return `404` |
| `FINOPS_STRICT_IDENTITY` | off | `true` refuses API keys that are not bound to a team |
| `FINOPS_UNPRICED_POLICY` | flag | `block` refuses models that have no price instead of flagging them |
| `FINOPS_METERING_FAILURE_POLICY` | open | `closed` refuses requests while the usage store is unreachable |
| `FINOPS_UPSTREAM_TIMEOUT_MS` | `120000` | How long a hung provider can hold a request (`504`) |
| `FINOPS_RATE_LIMIT_CAPACITY` / `FINOPS_RATE_LIMIT_REFILL_PER_SEC` | `60` / `1` | Per-key token bucket |
| `FINOPS_SHUTDOWN_GRACE_MS` | `25000` | How long to wait for in-flight requests on `SIGTERM` |
| `FINOPS_BACKUP_RETENTION` / `FINOPS_BACKUP_DIR` | `7` / `data/backups` | Backups kept and where SQLite backups go |
| `FINOPS_SPOOL_PATH` | `data/metering-spool.jsonl` | Where unrecorded usage events wait for replay |
| `FINOPS_LOG_DIR` | `logs` | Structured JSON logs, rotated daily |
| `FINOPS_APP_URL` | relative links | Public base URL used in emailed links (reset, verify, invite) |
| `FINOPS_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | none | SMTP for alert and account emails |
| `FINOPS_ALERT_EMAIL_TO` / `FINOPS_ALERT_EMAIL_FROM` | none | Alert email recipient and sender |
| `SLACK_WEBHOOK_URL` | none | Slack alerts |
| `FINOPS_WEBHOOK_URL` / `FINOPS_WEBHOOK_SECRET` | none | Generic alert webhook; the secret signs each request ([details](docs/features.md)) |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | none | Single sign-on |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | none | Platform billing; without them billing routes return `501` |
| `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | provider defaults | Point the gateway at another endpoint, such as the mock provider |
| `FINOPS_OTEL_ENABLED` | off | `true` prints one OpenTelemetry-shaped JSON line per proxied request ([plan for a real exporter](docs/rfcs/0002-opentelemetry-exporter.md)) |

Less common tuning variables:

| Variable | Default | Purpose |
|---|---|---|
| `FINOPS_FRAUD_AUTO_QUARANTINE_MIN_SIGNALS` | `2` | Concurrent fraud signals needed to auto-quarantine a key (one signal only recommends rotation) |
| `FINOPS_DB_HEALTH_TIMEOUT_MS` | `2000` | Timeout of the readiness database check |
| `FINOPS_DB_CIRCUIT_FAILURE_THRESHOLD` / `FINOPS_DB_CIRCUIT_OPEN_MS` | `3` / `30000` | Readiness circuit breaker |
| `FINOPS_SIGNUP_RATE_LIMIT` | `10` | Tenant signups allowed per minute, across all callers (a global cap, not per IP) |
| `FINOPS_SEMANTIC_CACHE_MODE` / `_THRESHOLD` | `local` | Semantic cache mode and similarity threshold |
| `FINOPS_SHADOW_TEST_SAMPLE_RATE` and related | see `.env.example` | Shadow A/B testing |

[`.env.example`](.env.example) lists the rest with comments.

## Operations

**Health.** `GET /health` is liveness (the process is up). `GET /health/ready` is readiness: it queries the database and returns `503` with a reason if it cannot, and also while the server is shutting down.

**Graceful shutdown.** On `SIGTERM` or `SIGINT` the server stops accepting connections, lets in-flight requests finish (so a provider call already made is still metered), closes the database and exits `0`. Past `FINOPS_SHUTDOWN_GRACE_MS` it cuts what remains and exits `1`. Set your orchestrator's stop timeout above that value (`docker-compose.yml` uses 30 s). This does not cover `SIGKILL`, power loss or an out-of-memory kill, and on Windows `SIGTERM` ends the process without running any code.

**Backups.** SQLite: a verified snapshot at startup and every 6 hours. Postgres: `pg_dump` snapshots in single-tenant mode, verified by restoring into a throwaway database. Commands: `npm run backup`, `npm run backup:verify`, `npm run restore`. In multi-tenant mode backups are manual, because a restore replaces every tenant at once. Procedure and measured recovery times: [docs/backup-restore-runbook.md](docs/backup-restore-runbook.md) and [docs/reliability.md](docs/reliability.md).

**Migrations.** Schema changes are numbered, checksummed migrations applied at startup. SQLite takes a verified snapshot first. **On Postgres, take your own `pg_dump` before upgrading.** The multi-tenant control-plane and tenant schemas are not covered by the migrator yet.

**Metering spool.** If recording a usage event fails after a successful provider call, the event is written to the spool file and an alert is raised. Recover it with `npm run replay-spool`.

**Behind a reverse proxy.** By default the server ignores `X-Forwarded-For`, so every client appears to come from the proxy's address and the login and password-reset rate limits become one global bucket for everyone. Set `FINOPS_TRUST_PROXY` to fix that: use the number of proxies between the internet and the server (`1` for a single load balancer), or list the proxy addresses (`10.0.0.0/8`). Count carefully. A hop count higher than the real number of proxies, or a range wider than your proxies, lets any client choose its own address by sending the header, which defeats the rate limits. The server refuses to start on `true`, on ranges that match every address, and on anything it cannot parse.

**Load testing.** `npm run loadtest` drives the proxy with concurrent requests; point it at `scripts/mock-provider.js` for zero API cost. Results so far: [docs/load-test-results.md](docs/load-test-results.md).

## Bootstrap mode

On a fresh install, before you have created your first API key or user, **every request is served as admin** in single-tenant mode. This is deliberate local-development convenience. Creating a key or user closes the window automatically. Multi-tenant mode has no bootstrap window.

The server binds to `127.0.0.1` by default, so the window cannot be reached from another machine. Setting `FINOPS_HOST=0.0.0.0` exposes it to your network until you create the first key or user; the server logs a `[WARN]` when that is the case.

## API

Every route group is served at `/api/<name>` and at the stable, versioned `/api/v1/<name>`. A machine-readable OpenAPI description of the proxy, ingest, keys, auth and invites groups is at `GET /api/v1/openapi.json`. The other groups work under `/api/v1` but are not described there yet.

Main groups: `ingest`, `proxy`, `costs`, `budgets`, `alerts`, `keys`, `auth`, `invites`, `agents`, `tags`, `tool-calls`, `gpu-usage`, `recommendations`, `shadow-test`, `reconcile`, `audit`, `data`, `backup`, `billing`, `gitops`, `tenants`, `platform`.

The full route table, with methods and purposes: [docs/api-reference.md](docs/api-reference.md).

### FinOps as Code

`finops.yaml` declares budgets and tagging rules; `POST /api/gitops/sync` applies them and removes anything no longer in the file. A starting point is [`finops.yaml.example`](finops.yaml.example).

```yaml
budgets:
  - scope_type: team
    scope_value: growth
    monthly_limit_usd: 5000

tagging_rules:
  - match:
      api_key_prefix: "fk_growth_"
    assign:
      team: growth
      environment: prod
```

## Testing

```bash
npm test                                                      # SQLite
FINOPS_DB_DRIVER=postgres FINOPS_POSTGRES_URL=postgres://user:pass@host:5432/db \
  npm test -- --test-concurrency=8                            # Postgres, empty database
```

As of this writing the SQLite run has 696 tests (685 pass, 11 skipped: the suites that need Postgres) and the Postgres run has 797 (796 pass, 1 skipped). The counts change as tests are added; the point is that both backends are green. CI runs both, plus a Docker build, on every push and pull request to `main`.

Some tests start the real server and send it a real `SIGTERM`; they are skipped on Windows. Tests write scratch databases to `test/.tmp-*` (git-ignored) and `npm test` removes leftovers first. Live provider calls, a real identity provider and real Stripe checkout cannot be automated; see [docs/known-gaps.md](docs/known-gaps.md) for what you need to verify yourself.

## Project layout

```
server/        Express app, routes/, storage/ (SQLite and Postgres adapters, migrations)
public/        Dashboard and account pages (no build step)
sdk/           Zero-dependency client for the proxy
scripts/       supervisor, backup/restore, load test, mock provider, spool replay
test/          node --test suites
docs/          Detailed reference, runbooks, RFCs
```

## Documentation

| | |
|---|---|
| [docs/features.md](docs/features.md) | Every feature in depth |
| [docs/api-reference.md](docs/api-reference.md) | Route table, versioning, OpenAPI |
| [docs/multi-tenancy.md](docs/multi-tenancy.md) | Isolation model, tenant lifecycle, operator overview |
| [docs/guarantees.md](docs/guarantees.md) | Identity, pricing and metering rules |
| [docs/reliability.md](docs/reliability.md) | Probes, shutdown, backups, RTO/RPO |
| [docs/backup-restore-runbook.md](docs/backup-restore-runbook.md) | Backup and restore procedure |
| [docs/stripe-live-checkout-runbook.md](docs/stripe-live-checkout-runbook.md) | Verifying Stripe billing end to end |
| [docs/load-test-results.md](docs/load-test-results.md) | Measured throughput |
| [docs/known-gaps.md](docs/known-gaps.md) | What is not built, and what is not verified |
| [docs/tech-stack-migration-plan.md](docs/tech-stack-migration-plan.md) | TypeScript, React, queue, OpenTelemetry, S3: assessed one by one |
| [docs/rfcs/](docs/rfcs/) | Plans: [scaling and infrastructure](docs/rfcs/0001-horizontal-scaling-and-iac.md), [OpenTelemetry exporter](docs/rfcs/0002-opentelemetry-exporter.md), [dashboard framework](docs/rfcs/0003-dashboard-framework.md) |
| [CHANGELOG.md](CHANGELOG.md) | What changed, newest first |

## Status

Working and tested: everything under "What you get", on both SQLite and Postgres. Not built yet, by design and with written plans: running more than one instance, infrastructure-as-code, a real OpenTelemetry exporter, centralized logging and metrics, a secrets-manager integration and usage-based billing. The most important current limits:

- One instance only (see [Deployment modes](#deployment-modes)).
- PII redaction, prompt-injection and risky-command detection are pattern-based, not ML classifiers, and are not a compliance guarantee.
- Data-residency checks rely on a client-declared region header, not IP geolocation.
- Postgres backups are periodic snapshots, not point-in-time recovery.
- Recovery times and load numbers were measured on small datasets on a development machine; re-measure before putting them in an SLA.

The complete list is in [docs/known-gaps.md](docs/known-gaps.md).

## License

MIT
