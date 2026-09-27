# Backup, restore and schema-migration runbook

Everything here is exercised by automated tests (`test/backup.test.js`,
`test/backupPostgres.test.js`, `test/migrator.test.js`). A backup you have
never restored is a hope, not a backup - so the drill in section 3 is worth
doing once, on a copy, before you need it.

## 1. What is backed up, and when (SQLite)

- The server takes a backup at startup and every 6 hours, into `data/backups/`
  (`finops-<seq>-<timestamp>.db`), keeping the newest `FINOPS_BACKUP_RETENTION` (default 7).
  "Newest" means **last created** (the 6-digit sequence), not the latest timestamp, so a
  system clock that is corrected or goes backwards can never cause a fresh backup to be
  pruned or an older one to be restored by `--latest`. The server logs a warning when it
  notices the clock went backwards. Backups made by earlier versions have no sequence and
  are treated as older than any new one.
- Each backup is a **consistent snapshot** made with SQLite's `VACUUM INTO`, so it is
  correct even while the server is writing. (An earlier version copied the raw file,
  which in WAL mode could miss recent writes or contain no tables at all.)
- Each backup is **opened and integrity-checked immediately**. One that fails is deleted,
  logged as an error, and never causes older good backups to be pruned.
- Manual: `npm run backup`, or `POST /api/backup/run` (admin).
- **Copy `data/backups/` off the machine** (another disk, object storage). A backup on the
  same disk does not survive the disk.

## 1b. What is backed up, and when (Postgres)

- When `FINOPS_DB_DRIVER=postgres` **and single-tenant mode** (`FINOPS_MULTI_TENANT`
  unset/`false`), the server takes a backup at startup and every 6 hours, the same
  schedule as SQLite, into `data/backups-postgres/` (`finops-pg-<seq>-<timestamp>.dump`),
  keeping the newest `FINOPS_BACKUP_RETENTION` (default 7, same variable as SQLite).
- **Mechanism: `pg_dump` in custom format (`-Fc`)**, not continuous WAL archiving/PITR.
  This is a periodic logical snapshot, chosen because it needs no standing archival
  infrastructure and works against effectively any reachable Postgres (including most
  managed providers) - the same tradeoff SQLite's own "snapshot, not continuous" backup
  already makes, kept consistent across both backends rather than solving it twice at two
  different levels of ambition. True point-in-time recovery (restore to any second, not
  just the last snapshot) needs `archive_command`-based WAL archiving, which is a
  server-config-level commitment this application process can't safely set up on your
  behalf for a database it doesn't administer - still an open gap, noted below.
- Each backup is **verified by actually restoring it** into a real, throwaway Postgres
  database (created and dropped automatically) and checking the tables/row counts that
  come back - not just "pg_dump exited 0". A backup that fails this is deleted, logged as
  an error, and never causes older good backups to be pruned - exactly the same posture
  as the SQLite side.
