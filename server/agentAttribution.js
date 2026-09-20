// agentAttribution.js - per-agent/session/task cost attribution, the
// single most-cited gap across the 2026 competitor review (see the v2
// product plan): native provider dashboards and most gateways attribute
// cost by team/key at best, nothing tracks agent-level economics.
//
// A "task" here means: one distinct task_id value under a given agent_id.
// A task can span multiple usage_events (e.g. several LLM calls within one
// agent run, or genuine retries) - that's WHY these metrics exist instead
// of just using team/key attribution, which can't distinguish "3 cheap
// calls that each did useful work" from "3 calls because the first two
// failed."
//
// DESIGN DECISIONS (each of these is a genuine judgment call, not a
// standard formula - documented here rather than left implicit):
//
//   - cost-per-agent-task = total spend / count of DISTINCT task_ids.
//     Straightforward.
//
//   - cost-per-successful-completion = total spend / count of DISTINCT
//     task_ids that have AT LEAST ONE event tagged task_status='success'.
//     Filters out tasks that only ever failed/aborted, so a string of
//     dead-end retries doesn't make the agent look artificially efficient
//     by inflating the denominator with unsuccessful "tasks."
//
//   - retry rate = fraction of tasks with MORE THAN ONE event under the
//     same task_id. This is a proxy for "required more than one attempt,"
//     not a semantic judgment about whether those extra calls were
//     wasteful - a task that legitimately needs 3 LLM calls to complete
//     looks identical to one that needed 3 tries after 2 failures. Treat
//     this as a signal worth a human look, not a verdict.
//
//   - token efficiency ratio: the plan describes this as "useful output
//     per token consumed" - which has no objective measure without a
//     human or eval judgment of what's "useful" (see Compass's own
//     eval-layer honesty about word-overlap being a placeholder, not a
//     quality measure). The proxy used here is:
//       (output tokens on tasks that reached 'success') / (all tokens
//        consumed by the agent, success or not)
//     This answers "what fraction of total token spend went toward
//     something that actually finished," which is a genuine efficiency
//     signal - but it is NOT a measure of whether the successful output
//     was actually good. Don't oversell this number.

const defaultDb = require("./storage");
const { sinceDaysAgo, dayFloorExpr } = require("./storage/dialectSql");

const TASK_STATUSES = ["success", "failed", "aborted"];

function round4(n) {
  return Math.round((n || 0) * 10000) / 10000;
}

