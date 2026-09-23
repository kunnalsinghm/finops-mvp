// 0004 - usage_events.project_id, usage_events.cost_center
//
// Two attribution dimensions called out explicitly by the Guard spec
// (canonical event schema, §5.1; cost-breakdown dimension list, §2.3) that
// were missing from the original column set: team/environment/feature/
// customer/agent/git-branch existed, project and cost-center did not.
//
// Both are plain client-supplied tags, exactly like feature_id/customer_id -
// nullable, no FK, no validation beyond "it's a string". A null value is
// bucketed under 'Untagged' by the /api/costs/by-project and
// /api/costs/by-cost-center reads, same convention as every other
// dimension in routes/costs.js.
//
// Idempotent, additive-only: safe to run against a database that already
// has one column but not the other (shouldn't happen outside manual
// intervention, but columnExists is checked independently for each).

module.exports = {
  version: 4,
  name: "usage_events_project_cost_center",
  up: {
    sqlite(db) {
      if (!db.columnExists("usage_events", "project_id")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN project_id TEXT");
      }
      if (!db.columnExists("usage_events", "cost_center")) {
        db.exec("ALTER TABLE usage_events ADD COLUMN cost_center TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_cost_center ON usage_events(cost_center)");
    },
    async postgres(db) {
      await db.exec("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS project_id TEXT");
      await db.exec("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost_center TEXT");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_usage_cost_center ON usage_events(cost_center)");
    },
  },
};
