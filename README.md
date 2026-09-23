# FinOps Guard — Self-Hosted AI API Cost Management Platform

**Developed and maintained by Vidhi Sharma and kunal.sm**

A platform for tracking, governing, and optimizing spend on LLM APIs (OpenAI, Anthropic) plus self-hosted GPU inference. Runs single-tenant on SQLite with zero setup for local/self-hosted use, or opts into Postgres — single-tenant or fully multi-tenant — for a hosted deployment. Real-time cost metering, hard/soft budget enforcement, RBAC, PII/prompt-injection protection, fraud detection, agent-level cost attribution, data-residency enforcement, caching, shadow A/B model testing, Stripe billing, and a themeable dashboard UI.

Runs on `localhost:4000` from VS Code with three commands: `npm install`, `npm run seed`, `npm start` (or `npm run serve` for crash auto-restart).

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite by default (via `node:sqlite`, no native compilation) — or Postgres (`FINOPS_DB_DRIVER=postgres`) for a hosted single-tenant or multi-tenant deployment
- **Frontend:** Vanilla HTML/CSS/JS + Chart.js, zero build step, custom light/dark design system
- **Security:** Helmet (security headers), IP-based login rate limiting, `scrypt` password hashing
- **Billing:** Stripe subscriptions for the platform's own flat-fee tiers (optional — off unless `STRIPE_SECRET_KEY` is set)
- **Testing:** Node's native test runner (`node --test`) — zero external test dependencies
- **Deployment:** Docker + `docker-compose.yml`, GitHub Actions CI (tests against both SQLite and Postgres, plus a Docker build check)
- **Config:** `finops.yaml` for GitOps-style budget management and declarative tagging rules

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

Or with Docker:

```bash
docker compose up --build                    # SQLite (default)
docker compose --profile postgres up --build # Postgres
```

## Architecture

Two ways data gets in:

1. **Log Integrator** (`POST /api/ingest`) — webhook-style event recording.
2. **Gateway Proxy** (`POST /api/proxy/:provider`) — point your OpenAI/Anthropic client's `baseURL` here. Real-time metering, governance, and opt-in caching enforced in the request path, with full streaming (SSE) support.

Both write to the same `usage_events` table and share the same budgeting/alerting/reporting/attribution layer. A separate `gpu_usage_events` table tracks self-hosted GPU inference cost, blended with API spend into one normalized view (see "Unified GPU + API cost view" below).

## Deployment modes

| Mode | Driver | Who it's for |
|---|---|---|
| **Single-tenant, local** (default) | SQLite | Self-hosted, one team, zero config |
| **Single-tenant, hosted** | Postgres (`FINOPS_DB_DRIVER=postgres`) | One customer's own hosted deployment |
| **Multi-tenant, hosted** | Postgres (`FINOPS_DB_DRIVER=postgres` + `FINOPS_MULTI_TENANT=true`) | Serving multiple customers from one deployment |

Multi-tenant isolation is **schema-per-tenant with a dedicated Postgres connection pool per tenant** (`server/tenancy.js`), not a shared pool with a per-request `search_path` reset — a tenant's connections are physically incapable of serving another tenant's query, by construction, rather than relying on every call site remembering to reset state. Identity/routing data (which tenants exist, which API keys/users belong to which tenant) lives in a separate shared `control_plane` schema; a request resolves its tenant there first, then gets routed to that tenant's own schema for everything else.

**Not yet supported in multi-tenant mode:** dashboard session login (`/api/auth/login`) — the session store is a single global in-memory map with no tenant concept, so it's deliberately disabled (`501`) rather than risk a cross-tenant leak. Use an `X-API-Key` in multi-tenant mode until this is built.

