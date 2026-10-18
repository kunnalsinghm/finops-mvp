// usageStore.js - the single INSERT into usage_events used by the proxy and by
// the metering-spool replay (see meteringSpool.js).
//
// This was previously a private helper inside routes/proxy.js. It lives here
// so a spooled event (one that couldn't be written when the request finished)
// can be replayed through exactly the same INSERT, rather than a second copy
// of the SQL that could drift from it.

const { randomUUID } = require("crypto");
const defaultDb = require("./storage");

// The idempotency key of a usage event. Mint it ONCE, where the event is first
// built, and carry it unchanged through the spool: the same id on a retry or a
// replay is what lets the database recognise "this event again".
function newEventId() {
  return randomUUID();
}

// Inserts one usage event and returns its row id, or null if an event with the
// same event_id is already stored (the insert was ignored). A row without an
// event_id (older callers, older spool lines) is never treated as a duplicate.
// Duplicates are detected by changes === 0, not by the returned id: SQLite
// leaves lastInsertRowid at its previous value when an insert is ignored.
async function insertUsageEvent(row, db = defaultDb) {
  const result = await db.run(
    `INSERT INTO usage_events
       (event_time, provider, model, team, environment, git_branch, user_id, key_id,
        feature_id, customer_id, project_id, cost_center, client_region, agent_id, session_id, task_id,
        task_status, workload_type, input_tokens, output_tokens, cost_usd, tagged, raw_json, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [
      row.event_time,
      row.provider,
      row.model,
      row.team,
      row.environment,
      row.git_branch,
      row.user_id,
      row.key_id || null,
      row.feature_id || null,
      row.customer_id || null,
      row.project_id || null,
      row.cost_center || null,
      row.client_region || null,
      row.agent_id || null,
      row.session_id || null,
      row.task_id || null,
      row.task_status || null,
      row.workload_type || null,
      row.input_tokens,
      row.output_tokens,
      row.cost_usd,
      row.tagged,
      row.raw_json,
      row.event_id || null,
    ]
  );
  if (Number(result.changes) === 0) return null;
  return result.lastInsertRowid;
}

module.exports = { insertUsageEvent, newEventId };
