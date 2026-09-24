// anomaly.js - unified cost/usage-pattern anomaly detection.
//
// FIVE trigger types, all reachable through the one orchestrator at the
// bottom of this file (checkAllAnomalies), all logged to the same
// alerts_log under type "anomaly" so a dashboard or pager integration can
// treat "anomaly detection" as one coherent system rather than needing to
// know which specific function covers which trigger:
//
//   1. single-event cost spike (checkAnomaly) - one request costs wildly
//      more than the recent per-provider/model average. The original
//      check in this file; unchanged.
//   2. daily-spend-exceeds-normal (checkDailySpendAnomaly) - a team's
//      TOTAL spend today is wildly above its own recent daily average.
//      Catches sustained overspend (a loop calling a normal-cost model
//      far too often) that #1 would miss, since no single request in a
//      loop like that looks anomalous on its own.
//   3. retry-rate-exceeds-threshold (checkRetryRateAnomaly) - an agent's
//      fraction of multi-event tasks (see agentAttribution.js for what
//      "retry" means here) is unusually high. Surfaces a misbehaving
//      agent/prompt loop even though every individual call is
//      individually cheap and unremarkable.
//   4. new-model-appears (checkNewModelOrgWide) - a provider/model combo
//      that has NEVER been used anywhere in this deployment before.
//   5. new-geography-begins (checkNewGeographyOrgWide) - a client_region
//      that has NEVER been reported anywhere in this deployment before.
//
// #4 and #5 are DELIBERATELY ORG-WIDE, not per-key, which is what makes
// them a genuinely different signal from fraudDetection.js's
// checkNewModelMix/checkNewRegion (per-KEY: "new to this one key's own
// history"). fraudDetection.js answers "does this key's behavior look
// like it changed" (a security question, scoped to one credential,
// flag-only by design - see that file's header for why); these two answer
// "has anyone in this whole deployment ever done this before" (a
// visibility question, useful for catching unapproved model experiments
// or unplanned geographic expansion regardless of which key did it). Both
// systems can legitimately fire on the same event for different reasons -
// that's not duplication, it's two different questions being asked.
//
// FIRE-ONCE-PER-PERIOD: #1, #4 and #5 need no deduplication - #1 judges
// each event independently, and #4/#5 are true by construction only once
// per distinct model/region ever (the very next event with that same
// model/region is no longer "new"). #2 and #3 are different: the
// underlying condition (today's spend is high, this agent's retry rate is
// high) can stay true across many events in the same period, so without
// an explicit guard the same alert would refire on every subsequent
// request for as long as the condition holds. See anomaly_alert_state -
// same "fire once per period" shape as budget_alert_state in alerts.js,
// generalized with a scope_type/scope_value pair instead of one
// budget_id, since these are scoped to a team or an agent_id rather than
// to a specific budget row.

const defaultDb = require("./storage");
const { sinceDaysAgo, dayFloorExpr, todayClause } = require("./storage/dialectSql");
const { logAlert } = require("./governance");

// ---- #1: single-event cost spike --------------------------------------

// Needs a reasonable sample size before "average" means anything - avoids
// false alarms on a provider/model combo that's only been called once or twice.
const MIN_SAMPLE_SIZE = 10;

// A single event costing more than this multiple of the recent average
// triggers an alert. 5x is deliberately conservative - LLM costs naturally
// vary with prompt/response length, so this should catch genuine spikes
// (a runaway loop, an accidentally huge context dump) without flagging
// normal variance.
const ANOMALY_MULTIPLIER = 5;
const BASELINE_LOOKBACK_DAYS = 30;

async function checkAnomaly({ provider, model, cost_usd, team, db = defaultDb }) {
  if (!cost_usd || cost_usd <= 0) return null;

  const baseline = await db.get(
    `SELECT AVG(cost_usd) AS avg_cost, COUNT(*) AS n
     FROM usage_events
     WHERE provider = ? AND model = ?
       AND event_time >= ${sinceDaysAgo(BASELINE_LOOKBACK_DAYS)}`,
    [provider, model]
  );

  if (!baseline || baseline.n < MIN_SAMPLE_SIZE || !baseline.avg_cost) return null;

  if (cost_usd > baseline.avg_cost * ANOMALY_MULTIPLIER) {
    const message = `Cost anomaly: a single ${provider}/${model} request cost $${cost_usd.toFixed(4)} - ${Math.round(cost_usd / baseline.avg_cost)}x the recent average of $${baseline.avg_cost.toFixed(4)}${team ? ` (team: ${team})` : ""}.`;
    await logAlert("anomaly", message, db);
    return { flagged: true, type: "cost-spike", message, multiplier: Math.round(cost_usd / baseline.avg_cost) };
  }

  return null;
}

