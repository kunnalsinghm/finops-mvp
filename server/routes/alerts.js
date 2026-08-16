// routes/alerts.js

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../auth");
const { checkBudgetAlerts, checkBurnRate } = require("../alerts");

const router = express.Router();

router.get("/", requireAuth("read"), (req, res) => {
  const rows = db.prepare("SELECT * FROM alerts_log ORDER BY id DESC LIMIT 100").all();
  res.json(rows);
});

router.post("/:id/ack", requireAuth("read"), (req, res) => {
  db.prepare("UPDATE alerts_log SET acknowledged = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Manually trigger a check (also runs automatically after each ingest + on a timer)
router.post("/check-now", requireAuth("read"), async (req, res) => {
  await checkBudgetAlerts();
  await checkBurnRate();
  res.json({ ok: true });
});

module.exports = router;