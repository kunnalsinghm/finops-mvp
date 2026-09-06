// routes/costs.js - read endpoints powering the dashboard

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../auth");
const { forecastSpend, MIN_DAYS_FOR_FORECAST } = require("../forecast");

const router = express.Router();

// Total cost + breakdown by team
router.get("/by-team", requireAuth("read"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT COALESCE(team, 'Untagged') AS team,
              ROUND(SUM(cost_usd), 4) AS total_cost,
              COUNT(*) AS event_count
       FROM usage_events
       GROUP BY COALESCE(team, 'Untagged')
       ORDER BY total_cost DESC`
    )
    .all();
  res.json(rows);
});

// Cost over time (daily buckets)
router.get("/over-time", requireAuth("read"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT date(event_time) AS day,
              ROUND(SUM(cost_usd), 4) AS total_cost
       FROM usage_events
       GROUP BY date(event_time)
       ORDER BY day ASC`
    )
    .all();
  res.json(rows);
});

// Cost by provider/model (for the "which model is expensive" view)
router.get("/by-model", requireAuth("read"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT provider, model,
              ROUND(SUM(cost_usd), 4) AS total_cost,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              COUNT(*) AS event_count
       FROM usage_events
       GROUP BY provider, model
       ORDER BY total_cost DESC`
    )
    .all();
  res.json(rows);
});

// Untagged spend (shadow-AI-adjacent visibility - flagged as a gap earlier)
router.get("/untagged", requireAuth("read"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT ROUND(SUM(cost_usd), 4) AS total_untagged_cost, COUNT(*) AS event_count
       FROM usage_events WHERE tagged = 0`
    )
    .get();
  res.json(rows);
});

// Simple summary for top-of-dashboard cards
router.get("/summary", requireAuth("read"), (req, res) => {
  const totals = db
    .prepare(
      `SELECT ROUND(SUM(cost_usd), 4) AS total_cost, COUNT(*) AS event_count
       FROM usage_events`
    )
    .get();
  const today = db
    .prepare(
      `SELECT ROUND(SUM(cost_usd), 4) AS today_cost
       FROM usage_events WHERE date(event_time) = date('now')`
    )
    .get();
  res.json({ ...totals, today_cost: today.today_cost || 0 });
});

// Spend forecast: simple moving-average projection - see forecast.js for
// the full reasoning and caveats. Returns available:false rather than a
// 4xx error when there isn't enough data yet, since "no forecast yet" is a
// normal state for a new install, not a client error.
router.get("/forecast", requireAuth("read"), (req, res) => {
  const lookbackDays = Number(req.query.lookback_days) || 7;
  const horizonDays = Number(req.query.horizon_days) || 30;
  const forecast = forecastSpend({ lookbackDays, horizonDays });
  if (!forecast) {
    return res.json({
      available: false,
      reason: `Need at least ${MIN_DAYS_FOR_FORECAST} days of usage data in the lookback window to forecast responsibly.`,
    });
  }
  res.json({ available: true, ...forecast });
});

module.exports = router;