- **Multi-tenant mode**: every tenant's schema and the control-plane schema live in the
  SAME physical Postgres database (see `server/tenancy.js`), so a whole-database
  `pg_dump` mechanically captures every tenant with no extra work. What this pass does
  **not** do is schedule that automatically, or offer a way to restore ONE tenant's
  schema without rolling back every other tenant to the same point in time - see section
  5. Run `npm run backup` manually (it works; there's just no per-tenant restore yet), or
  bring your own snapshot schedule, until that exists.
- Requires `pg_dump`/`pg_restore` on `PATH`, and the connecting role to have `CREATEDB`
  and access to the standard `postgres` maintenance database (both are only needed for
  the restore-based verification step - the dump itself needs neither).
- Manual: `npm run backup` (dispatches by `FINOPS_DB_DRIVER` automatically), or
  `POST /api/backup/run` (admin; same dispatch).
- **Copy `data/backups-postgres/` off the machine**, same as the SQLite folder.

## 2. Check that your backups are restorable (do this on a schedule)

```
npm run backup:verify                              # newest backup for the active FINOPS_DB_DRIVER
npm run backup:verify -- path\to\finops-....db            # SQLite, explicit file
npm run backup:verify -- path/to/finops-pg-....dump       # Postgres, explicit file
```

Exit code 0 = restorable. **SQLite**: opens the backup, checks integrity, then proves the
**current code** can migrate it to the current schema with no rows lost - on a throwaway
copy, never touching the backup or the live database. **Postgres**: restores the dump into
a real throwaway database and inspects that - same "prove it, don't assume it" bar, just
exercised through an actual `pg_restore` instead of a file-integrity check. Run it daily
(cron / Windows Task Scheduler) and alert on a non-zero exit.

## 3. Restore (SQLite)

1. **Stop the server.** (On Windows a running server locks the file; the restore will
   refuse and roll back rather than corrupt anything.)
2. Choose a backup (`dir data\backups`; the highest sequence number is the newest) and restore:
   ```
   npm run restore -- --latest --force
   npm run restore -- data\backups\finops-2026-09-19T10-00-00-000Z.db --force
   ```
   Without `--force` it refuses to overwrite an existing database. Add
   `--target <path>` to restore somewhere else (recommended for a rehearsal).
3. What it does: verifies the backup **before touching anything**; stages a copy beside
   the target and re-checks it; moves the current database (and its `-wal`/`-shm`) aside
   as `finops.db.replaced-<timestamp>` - **never deleted**; then swaps the restored file in.
   If anything fails it rolls back, and if the rollback itself can't finish it tells you
   exactly where your previous files are.
4. Start the server. If the backup is from an older release, pending schema migrations
   run automatically (with a fresh pre-migration snapshot). Confirm data and delete the
   `*.replaced-*` files once you're satisfied.

**Rehearsal (10 minutes):** `npm run restore -- --latest --target %TEMP%\finops-rehearsal.db`,
then start a second copy of the server with `FINOPS_DB_PATH` pointing at it.

## 3b. Restore (Postgres)

1. **Stop the server** (or point the restore at a database nothing else is writing to -
   restoring into a database still being written to is asking for a race, not a bug in
   this tooling).
2. Choose a backup (`dir data\backups-postgres`; the highest sequence number is the newest)
   and restore:
   ```
   npm run restore -- --latest --force
   npm run restore -- data/backups-postgres/finops-pg-2026-09-19T10-00-00-000Z.dump --force
   ```
   By default this restores into the database named in `FINOPS_POSTGRES_URL`. Add
   `--target <postgres-connection-string>` to restore somewhere else (recommended for a
   rehearsal, and the only way to restore into a *different* database than the live one).
   Without `--force` it refuses to overwrite a target that already has data in it.
3. What it does: verifies the backup **before touching anything** (by restoring it into a
   separate throwaway database first); if the target has existing data, takes a full
   `pg_dump` of the target's CURRENT contents first (`data/backups-postgres/pre-restore-safety-<timestamp>.dump`)
   so the restore itself is reversible; then runs `pg_restore --clean --if-exists` to drop
   and recreate the target's objects from the backup.
4. **Multi-tenant note:** this replaces the ENTIRE target database - every tenant schema
   and the control-plane schema at once. There is no per-tenant-only restore yet (see
   section 5). Restoring a multi-tenant production database rolls every tenant back to
   the same point in time; make sure that's actually what you want before passing
   `--force`.

**Rehearsal:** `npm run restore -- --latest --target postgresql://user:pass@host:5432/finops_rehearsal --force`
against a scratch database, then point a second copy of the server at it with its own
`FINOPS_POSTGRES_URL`.

## 4. Schema migrations

- The baseline (`schema.sqlite.js` / `schema.postgres.js`) is **frozen**. Every later change
  is a numbered file in `server/storage/migrations/`, applied once, in order, recorded in
  `schema_migrations`. See `server/storage/migrations/README.md` for how to write one.
- **You no longer delete `data/finops.db` after a schema change.** The migration upgrades it in place.
- **SQLite:** before any pending migration touches a database that has data, a verified
  snapshot is written to `data/backups/pre-migration-v<from>-to-v<to>-<time>.db`
  (newest 5 kept). If that snapshot can't be written, the migration is refused.
- **Postgres:** no automatic pre-migration snapshot - take a manual backup (`npm run backup`,
  now that A10 gives you a real one, or your own `pg_dump`) **before deploying** a release
  that contains a migration. Concurrent instances are safe (advisory lock).
- Startup **refuses** if an already-applied migration's source was edited (fix forward
  with a new migration), and refuses to run an *older* build against a *newer* database
  (override only if you are sure: `FINOPS_ALLOW_NEWER_SCHEMA=true`).
- `FINOPS_SKIP_PREMIGRATION_BACKUP=true` skips the snapshot (e.g. disk full) - at your own risk.
- Rolling back the application after a migration: migrations are written to be additive,
  so the previous release normally still works against the new schema - but it will
  **refuse to start** (see above) unless you set `FINOPS_ALLOW_NEWER_SCHEMA=true`. To truly
  roll back data, restore the pre-migration snapshot.

## 5. Not yet covered

- Postgres point-in-time recovery (recovery to an arbitrary point between snapshots) -
  `pg_dump`-based backups give you the last snapshot, taken at most every 6 hours, not
  continuous coverage. See `server/backupPostgres.js`'s header for why WAL-archiving-based
  PITR is out of scope for this pass specifically.
  See also `docs/tech-stack-migration-plan.md` and the README's RTO/RPO section for the
  actual measured numbers this implies.
- Per-tenant-schema backup/restore in multi-tenant Postgres mode - today it's
  whole-database only (see sections 1b/3b above); a real per-tenant restore needs
  schema-scoped dump/restore and is real, separate work.
- Automatic Postgres backup scheduling in multi-tenant mode (deliberately not started on
  a timer yet - see section 1b).
- Migrations for multi-tenant control-plane / per-tenant schemas.
- Off-machine backup shipping (do it with your own tooling for now) - this applies to
  both `data/backups/` and `data/backups-postgres/`.

