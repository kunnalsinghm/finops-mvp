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
  is **not** cached: the next request for that tenant retries.
- If a change touches a table that exists in both single-tenant and tenant
  schemas, it needs a migration in **both** lists. `test/tenantMigrations.test.js`
  (PARITY) fails if the two schemas diverge.
- An older build refuses to open a schema that is already at a newer version
  (`FINOPS_ALLOW_NEWER_SCHEMA=true` overrides). During a rolling deploy, an old
  instance that first opens an already-migrated tenant will return errors for
  that tenant until it is replaced.