**What is tenant-scoped, and what is switched off.** The data-plane routes (`ingest`, `proxy`, `costs`, `budgets`, `keys`, `pricing`, `cache`, `semantic-cache`, `agents`, `tags`, `gpu-usage`, and the allow-list / quota / residency / shadow-test / recommendation routes) read and write only the calling tenant's schema via `req.db`, and the in-memory response caches are keyed per tenant. Two-tenant tests over real HTTP against the real routes cover this (`test/multiTenantIsolation.test.js`, `test/multiTenantHardening.test.js`; Postgres only). The route groups that have **not** been converted yet — `alerts`, `commitments`, `gitops`, `reconcile`, `reports`, `query`, `tool-calls` (list in `server/tenantGuard.js`) — answer `501` in multi-tenant mode instead of silently serving the default schema. In multi-tenant mode the periodic alert / commitment / weekly-briefing jobs and the SQLite backup do not cover tenants either.

## Features

### Cost tracking & attribution
- Per-event cost from a local pricing catalogue with manual overrides
- Team/environment/git-branch/feature/customer/project/cost-center tagging (`X-Feature-Id`, `X-Customer-Id`, `X-Project-Id`, `X-Cost-Center` on the proxy, or the equivalent body fields on ingest) — missing tags warn, not reject
- Dashboards: cost over time, cost by team, by model, by feature, by customer, by project, by cost center, by region, untagged spend
- **Spend forecasting**: a simple moving-average projection (`GET /api/costs/forecast`) — averages recent daily spend (default: last 7 days) and extends it forward (default: 30 days). Refuses to forecast (`available: false`) with fewer than 3 days of data rather than returning a falsely-precise number
- **Forecast variance** (`GET /api/costs/forecast-variance?team=`): actual vs. predicted spend for a team's most recent 7-day window, as a governance signal ("our own forecast was off by X%")
- **Commitment tracking**: prepaid credit balances tracked against real burn (`/api/commitments`), with tiered remaining-balance alerts (healthy → low → critical → exhausted)
- **Weekly briefings**: an auto-generated digest (total spend, week-over-week delta, top 3 movers by team) delivered through the same channels as budget alerts, once per ISO week
- **Unified GPU + API cost view** (`/api/gpu-usage/blended`): self-hosted GPU inference cost (`/api/gpu-usage/ingest`) blended with API spend into one normalized per-team total. A cluster shared across teams has its cost **split proportionally by each team's relative API spend** (`shared_across_teams` field) — a documented approximation, not a precisely measured allocation, since there's no per-team GPU-utilization telemetry to split by instead
- **Agent-level attribution** (`/api/agents`): per-agent cost-per-task, cost-per-successful-completion (excludes tasks that never reached `success`), retry rate (fraction of tasks needing more than one event), and a token-efficiency-ratio proxy — set via `X-Agent-Id`/`X-Session-Id`/`X-Task-Id`/`X-Task-Status` on the proxy or the equivalent ingest fields. Each metric's exact formula and judgment calls are documented in `server/agentAttribution.js`
- **Smart/inferred tagging**: an untagged event gets a best-guess team inferred from that API key's own tagging history (never from the request content), with a time-of-day fallback for keys shared across teams on different schedules (e.g. day-shift/night-shift) when the key's overall history has no clear majority. Stored separately from the real tag and never silently applied — review via `GET /api/tags/inferences`, apply via `POST /api/tags/:usageEventId/correct`. A correction feeds back into future inferences for that key automatically, since it's written onto the real `team` column
- **"Ask your dashboard"** (`GET /api/query?q=`): plain-English queries like "what did we spend on the growth team last week" or "top spenders this month", answered by rule-based intent parsing — deliberately not LLM-backed (see `server/nlQuery.js` for why)

