// routes/reconcile.js

const express = require("express");
const { requireAuth } = require("../auth");
const { importCsv, getReconciliationReport } = require("../reconcile");

const router = express.Router();

// Accepts raw CSV text as the request body (Content-Type: text/csv or text/plain).
// Headers required: date,provider,cost
router.post("/upload", requireAuth("manage_budgets"), express.text({ type: "*/*", limit: "5mb" }), (req, res) => {
  try {
    const result = importCsv(req.body);
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/report", requireAuth("read"), (req, res) => {
  const thresholdPct = Number(req.query.threshold) || 10;
  res.json(getReconciliationReport({ thresholdPct }));
});

module.exports = router;