# Changelog

All notable changes to this project, newest first.

**How to read this file**

- The project has **no release tags**, and `package.json` still says `0.2.0` (it has not been bumped).
  Sections are therefore grouped by the pull request or work series they landed in, with commit dates,
  not by version number. Pick a version scheme before the first tagged release; until then, the commit
  hash is the identifier.
- Entries before PR #2 are summarised from the commit messages (many are a one-line subject) and
  deliberately add no detail beyond them; use `git show <hash>` for specifics. Entries for PR #2 and
  PR #3 were written from the code and tests and include behaviour notes.
- "Upgrade notes" call out anything that changes behaviour or needs an operator action.

## [Unreleased]

### Changed
- **One per-schema lock for the baseline and the migrations, polled instead of blocked on.** Creating a
  schema and its tables used to run under a separate blocking advisory lock, and the whole baseline script was
  re-run by every process that booted or first opened a tenant. Now `runPostgres` takes `schema` and
  `baseline` options: it takes one lock keyed by the schema name, waits for it by polling
  `pg_try_advisory_lock` (a waiter is never inside a statement), and runs the baseline script only for a
  schema that has no `schema_migrations` table yet (a new one, or one from before versioning, which is thereby
  adopted). An already versioned schema no longer has its baseline re-run on boot. Preparation for migrations
  that build indexes `CONCURRENTLY`, which wait for every other open statement and would otherwise deadlock
  with a process queued behind the lock or re-running `ALTER TABLE ... IF NOT EXISTS` (reproduced with a test
  migration: 8 processes started together, most failed with `deadlock detected`). The lock key is spelled the
  same as before for an existing schema, so builds of both kinds still exclude each other. Removed:
  `createBaselineSchema()` (single-tenant) and `createSchemaLocked()` (tenancy). Rollback: revert.
- **Multi-tenant schemas are versioned** (H1a). The control-plane schema and every tenant schema now go
  through the same migrator as single-tenant mode: numbered, checksummed, ordered and advisory-locked per
  schema, applied when the schema is first opened. `schema.tenant.js` and `schema.controlPlane.js` are now the
  frozen version-1 baseline; changes go in `server/storage/migrations/tenant` and `controlPlane` (both empty
  today). A tenant created earlier is adopted: its baseline row is recorded and its data is untouched. The
  migrator takes a `dialects` option so these Postgres-only lists need only `up.postgres`; single-tenant
  checksums are unchanged. A new PARITY test compares a fresh tenant schema with a fresh single-tenant schema
  (columns, types, defaults, indexes) and found no drift at this commit. Upgrade note: an older build refuses to
  open a schema recorded at a newer version, so during a rolling deploy an old instance that first opens an
  already-migrated tenant returns errors for that tenant. Rollback: revert; the only database change is a
  `schema_migrations` table per schema, which older builds ignore.

### Fixed
- **The init-retry window now starts after a failure has been recorded, not when it happened.** Recording a
  failed tenant init on the control plane can take a while the first time (a cold control plane initializes
  and migrates); with the window measured from the failure, that time could use it up and the very next
  request re-ran the migration. The failure is remembered immediately (so nothing starts a second attempt
  meanwhile) and the clock starts when it has been fully handled.
- **A failed tenant (or control-plane) schema init is no longer cached.** The rejected promise stayed in the
  pool map, so one failure left that tenant answering 500 until the process restarted. The entry is now dropped
  and its connections released, so a later request retries. The retry is rate-limited: a failure is
  remembered for `FINOPS_TENANT_INIT_RETRY_MS` (default 15000; `0` = every request), and requests inside the
  window get the same error without touching the database. Without that, H1a's first version re-ran a failing
  migration (lock, BEGIN, DDL, ROLLBACK, a new connection pool) once per request: in a reproduction 6 requests
  ran it 6 times, and 5 control-plane calls ran it 5 times; now once each. Applies per tenant, so one broken
  tenant never delays another. Each attempt logs one error line; requests in the window do not.