### Content safety & data protection
- **PII redaction** (on by default, opt out per-request via `X-Disable-PII-Redaction: true`): regex-based detection of email, SSN, credit card (Luhn-validated), phone, and IP address patterns. Redact-and-continue, not block. Applied at both the proxy and ingest
- **Prompt-injection detection** (always on, not opt-out): rule-based pattern matching against known jailbreak/injection phrasings. Blocks the request (HTTP 400). Applied at both the proxy and ingest
- **Data-residency enforcement**: block a request whose declared region (`X-Client-Region`) isn't on the applicable allow-list (`/api/region-allowlist`, key-then-team precedence, same pattern as model allow-listing below). Region is self-reported, not real IP geolocation — a real, useful control for well-behaved clients, not a substitute for network-level geofencing. The same self-reported region is also available as its own cost-breakdown dimension (`GET /api/costs/by-region`), independent of whether an allow-list is even configured
- **Agent action governance** (`/api/tool-calls`): audit trail for agent tool calls (file access, API calls, command execution) — distinct from LLM completions. Rule-based risky-command detection (destructive filesystem/database operations, privilege escalation), per-agent volume-spike detection, and the same data-residency check as above. This is a **reporting/audit mechanism, not a live blocking gate** — unlike the proxy checks, a tool call happens outside this service's control, so it can only be flagged for review, not stopped

### Governance (enforced live in the proxy)
- Token-bucket rate limiting per API key
- **Budget enforcement, two tiers**: over budget with a cheaper same-provider fallback configured → degrades to it (circuit breaker). Over budget with **no fallback available** → hard-blocks with `402`, rather than silently letting the request through unthrottled at full price
- **Background/continuous-inference budget class**: traffic tagged `X-Workload-Type: background` (24/7 monitoring/compliance-scanning agents) is exempt from the circuit-breaker/hard-block above — throttling it could break the function it exists to perform — but is still tracked and alertable via its own `scope_type: 'background'` budget, separate from that team's regular spend
- Quarantine mode: flagged keys capped to 1 req/min pending admin approval
- Single-request anomaly detection: flags any one event costing more than 5x the 30-day rolling average for that provider/model
- **Fraud/compromised-key detection**: flags a sudden request-volume spike, a brand-new provider/model combo on an otherwise-established key, or a first-time client region — all flag-only (logged to `/api/alerts`), never auto-blocking, since these are noisier signals than a single-request cost anomaly
- **Model allow-listing**: restrict specific keys/teams to a pre-approved list of models. Manage via `/api/model-allowlist`
- **Token quotas**: cap raw input+output token consumption per key/team over a daily and/or weekly window. Manage via `/api/token-quotas`

### Caching — two independent, opt-in tiers
- **Exact-match** (`X-Enable-Cache: true`): identical provider+model+message requests return a cached response, with tracked cost savings
- **Semantic/near-duplicate** (`X-Enable-Semantic-Cache: true`): catches reworded prompts that mean the same thing. Local zero-dependency word-overlap mode by default, or real OpenAI embeddings if `FINOPS_EMBEDDING_API_KEY` is set

### Budgeting & alerts
- Multi-tier budgets (team/project/key/background), progressive alerts (50/80/90/100%), burn-rate alerts
- `GET /api/alerts/status` — a consolidated status endpoint for external monitoring (unacknowledged count, broken down by type, most recent alert) to poll, rather than requiring a monitoring tool to interpret the raw log itself
- Delivery via Slack Incoming Webhook, a generic webhook (Discord/Teams/ntfy.sh/PagerDuty-compatible), and/or SMTP email; always logged locally regardless of delivery config

### Optimization engine
- Rule-based model-switch recommendations, each starting with an explicit caveat: cost-only estimate, quality unverified
- **Shadow A/B testing** (opt-in via `X-Enable-Shadow-Test: true`): a sample of real traffic is also sent to the recommended cheaper model, purely to compare — non-streaming requests only. Once a model pair has enough samples, `/api/recommendations` reports a real measured confidence: `shadow-tested-similar` or `shadow-tested-diverges`
- Caching-opportunity heuristic for repeated/templated prompt patterns

### Shadow-spend reconciliation
- Upload a provider billing CSV (`date,provider,cost`) to compare reported vs. tracked spend per day/provider
- Re-uploading a period replaces prior numbers rather than double-counting