// ---- fire-once-per-period helper (#2 and #3 only) ----------------------

async function hasFiredAnomaly(scope_type, scope_value, period, anomaly_type, db) {
  const row = await db.get(
    "SELECT 1 AS found FROM anomaly_alert_state WHERE scope_type = ? AND scope_value = ? AND period = ? AND anomaly_type = ?",
    [scope_type, scope_value, period, anomaly_type]
  );
  return Boolean(row);
}

// Check-then-insert rather than "INSERT OR IGNORE" (SQLite-only syntax) or
// an ON CONFLICT clause (needs a matching constraint to target) - same
// portability tradeoff alerts.js's markFired makes, for the same reason.
async function markFiredAnomaly(scope_type, scope_value, period, anomaly_type, db) {
  const already = await hasFiredAnomaly(scope_type, scope_value, period, anomaly_type, db);
  if (already) return;
  await db.run(
    "INSERT INTO anomaly_alert_state (scope_type, scope_value, period, anomaly_type) VALUES (?, ?, ?, ?)",
    [scope_type, scope_value, period, anomaly_type]
  );
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ---- #2: daily-spend-exceeds-normal ------------------------------------

const DAILY_SPEND_BASELINE_LOOKBACK_DAYS = 14;
const MIN_BASELINE_DAYS_FOR_DAILY_SPEND_CHECK = 3; // don't judge a team's "normal" off 1-2 days
// Expressed as a percentage of the team's own recent average daily spend,
// per the product plan's "daily-spend-exceeds-percentage-of-normal"
// phrasing - 200% means "today is more than double a normal day."
const DAILY_SPEND_ANOMALY_THRESHOLD_PCT = 200;

async function checkDailySpendAnomaly({ team, db = defaultDb }) {
  if (!team) return null;
  const period = todayUtc();
  if (await hasFiredAnomaly("team", team, period, "daily-spend", db)) return null;

  const todayRow = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events WHERE team = ? AND ${todayClause("event_time")}`,
    [team]
  );
  const todaySpend = Number(todayRow?.spend || 0);
  if (todaySpend <= 0) return null;

  const baselineRow = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(DISTINCT ${dayFloorExpr("event_time")}) AS days
     FROM usage_events
     WHERE team = ? AND event_time >= ${sinceDaysAgo(DAILY_SPEND_BASELINE_LOOKBACK_DAYS)}
       AND NOT ${todayClause("event_time")}`,
    [team]
  );
  const baselineDays = Number(baselineRow?.days || 0);
  if (baselineDays < MIN_BASELINE_DAYS_FOR_DAILY_SPEND_CHECK) return null;

  const avgDailySpend = Number(baselineRow.total || 0) / baselineDays;
  if (avgDailySpend <= 0) return null;

  const pctOfNormal = (todaySpend / avgDailySpend) * 100;
  if (pctOfNormal > DAILY_SPEND_ANOMALY_THRESHOLD_PCT) {
    const message = `Daily spend anomaly: team '${team}' has spent $${todaySpend.toFixed(2)} today - ${Math.round(pctOfNormal)}% of its ${baselineDays}-day average of $${avgDailySpend.toFixed(2)}/day.`;
    await logAlert("anomaly", message, db);
    await markFiredAnomaly("team", team, period, "daily-spend", db);
    return { flagged: true, type: "daily-spend", message, pct_of_normal: Math.round(pctOfNormal) };
  }
  return null;
}

// ---- #3: retry-rate-exceeds-threshold -----------------------------------

// "Retry" here means the same thing it means in agentAttribution.js: more
// than one usage_event under the same task_id - see that file for the full
// definition and its caveats (it's a proxy for "took more than one
// attempt," not a semantic judgment about whether the extra calls were
// wasteful).
const MIN_TASKS_FOR_RETRY_RATE_CHECK = 5; // don't judge "rate" off a couple of tasks
const RETRY_RATE_ANOMALY_THRESHOLD = 0.5; // >50% of this agent's tasks needed more than one attempt

