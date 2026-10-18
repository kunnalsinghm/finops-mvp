// Tenant migration 2 - usage_events.event_id, the same change as single-tenant
// migration 0014 (see that file for the why, the rollback and the Postgres
// notes). It is a separate copy on purpose: a migration's checksum covers its
// own source, so a shared helper edited later would change what an applied
// migration does without being detected.
//
// Runs once per tenant schema, when the tenant is opened or by
// `npm run migrate-tenants`. `transaction: false`: the unique index is built
// CONCURRENTLY so a large tenant keeps metering while it builds.
module.exports = {
  version: 2,
  name: "usage_event_id",
  transaction: false,
  up: {
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