### Added
- **Migrations may declare `transaction: false`** (Postgres only; SQLite ignores it). For statements Postgres
  refuses inside a transaction, chiefly `CREATE INDEX CONCURRENTLY`, which adds an index to a large table
  without blocking writes. Such a migration is not atomic: it is recorded only after it succeeds and must be
  written to be re-run (the rules are in `server/storage/migrations/README.md`). No existing migration uses it.
- **`npm run migrate-tenants`** (H1b). Migrates the control plane and then every tenant up front, one tenant
  at a time (connections stay at one tenant's pool plus the control plane), instead of waiting for each
  tenant's first request after a deploy. A failure on a tenant is printed with its id, schema and reason,
  recorded, and does not stop the others; exit code 1 if any failed (2 for usage errors). Re-running only does
  what is still behind. `--dry-run` shows what is pending and applies and records nothing, `--tenant <id>`,
  `--json`. Deleted tenants are skipped; a tenant whose schema is missing is reported as failed and is never
  recreated empty. Control-plane migration 2 adds `tenants.schema_version`, `schema_migration_error` and
  `schema_migration_error_at` (additive, nullable); the lazy first-open path keeps them current too, as a
  best-effort write that can never fail or delay a request. Rollback: revert; the columns are unused by older
  builds. Not verified at hundreds of tenants.
- **`FINOPS_TRUST_PROXY`** (RFC 0001, phase A2). Opt-in setting passed to Express `trust proxy`: a hop count
  (1-32) or a comma-separated list of proxy IPs/CIDRs. Behind a load balancer every client used to share the
  balancer's address, so the login (10 per 15 min) and forgot-password (5 per 15 min) limits, the only users of
  `req.ip`, were effectively global. Unset behaves exactly as before. `true`, ranges that match every address
  (`0.0.0.0/0`, `::/0`), `false`, zero, over 32 hops and anything malformed make the server refuse to start with a
  message naming the setting. Upgrade note: if you turn it on, set it to the real number of proxies; too high a
  count or too wide a range lets clients fake their address with `X-Forwarded-For`. Rollback: unset it.

### Fixed
- **Graceful shutdown** (RFC 0001, phase A1). A `SIGTERM` (scale-down, rolling deploy) used to kill the
  process mid-request. The proxy calls the provider first and meters after, so a kill in between lost
  billed spend without reaching the spool: in a reproduction the client got `ECONNRESET` and 0 usage rows
  were recorded (1 in the no-signal control). The server now drains: it stops listening, lets in-flight
  requests finish and be metered, closes the database and exits `0`; `/health/ready` returns `503` while
  draining and periodic jobs stop starting. `FINOPS_SHUTDOWN_GRACE_MS` (default 25000) caps the wait; past
  it connections are cut and the exit code is `1`. Not covered: `SIGKILL`/power loss/OOM, and Windows.
- `README.md` contained an unresolved merge-conflict block (`<<<<<<< ours` … `>>>>>>> theirs`) since
  98d27e8. Both sides documented different environment variables, so the resolved line keeps all of them.
  `test/noConflictMarkers.test.js` now fails if any text file in the repo has such a block.

### Changed
- **README rewritten** as a short front door (what it is, a verified five-minute start, deployment modes,
  configuration table, operations, testing, documentation map, status). The detailed feature list, route
  table, multi-tenancy notes, guarantees, reliability notes and known gaps moved, with their text
  unchanged, to `docs/features.md`, `docs/api-reference.md`, `docs/multi-tenancy.md`,
  `docs/guarantees.md`, `docs/reliability.md` and `docs/known-gaps.md`. The old quick start ran
  `register` first, which only works before any API key exists; the new one creates the key first.
  Test counts were refreshed (the old text said 563). Comments in code that pointed at README sections now
  point at the new pages.

### Added
- `FINOPS_BACKUP_DIR` to relocate SQLite backups (default unchanged: `data/backups`).
- `stop_grace_period: 30s` for the app service in `docker-compose.yml` (Docker's 10s default would kill a drain).
- This changelog.
- Written plans (RFC-style) for infrastructure-as-code and horizontal scaling, a real OpenTelemetry
  exporter, and the dashboard-framework question, under `docs/rfcs/`. No code changes accompany them.

## 2026-10-15 → 2026-10-16 — PR #3 (`p2-series`)

### Added
- **Invite a teammate** (de061c0): `POST/GET/DELETE /api/invites` and `POST /api/invites/accept`, plus
  `public/accept-invite.html`, in single- and multi-tenant mode. An admin invites an email address with a
  role; the recipient follows an emailed link and chooses their own username and password.
  - Tokens are 32 random bytes and stored only as a SHA-256 hash; they expire after 7 days and redeem
    exactly once (one atomic conditional `UPDATE`, so concurrent accepts create one account).
  - An inviter can only grant a role whose permissions they hold; `agent` is never invitable.
  - Accepting never says why a link failed (unknown, expired, used, revoked, or suspended tenant all
    return the same `400`); `409` for a taken username returns the link to the invitee.
  - At most 50 pending invites per deployment/tenant; re-inviting an address supersedes its older link.
  - The accepted account is created with `email_verified = 1`. The invite email is awaited (the endpoint
    is authenticated) and the response reports `email_sent`.
- **Cross-tenant health/usage overview** (4f96eae): `GET /api/platform/overview`, read-only and
  aggregates only (status, limits, key/user counts, this month's events and spend, last activity, health
  flags). Gated by `FINOPS_PLATFORM_ADMIN_TOKEN` like the rest of `/api/platform/*`. It deliberately does
  not use `getTenantDb`, which would recreate a purged tenant's schema.
- **`/api/v1`** (8429641): every route group is served at both `/api/<name>` and `/api/v1/<name>` (the
  same router instance). The Stripe webhook, `/api/platform/*` and `/api/health` are not versioned.
- **OpenAPI**: `GET /api/v1/openapi.json` (unauthenticated) describes proxy, ingest, keys, auth and
  invites. It is hand-written; a test checks it against the real routers in both directions.
- Migration 13 (`invites`, single-tenant) and a matching `invites` table in the multi-tenant control plane.

### Fixed
- **Multi-tenant first-boot race** (68a684e): concurrent first boot of a multi-tenant deployment, or
  concurrent first requests for a new tenant, crashed all but one process with
  `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`. Control-plane and
  per-tenant schema creation now run under a session-level advisory lock. In one run on Postgres 16 with
  8 simultaneous processes against an empty schema, same-tenant creation failed 7 of 8 and control-plane
  init failed 2 of 8 (the race is timing-dependent, so counts vary).
- **Tenant guard bypass risk** (8429641): `server/tenantGuard.js` matched `req.baseUrl` against the exact
  `/api/<name>`, so a plain `/api/v1` alias would have skipped it for any route group marked not
  tenant-aware. It now matches the canonical path and is registered at both prefixes. The guard list is
  empty today, so this was a latent risk, not a live leak.

### Upgrade notes
- Single-tenant: migration 13 runs automatically on startup. SQLite writes a verified snapshot first;
  on **Postgres, take a `pg_dump` or snapshot before deploying** (there is no automatic one).
- Multi-tenant: the new control-plane `invites` table is created with `CREATE TABLE IF NOT EXISTS` on
  first boot, because the control plane is not covered by the versioned migrator.
- Invite links use `FINOPS_APP_URL` (as the reset/verify links do); with SMTP unconfigured, invites are
  created but not sent (`email_sent: false`).

## 2026-10-06 → 2026-10-15 — PR #2 (`p1-series`)

### Security
- **Generic webhooks are signed** (4b71489): when `FINOPS_WEBHOOK_SECRET` is set, outgoing webhooks carry
  `X-FinOps-Signature: t=<unix seconds>,v1=<HMAC-SHA256(secret, "<t>.<body>")>`. With the variable unset
  they are sent unsigned, as before. The README has a verification snippet.
- **Timing oracle closed** (431bfd4): forgot-password and resend-verification used to answer measurably
  slower for a real account, because the SMTP send was awaited only on that branch. The email is now sent
  after the response, in single- and multi-tenant mode.

### Added
- **Forgot-password by email** (e845c04): `POST /api/auth/forgot-password` accepts `{username}` or
  `{email}` (exactly one). Email lookup matches **verified** addresses only, is scoped to the tenant in
  multi-tenant mode, and sends at most 5 emails per request (one address can sit on several accounts).
  The generic response is unchanged.

### Fixed
- **Concurrent first boot on an empty Postgres database** (b5e4be8): baseline schema creation is now
  serialised with an advisory lock; previously all but one process crashed at startup.
- **Silent upstream failures in the proxy** (1dd75a7): every 502 path, and the previously silent
  mid-stream failure, now logs the provider, model and key before responding.

## 2026-09-28 → 2026-10-06 — P0 hardening

### Security
- Admin-gated the `X-Disable-PII-Redaction` bypass; fixed a bug in the fraud check; added self-service
  password reset and email verification (48edd6a).
- The legal drafts added in 48edd6a were removed again pending lawyer review (82d158e, a59d0cd).

### Performance
- Added a `usage_events` index and a load test (48edd6a); bounded the volume and daily-spend baselines
  with an index range (807ab1d); fixed non-sargable monthly-SUM queries in the budget check, event quota
  and alerts (8b89488, 6e5e62c). Measurements are in `docs/load-test-results.md`.

### Fixed
- Multi-tenant `users` schema ordering and a flaky weekly-briefing test (ef40e0e); anomaly-detection and
  storage-migration updates (90e3b7b).

## 2026-09-23 → 2026-09-27 — A-series

- **A10–A13** (98d27e8): Postgres backup and disaster recovery, a real readiness endpoint
  (`/health/ready`), reconciliation categorisation, the tech-stack migration plan
  (`docs/tech-stack-migration-plan.md`), and opt-in OTel-compatible request tracing
  (`FINOPS_OTEL_ENABLED`, JSON lines on stdout — not yet a real exporter).
- **A6–A9** (088b3f3): automated fraud response, tool-call governance, shadow-test streaming and judge,
  and additional RBAC roles.
- **A5** (71d0909): unified anomaly detection (daily spend, retry rate, new model, new geography).
- **A1** (6226900): multi-tenancy feature-complete — seven more route groups enabled, session login,
  per-tenant jobs, quotas and lifecycle.
- **A2–A4** (5354052): attribution dimensions, tagging rules, FOCUS export.

## 2026-09-18 → 2026-09-20 — governance hardening, migrations, Guard v2

- **Guard v2 scope** (4ca0635): agent-level attribution, smart tagging, blended GPU + API cost view,
  FOCUS 1.3 split allocation, agent action governance (tool-call tracking).
- **Governance hardening** (a9071da): identity is bound to the API key, not to request headers (team
  mismatch → `403`; background exemption is an admin-granted per-key privilege;
  `FINOPS_STRICT_IDENTITY`); real model IDs are priced (normalisation, family fallback,
  `FINOPS_UNPRICED_POLICY`, `GET /api/pricing/unpriced`); an upstream timeout
  (`FINOPS_UPSTREAM_TIMEOUT_MS`); and a durable metering spool so a recording failure no longer turns a
  billed success into a `502`.
- **`usage_events.key_id`** (2ef4102): every usage event records the authenticating API key.
- **Versioned schema migrations** (ae10248): numbered, checksummed, atomic migrations with a SQLite
  pre-migration snapshot; backups are consistent (`VACUUM INTO`), verified and restorable (also 97c8174,
  4f595ea).
- Earlier foundation work (07451b8, da8ff16, 03f12a2, 575db83, fe4e347): multi-tenant data layer,
  platform update, `package-lock.json`, ignoring the spool file, and removing a one-time patch script.
