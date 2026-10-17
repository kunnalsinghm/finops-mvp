# Features (detailed reference)

Every feature of the platform, in depth, with the judgment calls and limits behind each one. The [README](../README.md) has the short version.

*Part of the FinOps Guard docs. Section names in quotes (for example "Bootstrap mode" or "Deployment modes") refer to sections of the [README](../README.md).*

## Cost tracking & attribution
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

## Content safety & data protection
- **PII redaction** (on by default, opt out per-request via `X-Disable-PII-Redaction: true` — only for a key an admin has granted `allow_pii_bypass`, the same admin-controlled-privilege shape as `allow_background`; a key without it that sends the header is refused with 403, not silently redacted anyway): regex-based detection of email, SSN, credit card (Luhn-validated), phone, and IP address patterns. Redact-and-continue, not block, for a permitted key. Applied at both the proxy and ingest
- **Prompt-injection detection** (always on, not opt-out): rule-based pattern matching against known jailbreak/injection phrasings. Blocks the request (HTTP 400). Applied at both the proxy and ingest
- **Data-residency enforcement**: block a request whose declared region (`X-Client-Region`) isn't on the applicable allow-list (`/api/region-allowlist`, key-then-team precedence, same pattern as model allow-listing below). Region is self-reported, not real IP geolocation — a real, useful control for well-behaved clients, not a substitute for network-level geofencing. The same self-reported region is also available as its own cost-breakdown dimension (`GET /api/costs/by-region`), independent of whether an allow-list is even configured
- **Agent action governance** (`/api/tool-calls`): audit trail for agent tool calls (file access, API calls, command execution) — distinct from LLM completions. Rule-based risky-command detection (destructive filesystem/database operations, privilege escalation), per-agent volume-spike detection, and the same data-residency check as above. The logged-call path (`POST /api/tool-calls`) is a **reporting/audit mechanism, not a live blocking gate** — a tool call happens outside this service's control, so it can only be flagged for review after the fact, not stopped. For actual prevention, an orchestrator can opt in to a **pre-flight check** (`POST /api/tool-calls/check`) *before* letting an agent act: a `tool_name`/`target` deny-list (`/api/tool-call-denylist`, key-then-team precedence, same scoping pattern as model allow-listing) denies outright, and a match against the same risky-command criteria queues the action for **human approval** (`GET /api/tool-calls/approvals`, `POST .../approve` | `/deny`) instead of denying it outright. This is opt-in by construction — nothing forces an orchestrator to call it — but it's the only way to add real prevention given the architectural constraint above

## Governance (enforced live in the proxy)
- Token-bucket rate limiting per API key
- **Budget enforcement, two tiers**: over budget with a cheaper same-provider fallback configured → degrades to it (circuit breaker). Over budget with **no fallback available** → hard-blocks with `402`, rather than silently letting the request through unthrottled at full price
- **Background/continuous-inference budget class**: traffic tagged `X-Workload-Type: background` (24/7 monitoring/compliance-scanning agents) is exempt from the circuit-breaker/hard-block above — throttling it could break the function it exists to perform — but is still tracked and alertable via its own `scope_type: 'background'` budget, separate from that team's regular spend
- Quarantine mode: flagged keys capped to 1 req/min pending admin approval
- **Anomaly detection**: one system (`server/anomaly.js`), five trigger types, all logged to `/api/alerts` under `type: "anomaly"`, all advisory/flag-only, never auto-blocking:
  - single-event cost spike (any one event costing more than 5x the 30-day rolling average for that provider/model)
  - daily-spend-exceeds-normal (a team's total spend today vs. its own 14-day rolling daily average, >200% of normal)
  - retry-rate-exceeds-threshold (an agent whose fraction of multi-attempt tasks crosses 50%, min 5 tasks)
  - new-model-appears / new-geography-begins - both **org-wide**: a provider/model or client-declared region never seen anywhere in this deployment before (deliberately not per-key - see below)
- **Fraud/compromised-key detection**: a SEPARATE, deliberately-not-merged system, scoped to one key rather than the whole org - flags a sudden request-volume spike, a brand-new provider/model combo, or a first-time client region, all relative to THAT KEY's own history (not everyone's). Logged to the same `/api/alerts` as anomaly detection, but answering a different question ("does this one credential's behavior look compromised" vs. "is anything about this event/team/deployment unusual") - the two can legitimately both fire on the same event for different reasons. **No longer flag-only**: a single signal alone sets a softer `rotation_recommended` advisory on the key (visible on `GET /api/keys`, cleared via `POST /api/keys/:keyId/dismiss-rotation`); two or more concurrent signals on the same request **auto-quarantine** the key, logged to the audit trail under actor `system:fraud-detection` so it's distinguishable from a manual admin quarantine, and never double-quarantines an already-quarantined key. The signal count required is configurable (`FINOPS_FRAUD_AUTO_QUARANTINE_MIN_SIGNALS`, default `2`)
- **Model allow-listing**: restrict specific keys/teams to a pre-approved list of models. Manage via `/api/model-allowlist`
- **Token quotas**: cap raw input+output token consumption per key/team over a daily and/or weekly window. Manage via `/api/token-quotas`