### Billing (the platform's own subscription — separate from the AI spend it tracks)
- Stripe Checkout for the two flat-fee tiers (`$999/mo` up to 5 members, `$2,500/mo` unlimited) via `POST /api/billing/checkout-session`
- A dedicated raw-body webhook route (`POST /api/billing/webhook`, mounted before the app's global JSON parser — Stripe signature verification needs the untouched raw body)
- Cleanly returns `501`, not a crash, when `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` aren't set — see `docs/stripe-live-checkout-runbook.md` for the manual end-to-end verification steps a real Stripe test-mode account requires (this can't be fully automated in CI)

### Access control
- API keys (roles: admin, budget-manager, developer, viewer) for services/the proxy
- Session-based human login for the dashboard, `scrypt`-hashed passwords (single-tenant mode only — see "Deployment modes")
- Spec-compliant OIDC (SSO) client — needs your own identity provider app registration to fully activate

### Audit & data governance
- Immutable audit trail for all administrative actions (budget changes, key lifecycle, pricing overrides, tag corrections, region allow-list changes)
- Data export (JSON/CSV) and explicit-cutoff retention purging via `/api/data`
- **FOCUS-spec export** (`/api/data/export/focus`) — includes both API and GPU spend in one unified schema. A GPU row from a shared cluster carries its split-allocation method in `Tags`, so a reader can tell an allocated number apart from a directly-measured one

### Reliability & operations
- **Security:** Helmet security headers, IP-based login rate limiting (10 attempts / 15 min)
- **Logging:** structured JSON logs written to `logs/`, daily rotation
- **Backups:** automatic SQLite backup on boot and every 6 hours, retention-pruned; manual trigger via `npm run backup`
- **Crash recovery:** `npm run serve` runs a self-written supervisor that respawns the server on crash with exponential backoff
- **Load testing:** `npm run loadtest` — a dependency-free concurrent load test against the proxy (point it at `scripts/mock-provider.js` for zero real API cost), reporting throughput and latency percentiles. This is the closest thing to an automated answer for "is the proxy actually fast enough" — genuine load behavior still needs a human to run this and read the output, not something a unit test can assert

### FinOps as Code
- `finops.yaml` defines budgets declaratively; `POST /api/gitops/sync` pushes them in and removes any budget no longer in the file
- `finops.yaml` also defines declarative tagging rules under `tagging_rules:` — `- match: { api_key_prefix }` / `assign: { team, environment, project_id, cost_center, customer_id, feature_id }` — synced by the same `POST /api/gitops/sync` call, same create/update/remove-drift semantics as budgets. A rule only fills in a field the caller left blank; it never overrides an explicit tag or a key's bound team (see `server/tagRules.js` for the full precedence order against smart/inferred tagging and key-team binding). Longest-matching-prefix wins when more than one rule matches the same key, so a team can declare a broad default and a narrower override without the two being order-dependent

Example `finops.yaml` (also in `finops.yaml.example`):
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
  - match:
      api_key_prefix: "fk_growth_eu_"
    assign:
      team: growth
      environment: prod
      project_id: eu-checkout
      cost_center: cc-4821