async function getAgentSummary(agentId, db = defaultDb) {
  const totals = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
            COUNT(*) AS event_count
     FROM usage_events WHERE agent_id = ?`,
    [agentId]
  );

  const taskRows = await db.all(
    `SELECT task_id,
            COUNT(*) AS event_count,
            SUM(CASE WHEN task_status = 'success' THEN 1 ELSE 0 END) AS success_count,
            SUM(output_tokens) AS output_tokens
     FROM usage_events
     WHERE agent_id = ? AND task_id IS NOT NULL
     GROUP BY task_id`,
    [agentId]
  );

  const totalTasks = taskRows.length;
  const successfulTasks = taskRows.filter((t) => Number(t.success_count) > 0);
  const retriedTasks = taskRows.filter((t) => Number(t.event_count) > 1);
  const totalCost = Number(totals.total_cost || 0);

  const costPerTask = totalTasks > 0 ? totalCost / totalTasks : null;
  const costPerSuccessfulCompletion = successfulTasks.length > 0 ? totalCost / successfulTasks.length : null;
  const retryRate = totalTasks > 0 ? retriedTasks.length / totalTasks : null;

  const successfulOutputTokens = successfulTasks.reduce((sum, t) => sum + Number(t.output_tokens || 0), 0);
  const totalTokens = Number(totals.total_input_tokens || 0) + Number(totals.total_output_tokens || 0);
  const tokenEfficiencyRatio = totalTokens > 0 ? successfulOutputTokens / totalTokens : null;

  return {
    agent_id: agentId,
    total_cost_usd: round4(totalCost),
    event_count: Number(totals.event_count || 0),
    total_tasks: totalTasks,
    successful_tasks: successfulTasks.length,
    cost_per_task_usd: costPerTask === null ? null : round4(costPerTask),
    cost_per_successful_completion_usd: costPerSuccessfulCompletion === null ? null : round4(costPerSuccessfulCompletion),
    retry_rate: retryRate === null ? null : Math.round(retryRate * 1000) / 1000,
    token_efficiency_ratio: tokenEfficiencyRatio === null ? null : Math.round(tokenEfficiencyRatio * 1000) / 1000,
  };
}

async function listAgentSummaries(db = defaultDb) {
  const agentRows = await db.all(
    "SELECT DISTINCT agent_id FROM usage_events WHERE agent_id IS NOT NULL"
  );
  return Promise.all(agentRows.map((r) => getAgentSummary(r.agent_id, db)));
}

async function getAgentTaskBreakdown(agentId, db = defaultDb) {
  const rows = await db.all(
    `SELECT task_id,
            COUNT(*) AS event_count,
            SUM(cost_usd) AS total_cost,
            MAX(task_status) AS last_status,
            SUM(CASE WHEN task_status = 'success' THEN 1 ELSE 0 END) AS success_count,
            MIN(event_time) AS started_at,
            MAX(event_time) AS last_event_at
     FROM usage_events
     WHERE agent_id = ? AND task_id IS NOT NULL
     GROUP BY task_id
     ORDER BY last_event_at DESC`,
    [agentId]
  );
  return rows.map((r) => ({
    task_id: r.task_id,
    event_count: Number(r.event_count),
    total_cost_usd: round4(r.total_cost),
    succeeded: Number(r.success_count) > 0,
    retried: Number(r.event_count) > 1,
    started_at: r.started_at,
    last_event_at: r.last_event_at,
  }));
}

// Forecast variance: predicts the most recent 7-day window using the 7
// days BEFORE it (a simple moving average, same method as forecast.js -
// deliberately not a different/fancier model just because this is
// per-team), then compares that prediction to what actually happened.
// This is intentionally a distinct, team-scoped implementation rather
// than reusing forecast.js's global getDailySpend/forecastSpend - those
// are global-only and already covered by their own tests; adding team
// scoping to them would have meant either changing their signature (risk
// to existing callers) or bolting on an optional param that only this
// caller uses. A parallel, narrowly-scoped function was the safer edit.
async function getForecastVariance(team, db = defaultDb) {
  const priorWindow = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(DISTINCT ${dayFloorExpr("event_time")}) AS days
     FROM usage_events
     WHERE team = ? AND event_time >= ${sinceDaysAgo(14)} AND event_time < ${sinceDaysAgo(7)}`,
    [team]
  );
  const recentWindow = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM usage_events WHERE team = ? AND event_time >= ${sinceDaysAgo(7)}`,
    [team]
  );

  const priorDays = Number(priorWindow.days || 0);
  if (priorDays < 3) {
    return { available: false, reason: `Not enough prior-window history yet (${priorDays}/3 days minimum).` };
  }

  const avgDailySpendPrior = Number(priorWindow.total || 0) / priorDays;
  const predicted = avgDailySpendPrior * 7;
  const actual = Number(recentWindow.total || 0);
  const variancePct = predicted > 0 ? ((actual - predicted) / predicted) * 100 : null;

  return {
    available: true,
    team,
    predicted_usd: round4(predicted),
    actual_usd: round4(actual),
    variance_pct: variancePct === null ? null : Math.round(variancePct * 10) / 10,
    method: "simple-moving-average, prior 7 days projecting the most recent 7 days",
  };
}

module.exports = { TASK_STATUSES, getAgentSummary, listAgentSummaries, getAgentTaskBreakdown, getForecastVariance };
