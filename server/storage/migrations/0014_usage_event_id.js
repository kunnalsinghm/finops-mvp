// 0014 - usage_events.event_id: an idempotency key for usage events.
//
// WHY: usage_events had no way to tell "the same event again" from "a second
// event". A spool replay run twice, a replay after a crash between the insert
// and the spool rewrite, or an insert that committed but whose acknowledgement
// was lost (so the proxy spooled an event that was already stored) each produced
// a duplicate row, i.e. a call billed twice. event_id is a UUID minted once, when
// the event is first built (routes/proxy.js, routes/ingest.js) and carried
// through the spool; the unique index makes the insert the arbiter
// (usageStore.js: ON CONFLICT (event_id) DO NOTHING).
//
// Nullable, with NO default: rows written before this migration, and spool lines
// written before it, keep event_id NULL and behave exactly as before (a unique
// index allows any number of NULLs). Nothing is backfilled.
//
// ROLLBACK: additive. An older build never names the column, so it keeps
// working against a migrated database; its inserts simply leave event_id NULL.
// To remove it entirely: DROP INDEX idx_usage_events_event_id; ALTER TABLE
// usage_events DROP COLUMN event_id.
//
// POSTGRES: ADD COLUMN with no default is metadata-only (no table rewrite). A
// plain CREATE UNIQUE INDEX would block every INSERT into usage_events - that
// is, metering - for the whole build, so it is built CONCURRENTLY. That cannot
// run inside a transaction, hence `transaction: false`, and the body must be
// safe to re-run: a failed concurrent build leaves an INVALID index of the same
// name behind, which "IF NOT EXISTS" alone would then skip forever, so a stale
// invalid one is dropped first. The migration is recorded only after it
// succeeds, so a crash anywhere re-runs it on the next start.
//
// SQLite always runs migrations in one transaction (the flag does not apply)
// and the index build is quick on a local file.
module.exports = {
  version: 14,
  name: "usage_event_id",
  transaction: false,
  up: {
    sqlite(db) {
      if (!db.columnExists("usage_events", "event_id")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN event_id TEXT");
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_event_id ON usage_events(event_id)");
    },
    async postgres(db) {
      await db.exec("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS event_id TEXT");
      const stale = await db.get(
        `SELECT 1 AS found FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_usage_events_event_id'
            AND c.relnamespace = current_schema()::regnamespace
            AND NOT i.indisvalid`
      );
      if (stale) await db.exec("DROP INDEX IF EXISTS idx_usage_events_event_id");
      await db.exec("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_events_event_id ON usage_events (event_id)");
    },
  },
};
