// 0008 - A7 tool-call governance (deny-list + approval queue) and A8
// shadow-test extensions (judge score, streamed flag, flagged test cases).
//
// All-new tables/columns, purely additive - a database without this
// migration just has zero deny-list entries (nothing denied, matching
// tool_call_denylist's default-allow-when-empty semantics - see
// toolCallDenylist.js), zero pending approvals, no judge score recorded,
// and no flagged test cases captured yet.

module.exports = {
  version: 8,
  name: "tool_call_governance_and_shadow_extensions",
  up: {
    sqlite(db) {
      if (!db.tableExists("tool_call_denylist")) {
        db.exec(`
          CREATE TABLE tool_call_denylist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_type TEXT NOT NULL,
            scope_value TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            target_pattern TEXT,
            reason TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_tool_denylist_scope ON tool_call_denylist(scope_type, scope_value)");

      if (!db.tableExists("tool_call_approvals")) {
        db.exec(`
          CREATE TABLE tool_call_approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT,
            session_id TEXT,
            task_id TEXT,
            tool_name TEXT NOT NULL,
            target TEXT,
            key_id TEXT,
            team TEXT,
            status TEXT NOT NULL DEFAULT 'pending_approval',
            risk_reasons TEXT,
            requested_at TEXT NOT NULL DEFAULT (datetime('now')),
            decided_at TEXT,
            decided_by TEXT,
            decision_reason TEXT,
            raw_json TEXT
          )
        `);
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_tool_approvals_status ON tool_call_approvals(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tool_approvals_agent ON tool_call_approvals(agent_id)");

      if (!db.tableExists("flagged_test_cases")) {
        db.exec(`
          CREATE TABLE flagged_test_cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            provider TEXT,
            model TEXT,
            prompt TEXT,
            response TEXT,
            reason TEXT,
            raw_json TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_flagged_test_cases_source ON flagged_test_cases(source)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_flagged_test_cases_time ON flagged_test_cases(created_at)");

      if (!db.columnExists("shadow_comparisons", "judge_score")) {
        db.exec("ALTER TABLE shadow_comparisons ADD COLUMN judge_score REAL");
      }
      if (!db.columnExists("shadow_comparisons", "streamed")) {
        db.exec("ALTER TABLE shadow_comparisons ADD COLUMN streamed INTEGER NOT NULL DEFAULT 0");
      }
    },
    async postgres(db) {
      if (!(await db.tableExists("tool_call_denylist"))) {
        await db.exec(`
          CREATE TABLE tool_call_denylist (
            id SERIAL PRIMARY KEY,
            scope_type TEXT NOT NULL,
            scope_value TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            target_pattern TEXT,
            reason TEXT,
            created_at TEXT NOT NULL DEFAULT NOW()::text
          )
        `);
      }
      await db.exec("CREATE INDEX IF NOT EXISTS idx_tool_denylist_scope ON tool_call_denylist(scope_type, scope_value)");

      if (!(await db.tableExists("tool_call_approvals"))) {
        await db.exec(`
          CREATE TABLE tool_call_approvals (
            id SERIAL PRIMARY KEY,
            agent_id TEXT,
            session_id TEXT,
            task_id TEXT,
            tool_name TEXT NOT NULL,
            target TEXT,
            key_id TEXT,
            team TEXT,
            status TEXT NOT NULL DEFAULT 'pending_approval',
            risk_reasons TEXT,
            requested_at TEXT NOT NULL DEFAULT NOW()::text,
            decided_at TEXT,
            decided_by TEXT,
            decision_reason TEXT,
            raw_json TEXT
          )
        `);
      }
      await db.exec("CREATE INDEX IF NOT EXISTS idx_tool_approvals_status ON tool_call_approvals(status)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_tool_approvals_agent ON tool_call_approvals(agent_id)");

      if (!(await db.tableExists("flagged_test_cases"))) {
        await db.exec(`
          CREATE TABLE flagged_test_cases (
            id SERIAL PRIMARY KEY,
            source TEXT NOT NULL,
            provider TEXT,
            model TEXT,
            prompt TEXT,
            response TEXT,
            reason TEXT,
            raw_json TEXT,
            created_at TEXT NOT NULL DEFAULT NOW()::text
          )
        `);
      }
      await db.exec("CREATE INDEX IF NOT EXISTS idx_flagged_test_cases_source ON flagged_test_cases(source)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_flagged_test_cases_time ON flagged_test_cases(created_at)");

      await db.exec("ALTER TABLE shadow_comparisons ADD COLUMN IF NOT EXISTS judge_score DOUBLE PRECISION");
      await db.exec("ALTER TABLE shadow_comparisons ADD COLUMN IF NOT EXISTS streamed INTEGER NOT NULL DEFAULT 0");
    },
  },
};
