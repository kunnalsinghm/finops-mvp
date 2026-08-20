// anomaly.js - single-request spend anomaly detection.
//
// Budgets catch monthly aggregate overspend, but nothing else catches "one
// buggy request that burned $40 in a single call" until the monthly total
// eventually reflects it - by which point the damage is done. This checks
// each new event against a rolling baseline for that provider/model and
// alerts immediately if it's a wild outlier, independent of budget status.

const db = require("./db");
const { logAlert } = require("./governance");

// Needs a reasonable sample size before "average" means anything - avoids
// false alarms on a provider/model combo that's only been called once or twice.
const MIN_SAMPLE_SIZE = 10;

// A single event costing more than this multiple of the recent average
// triggers an alert. 5x is deliberately conservative - LLM costs naturally
// vary with prompt/response length, so this should catch genuine spikes
// (a runaway loop, an accidentally huge context dump) without flagging
// normal variance.
const ANOMALY_MULTIPLIER = 5;

function checkAnomaly({ provider, model, cost_usd, team }) {
  if (!cost_usd || cost_usd <= 0) return null;

  const baseline = db
    .prepare(
      `SELECT AVG(cost_usd) AS avg_cost, COUNT(*) AS n
       FROM usage_events
       WHERE provider = ? AND model = ?
         AND event_time >= datetime('now', '-30 days')`
    )
    .get(provider, model);

  if (!baseline || baseline.n < MIN_SAMPLE_SIZE || !baseline.avg_cost) return null;

  if (cost_usd > baseline.avg_cost * ANOMALY_MULTIPLIER) {
    const message = `Cost anomaly: a single ${provider}/${model} request cost $${cost_usd.toFixed(4)} - ${Math.round(cost_usd / baseline.avg_cost)}x the recent average of $${baseline.avg_cost.toFixed(4)}${team ? ` (team: ${team})` : ""}.`;
    logAlert("anomaly", message);
    return { flagged: true, message, multiplier: Math.round(cost_usd / baseline.avg_cost) };
  }

  return null;
}

module.exports = { checkAnomaly, MIN_SAMPLE_SIZE, ANOMALY_MULTIPLIER };