```

### Testing
- 471 automated tests on SQLite / 508 on Postgres, all passing (`npm test`) — covering every feature above, plus multi-tenant schema/pool isolation
- `scripts/mock-provider.js` — a local stand-in for the OpenAI/Anthropic APIs, so the full proxy flow (including load testing) can be exercised end-to-end at zero real API cost

### Client SDK
- `sdk/finops-client.js` — a zero-dependency wrapper for calling the proxy without hand-managing headers, supporting both standard and streaming requests

### CI/CD
- GitHub Actions (`.github/workflows/ci.yml`): runs the full test suite against both SQLite and Postgres backends, plus a Docker build check, on every push/PR to `main`

## API reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest` | Record a usage event |
| POST | `/api/proxy/:provider` | Proxy a request to `openai`/`anthropic` (streaming + caching + agent-attribution headers supported) |
| GET | `/api/costs/summary` \| `/by-team` \| `/by-model` \| `/by-feature` \| `/by-customer` \| `/by-project` \| `/by-cost-center` \| `/by-region` \| `/over-time` \| `/untagged` | Cost dashboards |
| GET | `/api/costs/forecast` | Simple moving-average spend projection |
| GET | `/api/costs/forecast-variance?team=` | Actual vs. predicted spend for a team |
| GET/POST | `/api/budgets` | List / create budgets (scope: team/project/key/background) |
| GET | `/api/budgets/status` | Budgets with spend-to-date and alert tier |
| GET/POST/DELETE | `/api/commitments` | Prepaid credit balance tracking |
| GET | `/api/reports/weekly/preview` \| POST `/send-now` | Weekly digest preview / manual send |
| GET/POST | `/api/agents` | Per-agent cost attribution summaries |
| GET | `/api/agents/:agentId` \| `/tasks` | One agent's summary / task-level breakdown |
| GET | `/api/tags/inferences` | Smart-tagging inferences awaiting review |
| POST | `/api/tags/:usageEventId/correct` | Confirm/correct an inference, applying it as a real tag |
| GET/POST/DELETE | `/api/region-allowlist` | Data-residency allow-list management |
| GET/POST | `/api/tool-calls` | Agent tool-call audit log / ingestion |
| POST | `/api/gpu-usage/ingest` | Record GPU/self-hosted inference cost |
| GET | `/api/gpu-usage/blended` | Combined API + GPU cost per team |
| GET | `/api/query?q=` | Plain-English dashboard query |
| GET | `/api/pricing/catalogue` | View baseline pricing |
| POST | `/api/pricing/override` | Correct/add a pricing rate |
| GET/POST | `/api/keys` | List / create API keys |
| POST | `/api/keys/:id/quarantine` \| `/approve` \| `/revoke` | Key governance actions |
| GET | `/api/alerts` | Alert log |
| GET | `/api/alerts/status` | Consolidated alert status for monitoring |
| POST | `/api/alerts/check-now` | Manually trigger budget/burn-rate checks |
| GET/POST | `/api/model-allowlist` | List / add allow-list entries |
| DELETE | `/api/model-allowlist/:id` | Remove an entry (admin only) |
| GET/POST | `/api/token-quotas` | List / add quotas |
| DELETE | `/api/token-quotas/:id` | Remove a quota (budget-manager or admin) |
| GET | `/api/recommendations` | Optimization suggestions |
| GET | `/api/shadow-test/summary` \| `/comparisons` | Shadow A/B test results |
| POST | `/api/gitops/sync` | Sync budgets and declarative tagging rules from `finops.yaml` |
| POST | `/api/auth/register` \| `/login` \| `/logout` | Human user accounts (single-tenant mode) |
| GET | `/api/sso/login` \| `/callback` | OIDC SSO flow |
| POST | `/api/reconcile/upload` | Import a billing CSV |
| GET | `/api/reconcile/report` | Shadow-spend comparison report |
| GET | `/api/audit` | Audit trail (admin only) |
| GET | `/api/cache/stats` \| POST `/clear` | Exact-match cache statistics / manual clear |
| GET | `/api/semantic-cache/stats` \| POST `/clear` | Semantic cache statistics / manual clear |
| GET | `/api/data/export` \| `/export/focus` | Export usage events (JSON/CSV) / unified FOCUS-spec export (API + GPU) |
| DELETE | `/api/data/purge` | Retention purge (explicit cutoff required) |
| GET/POST | `/api/backup` \| `/run` | List / trigger backups |
| GET/POST | `/api/billing/plans` \| `/checkout-session` | Platform subscription plans / Stripe Checkout |
| GET | `/api/billing/status` | Current platform subscription status |
| POST | `/api/billing/webhook` | Stripe webhook receiver (raw body) |
| GET | `/health` | Unauthenticated liveness probe (Docker `HEALTHCHECK`, load balancers) |

## Configuration

Copy `.env.example` to `.env`. Vars worth understanding before you touch them: `FINOPS_HOST` (see "Bootstrap mode"), `FINOPS_DB_DRIVER` and `FINOPS_MULTI_TENANT` (see "Deployment modes"), `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` (see "Billing" above and `docs/stripe-live-checkout-runbook.md`).

