# API reference

The route table, versioning and OpenAPI notes. A machine-readable description of the proxy, ingest, keys, auth and invites groups is served at `GET /api/v1/openapi.json`.

*Part of the FinOps Guard docs. Section names in quotes (for example "Bootstrap mode" or "Deployment modes") refer to sections of the [README](../README.md).*

**Versioning.** Every route group below is served at both `/api/<name>` (the original path, kept working) and **`/api/v1/<name>`** (the stable, versioned path) — the *same* router instance, so the two cannot differ. Not versioned, on purpose: `POST /api/billing/webhook` (Stripe is configured with that exact URL and it needs the raw body), `/api/platform/*` (operator surface) and `/api/health`. The multi-tenant guard for route groups that are not tenant-aware (`server/tenantGuard.js`) is registered at **both** prefixes and matches on the canonical path — a plain `/api/v1` alias mounted beside the old guard would have silently bypassed it; `server/apiMounts.js` exists so mounting and guarding cannot drift, and `test/apiVersioning.test.js` fails if a mount in `index.js` skips it. The client SDK still calls `/api/proxy/...`, which keeps working. There is no deprecation policy or `v2` yet.

**OpenAPI.** `GET /api/v1/openapi.json` (unauthenticated — it describes the public surface and holds no tenant data) serves a hand-written OpenAPI 3.0 description of **proxy, ingest, keys, auth and invites only**; the other groups work under `/api/v1` but are not described yet. Because it is hand-written, `test/openapi.test.js` introspects the real Express routers and fails if a documented path/method does not exist **or** if a route those five routers serve is not documented. Request/response *schemas* are reviewed by hand, not machine-checked against handlers.

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
| GET/POST | `/api/tool-calls` | Agent tool-call audit log / ingestion (post-hoc, reporting only) |
| POST | `/api/tool-calls/check` | Pre-flight check before an agent acts: denylist / human-approval / allowed |
| GET | `/api/tool-calls/approvals` | Pending human-approval queue |
| POST | `/api/tool-calls/approvals/:id/approve` \| `/deny` | Decide a pending approval (admin only) |
| GET/POST/DELETE | `/api/tool-call-denylist` \| `/:id` | Tool-call deny-list management (`tool_name`/`target_pattern`, key-then-team scoping) |
| POST | `/api/gpu-usage/ingest` | Record GPU/self-hosted inference cost |
| GET | `/api/gpu-usage/blended` | Combined API + GPU cost per team |
| GET | `/api/query?q=` | Plain-English dashboard query |
| GET | `/api/pricing/catalogue` | View baseline pricing |
| POST | `/api/pricing/override` | Correct/add a pricing rate |
| GET/POST | `/api/keys` | List / create API keys |
| POST | `/api/keys/:id/quarantine` \| `/approve` \| `/revoke` | Key governance actions |
| POST | `/api/keys/:keyId/dismiss-rotation` | Clear a fraud-detection rotation-recommended advisory |
| GET | `/api/alerts` | Alert log |
| GET | `/api/alerts/status` | Consolidated alert status for monitoring |
| POST | `/api/alerts/check-now` | Manually trigger budget/burn-rate checks |
| GET/POST | `/api/model-allowlist` | List / add allow-list entries |
| DELETE | `/api/model-allowlist/:id` | Remove an entry (admin only) |
| GET/POST | `/api/token-quotas` | List / add quotas |
| DELETE | `/api/token-quotas/:id` | Remove a quota (budget-manager or admin) |
| GET | `/api/recommendations` | Optimization suggestions |
| GET | `/api/shadow-test/summary` \| `/comparisons` \| `/flagged-test-cases` | Shadow A/B test results / low-similarity flagged cases |
| POST | `/api/gitops/sync` | Sync budgets and declarative tagging rules from `finops.yaml` |
| POST | `/api/auth/register` \| `/login` \| `/logout` | Human user accounts (single-tenant and multi-tenant mode; multi-tenant login also requires `tenant_id`) |
| POST | `/api/auth/forgot-password` \| `/reset-password` \| `/resend-verification` \| `/verify-email` | Self-service password reset / email verification (same generic response regardless of whether the account exists; multi-tenant versions also require `tenant_id`; `forgot-password` takes `username` **or** `email`) |
| POST/GET/DELETE | `/api/invites` \| `/api/invites/:id` \| `/api/invites/accept` | Invite a teammate by email (admin: create, list pending, revoke); the invitee redeems the emailed single-use token at `/accept` (anonymous, rate-limited) and chooses a username/password. `accept` returns `tenant_id` in multi-tenant mode |
| POST | `/api/tenants` | Multi-tenant signup: creates a tenant + first API key, optionally a first dashboard login and/or a trial period |
| GET/POST/PATCH | `/api/platform/tenants/*` | Tenant lifecycle: list, suspend/reactivate, offboard/cancel, export, purge, adjust quotas (gated by `FINOPS_PLATFORM_ADMIN_TOKEN`) |
| GET | `/api/platform/overview` | Read-only cross-tenant health/usage overview (aggregates only; `?status=`, `?limit=`; gated by `FINOPS_PLATFORM_ADMIN_TOKEN`) |
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
| GET | `/health` | Unauthenticated liveness probe (Docker `HEALTHCHECK`, load balancers) — process-is-up only, no dependency checks |
| GET | `/health/ready` | Unauthenticated readiness probe — actually queries the database (control-plane pool in multi-tenant mode), `503` with a reason if unreachable, and `503` while the server is shutting down; reports Postgres connection-pool stats where applicable |
