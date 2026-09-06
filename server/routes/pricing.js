// routes/pricing.js - manual pricing override endpoint (safety net for stale catalogue rates)

const express = require("express");
const { setOverride, BASELINE_CATALOGUE } = require("../pricing");
const { requireAuth } = require("../auth");

const router = express.Router();
const { logAudit } = require("../audit");

router.get("/catalogue", requireAuth("read"), (req, res) => {
  res.json(BASELINE_CATALOGUE);
});

router.post("/override", requireAuth("manage_budgets"), (req, res) => {
  const { provider, model, input_per_1k, output_per_1k } = req.body || {};
  if (!provider || !model || input_per_1k == null || output_per_1k == null) {
    return res.status(400).json({
      error: "provider, model, input_per_1k, and output_per_1k are required",
    });
  }
  setOverride({ provider, model, input_per_1k, output_per_1k });
  logAudit(req.apiKey.key_id, "pricing.override", `${provider}/${model}`, { input_per_1k, output_per_1k });
  res.status(201).json({ ok: true });
});

module.exports = router;
