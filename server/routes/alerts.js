// routes/alerts.js

const express = require("express");
const db = require("../storage");
const { requireAuth } = require("../auth");
const { checkBudgetAlerts, checkBurnRate } = require("../alerts");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const rows = await db.all("SELECT * FROM alerts_log ORDER BY id DESC LIMIT 100");
  res.json(rows);
});

router.post("/:id/ack", requireAuth("read"), async (req, res) => {
  await db.run("UPDATE alerts_log SET acknowledged = 1 WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

// Consolidated status for external monitoring tools to poll (the plan's
// "GET /api/alerts/status" - a single endpoint answering "is anything
// currently wrong", rather than requiring a monitoring tool to fetch and
// interpret the raw log itself). Unacknowledged count is the headline
// number; by_type breaks it down so a dashboard/pager integration can
// distinguish "one old unacked anomaly" from "budgets are on fire".
router.get("/status", requireAuth("read"), async (req, res) => {
  const unacked = await db.get("SELECT COUNT(*) AS n FROM alerts_log WHERE acknowledged = 0");
  const byType = await db.all(
    `SELECT type, COUNT(*) AS count, MAX(created_at) AS latest_at
     FROM alerts_log WHERE acknowledged = 0
     GROUP BY type ORDER BY count DESC`
  );
  const mostRecent = await db.get("SELECT * FROM alerts_log ORDER BY id DESC LIMIT 1");

  res.json({
    unacknowledged_count: Number(unacked.n || 0),
    status: Number(unacked.n || 0) === 0 ? "clear" : "attention_needed",
    by_type: byType.map((r) => ({ type: r.type, count: Number(r.count), latest_at: r.latest_at })),
    most_recent: mostRecent || null,
  });
});

// Manually trigger a check (also runs automatically after each ingest + on a timer)
router.post("/check-now", requireAuth("read"), async (req, res) => {
  await checkBudgetAlerts();
  await checkBurnRate();
  res.json({ ok: true });
});

module.exports = router;
