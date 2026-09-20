// routes/pricing.js - manual pricing override endpoint (safety net for stale catalogue rates)

const express = require("express");
const { setOverride, getRate, BASELINE_CATALOGUE } = require("../pricing");
const { requireAuth } = require("../auth");

const router = express.Router();
const { logAudit } = require("../audit");

router.get("/catalogue", requireAuth("read"), (req, res) => {
  res.json(BASELINE_CATALOGUE);
});

// Spend the dashboard cannot trust: models with NO price (recorded as $0, so
// invisible to every dollar budget) and models priced only APPROXIMATELY via a
// family fallback. Computed by re-checking each distinct provider/model against
// the CURRENT price table rather than by reading markers off stored rows, so it
// covers proxy AND ingest traffic and also finds history recorded before a
// price existed. Fix an entry with POST /api/pricing/override.
router.get("/unpriced", requireAuth("read"), async (req, res) => {
  const groups = await req.db.all(
    `SELECT provider, model, COUNT(*) AS events,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM usage_events GROUP BY provider, model`
  );
  const unpriced = [];
  const approximate = [];
  for (const g of groups) {
    const rate = await getRate(g.provider, g.model, req.db);
    const base = { provider: g.provider, model: g.model, events: Number(g.events), input_tokens: Number(g.input_tokens), output_tokens: Number(g.output_tokens) };
    if (!rate) unpriced.push(base);
    else if (rate.approximate) approximate.push({ ...base, matched_family: rate.matched_family, recorded_cost_usd: Number(g.cost_usd) });
  }
  res.json({
    unpriced,
    approximate,
    unpriced_policy: process.env.FINOPS_UNPRICED_POLICY === "block" ? "block" : "flag",
    note: "Unpriced usage is recorded at $0 and does not count toward any dollar budget. Approximate usage is priced using a model-family guess. Correct either with POST /api/pricing/override.",
  });
});

router.post("/override", requireAuth("manage_budgets"), async (req, res) => {
  const { provider, model, input_per_1k, output_per_1k } = req.body || {};
  if (!provider || !model || input_per_1k == null || output_per_1k == null) {
    return res.status(400).json({
      error: "provider, model, input_per_1k, and output_per_1k are required",
    });
  }
  await setOverride({ provider, model, input_per_1k, output_per_1k, db: req.db });
  await logAudit(req.apiKey.key_id, "pricing.override", `${provider}/${model}`, { input_per_1k, output_per_1k }, req.db);
  res.status(201).json({ ok: true });
});

module.exports = router;
