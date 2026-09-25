// routes/reconcile.js

const express = require("express");
const { requireAuth } = require("../auth");
const { importCsv, getReconciliationReport } = require("../reconcile");

const router = express.Router();

// Accepts raw CSV text as the request body (Content-Type: text/csv or text/plain).
// Headers required: date,provider,cost
router.post("/upload", requireAuth("manage_budgets"), express.text({ type: "*/*", limit: "5mb" }), async (req, res) => {
  try {
    const result = await importCsv(req.body, req.db);
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "read" or "audit_read" (A9 auditor role) - the reconciliation report is
// audit/compliance-relevant evidence (billing discrepancies), see auth.js's
// ROLE_PERMISSIONS.auditor comment.
router.get("/report", requireAuth(["read", "audit_read"]), async (req, res) => {
  const thresholdPct = Number(req.query.threshold) || 10;
  res.json(await getReconciliationReport({ thresholdPct, db: req.db }));
});

module.exports = router;
