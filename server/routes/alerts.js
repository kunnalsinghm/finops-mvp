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

// Manually trigger a check (also runs automatically after each ingest + on a timer)
router.post("/check-now", requireAuth("read"), async (req, res) => {
  await checkBudgetAlerts();
  await checkBurnRate();
  res.json({ ok: true });
});

module.exports = router;