## Identity, pricing and metering guarantees

These are the rules the proxy enforces so that a budget means what it says.

**Who a request is acting as.** A key can be *bound* to a team (`POST /api/keys` with `team`, or `PATCH /api/keys/:keyId`). A bound key's team is authoritative: usage, budgets, allow-lists and quotas all apply to it whatever headers the client sends, and an `X-Team` that names a different team is refused `403`. An *unbound* key still falls back to the `X-Team` header for backward compatibility — but that is a self-declared label, and a client can omit it to avoid team-scoped limits. Set `FINOPS_STRICT_IDENTITY=true` to refuse unbound keys on the proxy.

**Which key sent an event.** Every usage event records `key_id`: the API key that actually authenticated the request. This is distinct from `user_id`, which `/api/ingest` lets the client declare, so `key_id` is the one to trust when you need to act on the source of an event (for example, quarantining the key behind a runaway agent via `POST /api/keys/:keyId/quarantine`). It is `NULL` for dashboard-session logins and bootstrap mode, since neither is a revocable key. Existing databases gain the column on startup and are backfilled where `user_id` matches a real key (best-effort: rows with a client-declared `user_id` stay `NULL`).

**Background workloads.** `X-Workload-Type: background` exempts a request from the budget degrade/hard-block, so it is a privilege an admin grants to a key (`allow_background: true`), not something a caller can assert. A key without it that sends the header gets `403`. Upgrade note: existing keys default to `allow_background = 0`, so any service that relied on sending the header must be granted it.

**Pricing.** Model IDs are normalized (a dated snapshot such as `gpt-4o-2024-08-06` is priced as `gpt-4o`), and the catalogue covers current OpenAI and Anthropic models. A *new* model in a known family is priced by a family guess and labelled approximate (`X-FinOps-Price-Approximate`); a model with **no** price is never silently costed at $0 without a trace — it is flagged (`X-FinOps-Unpriced`, an alert, an `unpriced` marker on the event) or, with `FINOPS_UNPRICED_POLICY=block`, refused. `GET /api/pricing/unpriced` lists everything currently unpriced or approximate. The catalogue is a dated snapshot, not a live feed — verify against your provider's pricing page and correct with `POST /api/pricing/override`.

**Metering durability.** Usage is recorded *after* the provider call, so a recording failure can't undo the spend. The proxy therefore (a) always returns the provider's response, (b) spools the un-recorded event to `data/metering-spool.jsonl` and alerts, and (c) lets you recover it with `npm run replay-spool`. A stream that is cut short — by the client or the provider — is metered with the usage seen so far and flagged `partial` (OpenAI only reports usage at the very end of a stream, so a cut-short OpenAI stream may record zero tokens). `FINOPS_METERING_FAILURE_POLICY=closed` additionally refuses requests up front while the usage store is unreachable. `FINOPS_UPSTREAM_TIMEOUT_MS` bounds how long a hung provider can hold a request (`504`).

## Backups, restore and migrations

SQLite backups are consistent snapshots (`VACUUM INTO`), verified the moment they are written, taken at startup and every 6 hours into `data/backups/`. `npm run backup:verify` proves the newest one is restorable by the current code; `npm run restore -- --latest --force` restores it (stop the server first; the replaced database is moved aside, never deleted). Schema changes are versioned migrations applied automatically at startup, with a verified snapshot taken first, so you no longer delete `data/finops.db` after a schema change. Full procedure: [docs/backup-restore-runbook.md](docs/backup-restore-runbook.md).

## Bootstrap mode

On a fresh install, before you've created your first API key or user, **every request is served as admin** in single-tenant mode — deliberate local-dev convenience. Once you create a key or user, this window closes automatically. (Multi-tenant mode has no bootstrap window — see "Deployment modes.")

The server binds to `127.0.0.1` by default, so the bootstrap window can't be reached from anywhere else. Setting `FINOPS_HOST=0.0.0.0` exposes it network-wide, including the bootstrap window, until you create your first key/user — the server logs a loud one-time `[WARN]` on boot and on first bootstrap-mode access.

