// routes/tokenQuota.js - manage token quota entries. Reads are available to
// anyone with dashboard read access; writes (add/remove) require
// manage_budgets - token quotas are a consumption cap, same permission tier
// as dollar budgets, so a budget-manager (not just full admin) can set them.

const express = require("express");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { addQuota, removeQuota, listQuotas } = require("../tokenQuota");

const router = express.Router();

router.get("/", requireAuth("read"), (req, res) => {
  const { scope_type, scope_value } = req.query;
  res.json(listQuotas({ scope_type, scope_value }));
});

router.post("/", requireAuth("manage_budgets"), (req, res) => {
  const { scope_type, scope_value, period, token_limit } = req.body || {};
  if (!scope_type || !scope_value || !period || !token_limit) {
    return res.status(400).json({ error: "scope_type, scope_value, period, and token_limit are all required" });
  }
  if (!["key", "team"].includes(scope_type)) {
    return res.status(400).json({ error: "scope_type must be 'key' or 'team'" });
  }
  if (!["daily", "weekly"].includes(period)) {
    return res.status(400).json({ error: "period must be 'daily' or 'weekly'" });
  }
  try {
    const id = addQuota({ scope_type, scope_value, period, token_limit });
    logAudit(req.apiKey.key_id, "token_quota.add", scope_value, { scope_type, period, token_limit });
    res.status(201).json({ id, scope_type, scope_value, period, token_limit });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "A quota for this scope and period already exists" });
    }
    throw err;
  }
});

router.delete("/:id", requireAuth("manage_budgets"), (req, res) => {
  const removed = removeQuota(req.params.id);
  if (!removed) return res.status(404).json({ error: "No quota with that id" });
  logAudit(req.apiKey.key_id, "token_quota.remove", req.params.id, {});
  res.json({ ok: true });
});

module.exports = router;
