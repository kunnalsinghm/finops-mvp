// routes/costs.js - read endpoints powering the dashboard

const express = require("express");
const db = require("../db");

const router = express.Router();

// Total cost + breakdown by team
router.get("/by-team", (req, res) => {
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
router.get("/over-time", (req, res) => {
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
router.get("/by-model", (req, res) => {
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
router.get("/untagged", (req, res) => {
  const rows = db
    .prepare(
      `SELECT ROUND(SUM(cost_usd), 4) AS total_untagged_cost, COUNT(*) AS event_count
       FROM usage_events WHERE tagged = 0`
    )
    .get();
  res.json(rows);
});

// Simple summary for top-of-dashboard cards
router.get("/summary", (req, res) => {
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

module.exports = router;
