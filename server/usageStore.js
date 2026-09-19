// usageStore.js - the single INSERT into usage_events used by the proxy and by
// the metering-spool replay (see meteringSpool.js).
//
// This was previously a private helper inside routes/proxy.js. It lives here
// so a spooled event (one that couldn't be written when the request finished)
// can be replayed through exactly the same INSERT, rather than a second copy
// of the SQL that could drift from it.

const db = require("./storage");

async function insertUsageEvent(row) {
  const result = await db.run(
    `INSERT INTO usage_events
       (event_time, provider, model, team, environment, git_branch, user_id, key_id,
        feature_id, customer_id, client_region, agent_id, session_id, task_id,
        task_status, workload_type, input_tokens, output_tokens, cost_usd, tagged, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    ]
  );
  return result.lastInsertRowid;
}

module.exports = { insertUsageEvent };