## Caching — two independent, opt-in tiers
- **Exact-match** (`X-Enable-Cache: true`): identical provider+model+message requests return a cached response, with tracked cost savings
- **Semantic/near-duplicate** (`X-Enable-Semantic-Cache: true`): catches reworded prompts that mean the same thing. Local zero-dependency word-overlap mode by default, or real OpenAI embeddings if `FINOPS_EMBEDDING_API_KEY` is set

## Budgeting & alerts
- Multi-tier budgets (team/project/key/background), progressive alerts (50/80/90/100%), burn-rate alerts
- `GET /api/alerts/status` — a consolidated status endpoint for external monitoring (unacknowledged count, broken down by type, most recent alert) to poll, rather than requiring a monitoring tool to interpret the raw log itself
- Delivery via Slack Incoming Webhook, a generic webhook (Discord/Teams/ntfy.sh/PagerDuty-compatible), and/or SMTP email; always logged locally regardless of delivery config
- **Signed generic webhooks (opt-in).** Set `FINOPS_WEBHOOK_SECRET` and every generic-webhook POST carries `X-FinOps-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 over `<t>.<raw body>` keyed by the secret. The timestamp is inside the signed string, so reject requests whose `t` is more than a few minutes old to stop replays. **If `FINOPS_WEBHOOK_SECRET` is unset, webhooks are sent unsigned, exactly as before** — a deliberate backward-compatibility choice so existing `FINOPS_WEBHOOK_URL` setups don't break on upgrade; a receiver that needs authenticity should set the secret *and* reject requests without the header. Slack and email delivery are unaffected. Receiver-side verification (Node, no dependencies):

  ```js
  const crypto = require("crypto");
  // `rawBody` must be the body bytes exactly as received (e.g. express.raw()), NOT re-serialised JSON.
  function verify(rawBody, header, secret, toleranceSeconds = 300) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header || "");
    if (!m) return false;
    if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSeconds) return false; // replay guard
    const expected = crypto.createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest();
    return crypto.timingSafeEqual(Buffer.from(m[2], "hex"), expected);
  }
  ```

## Optimization engine
- Rule-based model-switch recommendations, each starting with an explicit caveat: cost-only estimate, quality unverified
- **Shadow A/B testing** (opt-in via `X-Enable-Shadow-Test: true`): a sample of real traffic is also sent to the recommended cheaper model, purely to compare — supports both streaming and non-streaming requests (a streamed primary gets a streamed shadow call too, for a fair comparison). Similarity is scored two ways: an always-on local word-overlap lexical score, plus an optional **LLM-as-judge** semantic score (gated behind `FINOPS_SHADOW_JUDGE_MODEL`, unset by default) stored additively alongside it, never as a replacement. Once a model pair has enough samples, `/api/recommendations` reports a real measured confidence: `shadow-tested-similar` or `shadow-tested-diverges`. A comparison scoring below `FINOPS_SHADOW_FLAG_SIMILARITY_THRESHOLD` (default `0.5`) is also captured to `GET /api/shadow-test/flagged-test-cases` — cheap groundwork for a future eval-suite pipeline, not the pipeline itself
- Caching-opportunity heuristic for repeated/templated prompt patterns

## Shadow-spend reconciliation
- Upload a provider billing CSV (`date,provider,cost`) to compare reported vs. tracked spend per day/provider
- Re-uploading a period replaces prior numbers rather than double-counting
- **Categorized gap breakdown** (A12): every flagged gap (`gap_usd`/`gap_pct`/`flagged` are unchanged, kept for backward compatibility) also gets a best-guess `category`, using signals this module can already see rather than new instrumentation: `pricing-mismatch` (tracked usage in that window was recorded unpriced or at an approximate catalogue rate — see `GET /api/pricing/unpriced`), `timing-difference` (the adjacent day shows an offsetting gap in the other direction — a billing-period boundary not lining up with our UTC day, not a real discrepancy), `tracking-gap` (nothing at all was tracked that day/provider — an outage window or spool-replay failure), or `unexplained` (none of the above — the honest bucket, not a forced guess). **Not attempted**: "provider invoice adjustments" (credits, retroactive corrections) — there's no data source for that in this codebase (the CSV import has no concept of a credit line distinct from an ordinary charge), so this stays an explicit gap rather than a faked heuristic

## Billing (the platform's own subscription — separate from the AI spend it tracks)
- Stripe Checkout for the two flat-fee tiers (`$999/mo` up to 5 members, `$2,500/mo` unlimited) via `POST /api/billing/checkout-session`
- A dedicated raw-body webhook route (`POST /api/billing/webhook`, mounted before the app's global JSON parser — Stripe signature verification needs the untouched raw body)
- Cleanly returns `501`, not a crash, when `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` aren't set — see `docs/stripe-live-checkout-runbook.md` for the manual end-to-end verification steps a real Stripe test-mode account requires (this can't be fully automated in CI)

## Access control
- API keys (roles: admin, budget-manager, developer, viewer, auditor, agent) for services/the proxy. **Auditor** is read-only but scoped narrowly to audit/compliance evidence (audit log, alerts log, reconciliation report, billing status, tool-call approval history) rather than general dashboard access — a distinct `audit_read` permission, not an alias for `viewer`'s `read`. **Agent** is machine-scoped: holds only `write` (the ingest/proxy/tool-call-logging path), nothing else — no dashboard reads, no key/budget management — and is API-key-only, deliberately excluded from dashboard-account creation (`POST /api/auth/register` rejects it)
- Session-based human login for the dashboard, `scrypt`-hashed passwords, in **both** single-tenant and multi-tenant mode (multi-tenant login additionally takes a `tenant_id`, since usernames are only unique within a tenant — see "Deployment modes")
- **Self-service password reset + email verification** (`POST /api/auth/forgot-password`, `/reset-password`, `/resend-verification`, `/verify-email`, plus `reset-password.html`/`verify-email.html` for the dashboard) — an optional `email` on a dashboard account (`POST /api/auth/register`) enables it; accounts with no email on file simply can't use it (still fall back to an admin-triggered reset, `POST /api/auth/users/:username/reset-password`). Reset/verification tokens are single-use, expire (1 hour / 24 hours), stored only as a hash, and every "does this account/email exist" response is deliberately identical regardless of the answer, in both single- and multi-tenant mode. IP-rate-limited separately from login (5 requests/15 min for forgot-password/resend-verification, since a wrong guess there costs an attacker nothing the way a wrong login password does). Reuses the same SMTP transport as alerting (`FINOPS_SMTP_*` below) but does **not** require `FINOPS_ALERT_EMAIL_TO` to be set — sends to the user's own address instead of a fixed ops recipient. With no SMTP configured at all, every endpoint above still responds normally (generic message, no error) — it just has no email to actually send. **Reset by email:** `POST /api/auth/forgot-password` accepts either `{username}` or `{email}` (exactly one — both or neither is a `400` that depends only on the request's shape, never on whether an account exists; multi-tenant mode additionally requires `tenant_id`, and the email lookup is *always* scoped to that tenant, so the same address in another tenant is unreachable). Because `users.email` has no `UNIQUE` constraint, one address can sit on several accounts: a request mails one reset link per matching account (each naming its account), capped at 5 per request. **Email lookup only matches *verified* addresses** (the username path mails whatever is on file) — an unverified address may be a typo belonging to a stranger, who could otherwise request a live reset link for someone else's account; consequence: accounts that never verified their email must use the username path or an admin reset. Matching is case/whitespace-insensitive (SQLite's `LOWER()` only folds ASCII). The reset email is sent *after* the response (never awaited on the anonymous endpoints), because awaiting SMTP only on the match path made a real account answer in ~600 ms vs ~2 ms for an unknown one — an account-enumeration timing oracle; residual: the match path still does a token write + audit write before responding, so response time is not strictly constant. The dashboard page (`reset-password.html`) still submits username only; email is API-level for now
- **Invite a teammate** (`POST /api/invites`, `GET /api/invites`, `DELETE /api/invites/:id`, `POST /api/invites/accept`, plus `accept-invite.html`) — an admin invites an email address with a role; the recipient follows the emailed link and chooses their own username and password (single- and multi-tenant mode; multi-tenant invites live in the control plane and every query is scoped by `tenant_id`, with the tenant for an accepted invite taken from the invite itself, never from the request). Tokens are 32 random bytes, stored only as a hash, expire after 7 days, and redeem **exactly once** (one atomic conditional `UPDATE`, so concurrent accepts of one link create one account). An inviter can only grant a role whose permissions they hold themselves (today only `admin` holds `manage_keys`, so in practice admins invite any dashboard role; `agent` is never invitable). Re-inviting an address supersedes its older pending link; at most 50 invites can be pending per deployment/tenant. The raw token is only ever in the email — never in an API response or the database. Accepting never says *why* a link failed (unknown, expired, used, revoked, or a suspended tenant all return the same `400`); the only account-specific answer is `409 that username is already taken`, which gives the invitee their link back. The accepted account is created with `email_verified = 1` (the link proved control of the address). **Unlike the anonymous endpoints, the invite email is awaited**: creation is authenticated so response time leaks nothing, and the response carries `email_sent` so the admin knows whether it went out (with no SMTP configured it is `false` — use `POST /api/auth/register` instead). Redeeming is IP-rate-limited with the same limiter as reset-token redemption. Single-tenant tables come from migration 13; multi-tenant from the control-plane schema
- Spec-compliant OIDC (SSO) client — needs your own identity provider app registration to fully activate

## Audit & data governance
- Immutable audit trail for all administrative actions (budget changes, key lifecycle, pricing overrides, tag corrections, region allow-list changes)
- Data export (JSON/CSV) and explicit-cutoff retention purging via `/api/data`
- **FOCUS-spec export** (`/api/data/export/focus`) — includes both API and GPU spend in one unified schema. A GPU row from a shared cluster carries its split-allocation method in `Tags`, so a reader can tell an allocated number apart from a directly-measured one

## Reliability & operations
- **Security:** Helmet security headers, IP-based login rate limiting (10 attempts / 15 min)
- **Logging:** structured JSON logs written to `logs/`, daily rotation
- **Backups:** automatic SQLite backup on boot and every 6 hours, retention-pruned; manual trigger via `npm run backup`
- **Crash recovery:** `npm run serve` runs a self-written supervisor that respawns the server on crash with exponential backoff
- **Load testing:** `npm run loadtest` — a dependency-free concurrent load test against the proxy (point it at `scripts/mock-provider.js` for zero real API cost), reporting throughput and latency percentiles. This is the closest thing to an automated answer for "is the proxy actually fast enough" — genuine load behavior still needs a human to run this and read the output, not something a unit test can assert

## FinOps as Code
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

## Client SDK
- `sdk/finops-client.js` — a zero-dependency wrapper for calling the proxy without hand-managing headers, supporting both standard and streaming requests

## CI/CD
- GitHub Actions (`.github/workflows/ci.yml`): runs the full test suite against both SQLite and Postgres backends, plus a Docker build check, on every push/PR to `main`
