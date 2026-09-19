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

The multi-tenant control-plane and per-tenant schemas
(`schema.controlPlane.js`, `schema.tenant.js`) are not migrated by this system
yet; that is part of making multi-tenant mode production-ready.
