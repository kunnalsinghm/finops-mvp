# Writing a migration

1. Copy the highest-numbered file, bump the number, give it a snake_case name.
2. Implement **both** `up.sqlite(db)` and `up.postgres(db)`. SQLite's is
   synchronous, Postgres's is `async`. `db` offers `exec`, `all`, `get`, `run`,
   `tableExists`, `columnExists`. Use `?` placeholders; they're translated.
3. Append it to `index.js`.
4. Add a test in `test/migrator.test.js` (or extend the upgrade tests).

Rules that keep customer data safe:

- **Never edit a migration once it has been released.** Its source is
  checksummed; a changed one makes startup refuse. Fix forward with a new one.
- **Never edit `schema.sqlite.js` / `schema.postgres.js`.** They are the frozen
  version-1 baseline. All later changes live here.
- **Prefer additive changes** (new nullable/defaulted columns, new tables,
  new indexes). They keep the previous release working against the new schema,
  which is what makes rolling back the application safe.
- **Make it idempotent** if there's any chance the change already exists
  (check `columnExists` / `IF NOT EXISTS`).
- Each migration runs in one transaction with its bookkeeping row; a failure
  rolls back completely and startup stops with the reason.
- SQLite: a verified snapshot is written to `data/backups/pre-migration-*.db`
  before any pending migration touches a database that has data.
- Postgres: **take a `pg_dump` or snapshot before you deploy** - there is no
  automatic one.

## Migrations that cannot run in a transaction (`transaction: false`)

Each Postgres migration normally runs in one transaction with its bookkeeping row,
so it is all-or-nothing. A few statements are refused inside a transaction, the
main one being `CREATE INDEX CONCURRENTLY`, which is how you add an index to a big
table without blocking writes. A migration may declare `transaction: false`
(Postgres only; SQLite always uses its single transaction and ignores the flag).

The trade-off is that it is **not atomic**. Rules for writing one:

- It must be safe to re-run from the start. It is recorded only after it
  succeeds, so a crash or failure anywhere runs it again on the next start, on top
  of whatever the first attempt left behind.
- A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index with the same name,
  and `IF NOT EXISTS` then skips it forever. Drop an invalid one first (see
  `0014_usage_event_id.js`).
- Keep it to one logical change. The error says it may have left partial work.
- The per-schema advisory lock is still held, so no other instance runs it at the
  same time. Waiters poll `pg_try_advisory_lock`; they must never block inside a
  statement, because `CREATE INDEX CONCURRENTLY` waits for every open statement to
  finish and would deadlock with a waiter. The same lock covers the baseline
  script, which runs only for a schema with no `schema_migrations` table yet.

## Multi-tenant schemas

The multi-tenant control-plane schema and every per-tenant schema are versioned
by the same migrator, with their own lists: `migrations/controlPlane/index.js`
and `migrations/tenant/index.js`. They are Postgres-only, so a migration there
only defines `up.postgres`.

- `schema.controlPlane.js` and `schema.tenant.js` are now the **frozen version-1
  baseline** of those schemas. Do not edit them; add a numbered file instead.
- A schema is migrated when its pool is first opened (`server/tenancy.js`), under
  the same per-schema advisory lock, checksum and ordering rules as above. A
  tenant created before versioning is adopted: the baseline is recorded and only
  newer migrations run.
- A failed migration rolls back, is reported with the tenant's schema name, and
  is not cached forever: after `FINOPS_TENANT_INIT_RETRY_MS` (default 15 s) the next
  request for that tenant retries, and requests in between get the same error
  without touching the database. `0` retries on every request.
- If a change touches a table that exists in both single-tenant and tenant
  schemas, it needs a migration in **both** lists. `test/tenantMigrations.test.js`
  (PARITY) fails if the two schemas diverge.
- `npm run migrate-tenants` migrates the control plane and then every tenant, one
  at a time, instead of waiting for each tenant's first request. A failure on one
  tenant is printed (with the tenant id, schema and reason), recorded on its
  control-plane row, and does not stop the others; the exit code is 1. Fix the
  cause and run the same command again: tenants already current are skipped, so
  it only does what is still behind. `-- --dry-run` lists what is pending and
  changes nothing, `-- --tenant <id>` limits it to one tenant, `-- --json` is
  machine-readable. Deleted tenants are skipped, and a tenant whose schema is
  missing is reported as failed, never recreated empty. It is safe while the
  server is serving traffic (each schema takes its own lock).
- Suggested release order for a migration that touches tenants: take a `pg_dump`,
  deploy the new build, run `npm run migrate-tenants -- --dry-run`, then
  `npm run migrate-tenants`. Migrations must be additive and backward compatible
  so the old build keeps working against a migrated tenant for the length of the
  rollout; see the next point for what happens if it cannot.
- An older build refuses to open a schema that is already at a newer version
  (`FINOPS_ALLOW_NEWER_SCHEMA=true` overrides). During a rolling deploy, an old
  instance that first opens an already-migrated tenant will return errors for
  that tenant until it is replaced.
