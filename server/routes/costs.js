// routes/costs.js - read endpoints powering the dashboard
//
// Note: every ROUND(SUM(cost_usd), 4) from the original SQL is now rounded
// in JS after fetching instead - Postgres has no round(double precision,
// integer) overload (only round(numeric, integer)), so that SQL errors out
// on that backend. Same pattern as forecast.js/budgets.js.

const express = require("express");
const { dayFloorExpr, todayClause } = require("../storage/dialectSql");
const { requireAuth } = require("../auth");
const { forecastSpend, MIN_DAYS_FOR_FORECAST } = require("../forecast");
const { getForecastVariance } = require("../agentAttribution");

const router = express.Router();

function round4(n) {
  return n == null ? 0 : Math.round(n * 10000) / 10000;
}

// Total cost + breakdown by team
router.get("/by-team", requireAuth("read"), async (req, res) => {
  const rows = await req.db.all(
    `SELECT COALESCE(team, 'Untagged') AS team,
            SUM(cost_usd) AS total_cost,
            COUNT(*) AS event_count
     FROM usage_events
     GROUP BY COALESCE(team, 'Untagged')
     ORDER BY total_cost DESC`
  );
  res.json(rows.map((r) => ({ ...r, total_cost: round4(r.total_cost) })));
});

// Cost over time (daily buckets)
router.get("/over-time", requireAuth("read"), async (req, res) => {
  const rows = await req.db.all(
    `SELECT ${dayFloorExpr("event_time")} AS day,
            SUM(cost_usd) AS total_cost
     FROM usage_events
     GROUP BY ${dayFloorExpr("event_time")}
     ORDER BY day ASC`
  );
  res.json(rows.map((r) => ({ ...r, total_cost: round4(r.total_cost) })));
});

// Cost by provider/model (for the "which model is expensive" view)
router.get("/by-model", requireAuth("read"), async (req, res) => {
  const rows = await req.db.all(
    `SELECT provider, model,
            SUM(cost_usd) AS total_cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            COUNT(*) AS event_count
     FROM usage_events
     GROUP BY provider, model
     ORDER BY total_cost DESC`
  );
  res.json(rows.map((r) => ({ ...r, total_cost: round4(r.total_cost) })));
});

// Cost-per-feature: requires the caller to pass X-Feature-Id (proxy) or a
// feature_id field (ingest) - events with no feature_id are grouped under
// 'Untagged' the same way team/environment tagging already works, rather
// than silently dropped from this view.
router.get("/by-feature", requireAuth("read"), async (req, res) => {
  const rows = await req.db.all(
    `SELECT COALESCE(feature_id, 'Untagged') AS feature_id,
            SUM(cost_usd) AS total_cost,
            COUNT(*) AS event_count
     FROM usage_events
     GROUP BY COALESCE(feature_id, 'Untagged')
     ORDER BY total_cost DESC`
  );
  res.json(rows.map((r) => ({ ...r, total_cost: round4(r.total_cost) })));
});

// Cost-per-customer: same shape as by-feature, keyed on X-Customer-Id /
// customer_id instead. Kept as a separate endpoint (rather than a single
// parameterized ?group_by=) so each stays a simple, cacheable GET with an
// obvious shape for the dashboard to consume.
router.get("/by-customer", requireAuth("read"), async (req, res) => {
  const rows = await req.db.all(
    `SELECT COALESCE(customer_id, 'Untagged') AS customer_id,
            SUM(cost_usd) AS total_cost,
            COUNT(*) AS event_count
     FROM usage_events
     GROUP BY COALESCE(customer_id, 'Untagged')
     ORDER BY total_cost DESC`
  );
  res.json(rows.map((r) => ({ ...r, total_cost: round4(r.total_cost) })));
});

// Untagged spend (shadow-AI-adjacent visibility - flagged as a gap earlier)
router.get("/untagged", requireAuth("read"), async (req, res) => {
  const row = await req.db.get(
    `SELECT SUM(cost_usd) AS total_untagged_cost, COUNT(*) AS event_count
     FROM usage_events WHERE tagged = 0`
  );
  res.json({ ...row, total_untagged_cost: round4(row.total_untagged_cost) });
});

// Simple summary for top-of-dashboard cards
router.get("/summary", requireAuth("read"), async (req, res) => {
  const totals = await req.db.get(
    `SELECT SUM(cost_usd) AS total_cost, COUNT(*) AS event_count FROM usage_events`
  );
  const today = await req.db.get(
    `SELECT SUM(cost_usd) AS today_cost FROM usage_events WHERE ${todayClause("event_time")}`
  );
  res.json({ ...totals, total_cost: round4(totals.total_cost), today_cost: round4(today.today_cost) });
});

// Spend forecast: simple moving-average projection - see forecast.js for
// the full reasoning and caveats. Returns available:false rather than a
// 4xx error when there isn't enough data yet, since "no forecast yet" is a
// normal state for a new install, not a client error.
router.get("/forecast", requireAuth("read"), async (req, res) => {
  const lookbackDays = Number(req.query.lookback_days) || 7;
  const horizonDays = Number(req.query.horizon_days) || 30;
  const forecast = await forecastSpend({ lookbackDays, horizonDays, db: req.db });
  if (!forecast) {
    return res.json({
      available: false,
      reason: `Need at least ${MIN_DAYS_FOR_FORECAST} days of usage data in the lookback window to forecast responsibly.`,
    });
  }
  res.json({ available: true, ...forecast });
});

// Actual vs. predicted spend for a team over the most recent 7-day window
// - a governance signal ("our own forecast was off by X%"), not a
// customer-facing forecast in itself. See agentAttribution.js for the
// exact method and why it's a separate, team-scoped implementation from
// the global /forecast endpoint above.
router.get("/forecast-variance", requireAuth("read"), async (req, res) => {
  const { team } = req.query;
  if (!team) {
    return res.status(400).json({ error: "team query parameter is required" });
  }
  const variance = await getForecastVariance(team, req.db);
  res.json(variance);
});

module.exports = router;
