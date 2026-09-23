// 0005 - tag_rules: declarative tagging policy ("FinOps as Code" Level 2)
//
// finops.yaml's `tagging_rules:` list gets synced into this table by
// POST /api/gitops/sync (see server/routes/gitops.js), the same sync pass
// that already handles `budgets:`. One rule = "any request from a key whose
// id starts with this prefix gets these tags filled in, for whichever of
// them the caller left blank." See server/tagRules.js for the full
// precedence rules and matching logic.
//
// New table, so this is purely additive - a database without it just has
// zero declarative rules (every event falls through to smart-tagging /
// stays untagged, same as before this migration existed).

module.exports = {
  version: 5,
  name: "tag_rules",
  up: {
    sqlite(db) {
      if (!db.tableExists("tag_rules")) {
        db.exec(`
          CREATE TABLE tag_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            api_key_prefix TEXT NOT NULL,
            team TEXT,
            environment TEXT,
            project_id TEXT,
            cost_center TEXT,
            customer_id TEXT,
            feature_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_tag_rules_prefix ON tag_rules(api_key_prefix)");
    },
    async postgres(db) {
      if (!(await db.tableExists("tag_rules"))) {
        await db.exec(`
          CREATE TABLE tag_rules (
            id SERIAL PRIMARY KEY,
            api_key_prefix TEXT NOT NULL,
            team TEXT,
            environment TEXT,
            project_id TEXT,
            cost_center TEXT,
            customer_id TEXT,
            feature_id TEXT,
            created_at TEXT NOT NULL DEFAULT NOW()::text
          )
        `);
      }
      await db.exec("CREATE INDEX IF NOT EXISTS idx_tag_rules_prefix ON tag_rules(api_key_prefix)");
    },
  },
};