## What's tested vs. what needs your own verification

**Tested live during development:** proxy metering (streaming + non-streaming, both providers), the two-tier budget enforcement (soft degrade + hard block), background-workload exemption, data-residency blocking, agent-attribution field threading, fraud/anomaly detection, commitment/weekly-briefing alerting, GPU blended cost + FOCUS split allocation, rate limiting, quarantine, RBAC, GitOps sync, reconciliation with dedupe, session login + SSO mechanics against a mock IdP, exact-match caching, security headers, login rate limiting, automatic backups, crash-restart via the supervisor, Stripe's "not configured" paths and webhook event application, and multi-tenant schema creation / connection pool isolation — against **both** SQLite and Postgres.

**Needs your own verification:** a live request against your real OpenAI/Anthropic account, a live SSO handshake against your real identity provider, an actual Stripe test-mode checkout end-to-end (see `docs/stripe-live-checkout-runbook.md` — this genuinely can't be automated), and the proxy under real production-like concurrent load (`npm run loadtest` gets you the tooling; reading and acting on the results is still on you).

## Known gaps

- Token quotas are checked using consumption *so far*, not including the current request — the request that crosses the threshold is still allowed through; only the next request after that is blocked. Deliberate: no provider exposes token cost before generating the response
- PII redaction, prompt-injection detection, and risky-command detection are all pattern-based, not ML classifiers — none is a compliance guarantee on its own, and all can be evaded by a sufficiently motivated obfuscation
- Shadow A/B testing covers non-streaming proxy requests only
- Shadow-test similarity is local word-overlap cosine similarity (lexical), not true semantic/human quality judgment
- Token-efficiency-ratio is a proxy ("output tokens on tasks that reached success" ÷ "all tokens consumed"), not a measure of whether the successful output was actually good — see `server/agentAttribution.js` for the full reasoning
- Smart tagging infers from an API key's own tagging history (including history created by human corrections), plus a same-key time-of-day fallback — calling-service identity and prompt-template-fingerprint signals from the original plan aren't implemented yet, since both need request metadata this service doesn't collect today
- GPU shared-cluster cost allocation is a relative-API-spend approximation, not a measured per-team utilization split — there's no GPU-hours telemetry to split by instead
- Tool-call governance is audit/reporting only — it can flag a risky or non-compliant action but cannot prevent it, since the action happens outside this service's control
- Data residency (both the proxy check and tool-call flagging) relies on self-reported region headers, not real IP geolocation — a real control for well-behaved clients, not resistant to a malicious one
- "Ask your dashboard" is rule-based pattern matching over a handful of known query shapes, not a general natural-language-to-SQL engine — an unrecognized phrasing says so plainly rather than guessing
- SQLite backups are file copies, not point-in-time/incremental; Postgres deployments are responsible for their own backup strategy
- Dashboard session login is not yet supported in multi-tenant mode (see "Deployment modes") — API-key auth only
- No agent-level GPU utilization ingestion beyond cluster-level totals (no per-agent GPU-hours breakdown)
- Multi-tenant mode is not complete: seven route groups are switched off (`501`), periodic alert / commitment / briefing jobs do not run per tenant, and the process-global in-memory rate-limit and quarantine state is keyed by API key id rather than by tenant (key ids are unique, so this cannot cross tenants, but it is not partitioned either). One deployment per customer avoids all of this
- `X-Disable-PII-Redaction: true` can be sent by any caller with proxy access; it is not yet an admin-controlled privilege like `allow_background`
- Historical usage recorded at $0 before a model had a price is not retroactively re-priced (`GET /api/pricing/unpriced` finds unpriced models, not stale $0 rows)
- Schema migrations cover the single-tenant SQLite and Postgres schemas; the multi-tenant control-plane and per-tenant schemas are not migrated yet
- Postgres has no built-in backup and no point-in-time recovery: use `pg_dump` / provider snapshots (and take one before deploying a migration)

## License

MIT
