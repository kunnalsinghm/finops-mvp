// routes/budgets.js - Multi-tier budgets + progressive threshold status
// (Slack/Email/PagerDuty delivery is a Phase-2+ integration - this gives you
// the underlying threshold math and an endpoint the dashboard/cron can poll.)

const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  const budgets = db.prepare("SELECT * FROM budgets ORDER BY id DESC").all();
  res.json(budgets);
});

router.post("/", (req, res) => {
  const { scope_type, scope_value, monthly_limit_usd } = req.body || {};
  if (!scope_type || !scope_value || !monthly_limit_usd) {
    return res
      .status(400)
      .json({ error: "scope_type, scope_value, and monthly_limit_usd are required" });
  }
  const info = db
    .prepare(
      "INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES (?, ?, ?)"
    )
    .run(scope_type, scope_value, monthly_limit_usd);
  res.status(201).json({ id: info.lastInsertRowid });
});

// Status: spend-to-date this month per budget, with alert-tier classification
router.get("/status", (req, res) => {
  const budgets = db.prepare("SELECT * FROM budgets").all();

  const results = budgets.map((b) => {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = db
      .prepare(
        `SELECT ROUND(SUM(cost_usd), 4) AS spend
         FROM usage_events
         WHERE ${col} = ? AND strftime('%Y-%m', event_time) = strftime('%Y-%m', 'now')`
      )
      .get(b.scope_value);

    const spent = spend.spend || 0;
    const pct = b.monthly_limit_usd > 0 ? spent / b.monthly_limit_usd : 0;

    let tier = "ok";
    if (pct >= 1) tier = "exceeded";
    else if (pct >= 0.9) tier = "90%";
    else if (pct >= 0.8) tier = "80%";
    else if (pct >= 0.5) tier = "50%";

    return {
      ...b,
      spent_this_month: spent,
      pct_used: Math.round(pct * 1000) / 10,
      alert_tier: tier,
    };
  });

  res.json(results);
});

module.exports = router;
