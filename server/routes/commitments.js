// routes/commitments.js - prepaid credit balance tracking (see
// ../commitments.js for the burn-calculation and alert-tier logic).

const express = require("express");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { listCommitmentsWithStatus, checkCommitmentAlerts } = require("../commitments");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const commitments = await listCommitmentsWithStatus(req.db);
  res.json(commitments);
});

router.post("/", requireAuth("manage_budgets"), async (req, res) => {
  const { provider, label, initial_amount_usd, starts_at } = req.body || {};
  if (!provider || !label || !initial_amount_usd) {
    return res.status(400).json({ error: "provider, label, and initial_amount_usd are required" });
  }
  const result = await req.db.run(
    "INSERT INTO commitments (provider, label, initial_amount_usd, starts_at) VALUES (?, ?, ?, ?) RETURNING id",
    [provider, label, initial_amount_usd, starts_at || new Date().toISOString()]
  );
  await logAudit(req.apiKey.key_id, "commitment.create", label, { provider, initial_amount_usd }, req.db);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.delete("/:id", requireAuth("manage_budgets"), async (req, res) => {
  await req.db.run("DELETE FROM commitments WHERE id = ?", [req.params.id]);
  await req.db.run("DELETE FROM commitment_alert_state WHERE commitment_id = ?", [req.params.id]);
  await logAudit(req.apiKey.key_id, "commitment.delete", req.params.id, {}, req.db);
  res.json({ ok: true });
});

// Manually trigger a check (also runs automatically on a timer, alongside
// budget/burn-rate checks - see server/index.js / server/tenantJobs.js).
router.post("/check-now", requireAuth("read"), async (req, res) => {
  await checkCommitmentAlerts(req.db);
  res.json({ ok: true });
});

module.exports = router;
