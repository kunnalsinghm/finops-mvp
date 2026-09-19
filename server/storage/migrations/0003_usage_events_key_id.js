// 0003 - usage_events.key_id
//
// The API key that actually authenticated each event (as opposed to user_id,
// which /api/ingest lets the client declare). Backfilled ONCE, only when the
// column is newly added: before this existed the proxy stored the authenticating
// key in user_id, so it can be recovered wherever user_id is a real key's id.
// Best-effort by design - rows with a client-declared user_id stay NULL.
//
// Idempotent: a database that already has the column (from the earlier ad-hoc
// upgrade) is recorded as migrated without re-running the backfill.

const BACKFILL = `UPDATE usage_events SET key_id = user_id
                  WHERE key_id IS NULL AND user_id IN (SELECT key_id FROM api_keys)`;

module.exports = {
  version: 3,
  name: "usage_events_key_id",
  up: {
    sqlite(db) {
      if (db.columnExists("usage_events", "key_id")) return;
      db.exec("ALTER TABLE usage_events ADD COLUMN key_id TEXT");
      db.exec(BACKFILL);
    },
    async postgres(db) {
      if (await db.columnExists("usage_events", "key_id")) return;
      await db.exec("ALTER TABLE usage_events ADD COLUMN key_id TEXT");
      await db.exec(BACKFILL);
    },
  },
};
