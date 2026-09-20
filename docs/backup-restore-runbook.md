# Backup, restore and schema-migration runbook

Everything here is exercised by automated tests (`test/backup.test.js`,
`test/migrator.test.js`). A backup you have never restored is a hope, not a
backup - so the drill in section 3 is worth doing once, on a copy, before you need it.

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

Postgres is not covered by this: use `pg_dump` / your provider's snapshots and
point-in-time recovery. **PITR is not implemented yet.**

## 2. Check that your backups are restorable (do this on a schedule)

```
npm run backup:verify                 # newest backup
npm run backup:verify -- path\to\finops-....db
```

Exit code 0 = restorable. It opens the backup, checks integrity, then proves the
**current code** can migrate it to the current schema with no rows lost - on a throwaway
copy, never touching the backup or the live database. Run it daily (cron / Windows Task
Scheduler) and alert on a non-zero exit.

## 3. Restore

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

## 4. Schema migrations

- The baseline (`schema.sqlite.js` / `schema.postgres.js`) is **frozen**. Every later change
  is a numbered file in `server/storage/migrations/`, applied once, in order, recorded in
  `schema_migrations`. See `server/storage/migrations/README.md` for how to write one.
- **You no longer delete `data/finops.db` after a schema change.** The migration upgrades it in place.
- **SQLite:** before any pending migration touches a database that has data, a verified
  snapshot is written to `data/backups/pre-migration-v<from>-to-v<to>-<time>.db`
  (newest 5 kept). If that snapshot can't be written, the migration is refused.
- **Postgres:** no automatic snapshot - take a `pg_dump` **before deploying** a release
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

- Postgres point-in-time recovery, and automated Postgres backups.
- Migrations for multi-tenant control-plane / per-tenant schemas.
- Off-machine backup shipping (do it with your own tooling for now).
