// 0006 - anomaly_alert_state: fire-once tracking for the AGGREGATE anomaly
// checks added alongside this migration (daily-spend-vs-normal, agent
// retry-rate). The single-event cost-spike check in anomaly.js needs no
// such table - each event is its own independent judgment, so there's
// nothing to deduplicate. An aggregate check is different: the underlying
// condition ("today's spend is high", "this agent's retry rate is high")
// can stay true across many events in the same period, so without this
// table the SAME alert would fire on every single request for as long as
// the condition holds. Same "fire once per period" shape as budget_alert_state
// (see alerts.js), generalized with a scope_type/scope_value pair instead
// of a single budget_id, since these checks are scoped to a team or an
// agent_id rather than to one specific budget row.

module.exports = {
  version: 6,
  name: "anomaly_alert_state",
  up: {
    sqlite(db) {
      if (!db.tableExists("anomaly_alert_state")) {
        db.exec(`
          CREATE TABLE anomaly_alert_state (
            scope_type TEXT NOT NULL,   -- 'team' | 'agent' | 'org'
            scope_value TEXT NOT NULL,  -- team name / agent_id / 'org' sentinel
            period TEXT NOT NULL,       -- 'YYYY-MM-DD' (UTC) for the daily checks
            anomaly_type TEXT NOT NULL, -- 'daily-spend' | 'retry-rate'
            fired_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (scope_type, scope_value, period, anomaly_type)
          )
        `);
      }
    },
    async postgres(db) {
      if (!(await db.tableExists("anomaly_alert_state"))) {
        await db.exec(`
          CREATE TABLE anomaly_alert_state (
            scope_type TEXT NOT NULL,
            scope_value TEXT NOT NULL,
            period TEXT NOT NULL,
            anomaly_type TEXT NOT NULL,
            fired_at TEXT NOT NULL DEFAULT NOW()::text,
            PRIMARY KEY (scope_type, scope_value, period, anomaly_type)
          )
        `);
      }
    },
  },
};