async function checkRetryRateAnomaly({ agent_id, db = defaultDb }) {
  if (!agent_id) return null;
  const period = todayUtc();
  if (await hasFiredAnomaly("agent", agent_id, period, "retry-rate", db)) return null;

  const taskRows = await db.all(
    `SELECT task_id, COUNT(*) AS event_count
     FROM usage_events
     WHERE agent_id = ? AND task_id IS NOT NULL
     GROUP BY task_id`,
    [agent_id]
  );
  const totalTasks = taskRows.length;
  if (totalTasks < MIN_TASKS_FOR_RETRY_RATE_CHECK) return null;

  const retriedTasks = taskRows.filter((t) => Number(t.event_count) > 1).length;
  const retryRate = retriedTasks / totalTasks;

  if (retryRate > RETRY_RATE_ANOMALY_THRESHOLD) {
    const message = `Retry-rate anomaly: agent '${agent_id}' needed more than one attempt on ${retriedTasks}/${totalTasks} tasks (${Math.round(retryRate * 100)}%).`;
    await logAlert("anomaly", message, db);
    await markFiredAnomaly("agent", agent_id, period, "retry-rate", db);
    return { flagged: true, type: "retry-rate", message, retry_rate: Math.round(retryRate * 1000) / 1000 };
  }
  return null;
}

// ---- #4 / #5: org-wide "never seen before" --------------------------

// Needs SOME history to exist first - otherwise literally every distinct
// model/region during a brand-new deployment's first hour would be
// flagged as "new," which is true but useless noise.
const MIN_ORG_HISTORY_FOR_NEW_MODEL_CHECK = 20;
const MIN_ORG_HISTORY_FOR_NEW_GEOGRAPHY_CHECK = 20;

async function checkNewModelOrgWide({ provider, model, db = defaultDb }) {
  if (!provider || !model) return null;

  const historyRow = await db.get("SELECT COUNT(*) AS n FROM usage_events");
  if (Number(historyRow?.n || 0) < MIN_ORG_HISTORY_FOR_NEW_MODEL_CHECK) return null;

  const seenBefore = await db.get(
    "SELECT 1 AS found FROM usage_events WHERE provider = ? AND model = ? LIMIT 1",
    [provider, model]
  );
  if (seenBefore) return null;

  const message = `New model anomaly: '${provider}/${model}' has never been used anywhere in this deployment before.`;
  await logAlert("anomaly", message, db);
  return { flagged: true, type: "new-model", message };
}

async function checkNewGeographyOrgWide({ client_region, db = defaultDb }) {
  if (!client_region) return null;

  const historyRow = await db.get("SELECT COUNT(*) AS n FROM usage_events");
  if (Number(historyRow?.n || 0) < MIN_ORG_HISTORY_FOR_NEW_GEOGRAPHY_CHECK) return null;

  const seenBefore = await db.get(
    "SELECT 1 AS found FROM usage_events WHERE client_region = ? LIMIT 1",
    [client_region]
  );
  if (seenBefore) return null;

  const message = `New geography anomaly: region '${client_region}' has never been reported anywhere in this deployment before.`;
  await logAlert("anomaly", message, db);
  return { flagged: true, type: "new-geography", message };
}

// ---- orchestrator -------------------------------------------------------

// Call once per ingest/proxy request, BEFORE the event is inserted - same
// ordering reason as every individual check above and as
// fraudDetection.js: the event being checked shouldn't already be counted
// in the baseline/history it's being compared against. Runs every
// applicable check in parallel (a check is skipped, not run, when its
// required field - team/agent_id/client_region - is absent) and returns
// every one that fired, so a caller gets "here is everything this event
// tripped" in one call instead of five.
async function checkAllAnomalies({ provider, model, cost_usd, team, agent_id, client_region, db = defaultDb }) {
  const results = await Promise.all([
    checkAnomaly({ provider, model, cost_usd, team, db }),
    checkDailySpendAnomaly({ team, db }),
    checkRetryRateAnomaly({ agent_id, db }),
    checkNewModelOrgWide({ provider, model, db }),
    checkNewGeographyOrgWide({ client_region, db }),
  ]);
  return results.filter(Boolean);
}

module.exports = {
  checkAnomaly,
  checkDailySpendAnomaly,
  checkRetryRateAnomaly,
  checkNewModelOrgWide,
  checkNewGeographyOrgWide,
  checkAllAnomalies,
  MIN_SAMPLE_SIZE,
  ANOMALY_MULTIPLIER,
  DAILY_SPEND_ANOMALY_THRESHOLD_PCT,
  RETRY_RATE_ANOMALY_THRESHOLD,
  MIN_TASKS_FOR_RETRY_RATE_CHECK,
};
