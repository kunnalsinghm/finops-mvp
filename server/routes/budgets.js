// routes/budgets.js - Multi-tier budgets + progressive threshold status
// (Slack/Email/PagerDuty delivery is a Phase-2+ integration - this gives you
// the underlying threshold math and an endpoint the dashboard/cron can poll.)

const express = require("express");
const db = require("../storage");
const { thisMonthClause } = require("../storage/dialectSql");
const { logAudit } = require("../audit");
const { requireAuth } = require("../auth");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const budgets = await db.all("SELECT * FROM budgets ORDER BY id DESC");
  res.json(budgets);
});

router.post("/", requireAuth("manage_budgets"), async (req, res) => {
  const { scope_type, scope_value, monthly_limit_usd } = req.body || {};
  if (!scope_type || !scope_value || !monthly_limit_usd) {
    return res
      .status(400)
      .json({ error: "scope_type, scope_value, and monthly_limit_usd are required" });
  }
  const result = await db.run(
    "INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES (?, ?, ?) RETURNING id",
    [scope_type, scope_value, monthly_limit_usd]
  );
  await logAudit(req.apiKey.key_id, "budget.create", scope_value, { scope_type, monthly_limit_usd });
  res.status(201).json({ id: result.lastInsertRowid });
});

// Status: spend-to-date this month per budget, with alert-tier classification
//
// Note: the original SQL used ROUND(SUM(cost_usd), 4) - Postgres has no
// round(double precision, integer) overload (only round(numeric, integer)),
// so that errors out on that backend. Rounding is done in JS after
// fetching instead, same pattern as forecast.js.
router.get("/status", requireAuth("read"), async (req, res) => {
  const budgets = await db.all("SELECT * FROM budgets");

  const results = [];
  for (const b of budgets) {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = await db.get(
      `SELECT SUM(cost_usd) AS spend
       FROM usage_events
       WHERE ${col} = ? AND ${thisMonthClause("event_time")}`,
      [b.scope_value]
    );

    const spent = Math.round((spend.spend || 0) * 10000) / 10000;
    const pct = b.monthly_limit_usd > 0 ? spent / b.monthly_limit_usd : 0;

    let tier = "ok";
    if (pct >= 1) tier = "exceeded";
    else if (pct >= 0.9) tier = "90%";
    else if (pct >= 0.8) tier = "80%";
    else if (pct >= 0.5) tier = "50%";

    results.push({
      ...b,
      spent_this_month: spent,
      pct_used: Math.round(pct * 1000) / 10,
      alert_tier: tier,
    });
  }

  res.json(results);
});

module.exports = router;
