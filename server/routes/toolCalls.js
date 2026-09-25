// routes/toolCalls.js - agent tool-call ingestion + audit review. See
// toolCallGovernance.js for why this is a reporting mechanism, not a live
// blocking gate.

const express = require("express");
const { requireAuth } = require("../auth");
const { logToolCall, listToolCalls, checkToolCallPreflight, listPendingApprovals, decideApproval } = require("../toolCallGovernance");
const { logAudit } = require("../audit");

const router = express.Router();

router.post("/", requireAuth("write"), async (req, res) => {
  const { agent_id, session_id, task_id, tool_name, target, region, team } = req.body || {};
  if (!tool_name) {
    return res.status(400).json({ error: "tool_name is required" });
  }
  const result = await logToolCall({
    agent_id,
    session_id,
    task_id,
    tool_name,
    target,
    region,
    team,
    keyId: req.apiKey.key_id,
    raw: req.body,
    db: req.db,
  });
  res.status(201).json(result);
});

// A7: the pre-flight check an orchestrator calls BEFORE letting an agent
// act - see toolCallGovernance.js's checkToolCallPreflight for why this
// (and not logToolCall above, which is inherently after the fact) is the
// only place a "deny-list" or "approval gate" can actually apply. Gated by
// "write", same as logging a call - this is part of the same agent-facing
// path, not an admin/dashboard action, so the A9 'agent' role can call it.
router.post("/check", requireAuth("write"), async (req, res) => {
  const { agent_id, session_id, task_id, tool_name, target, team } = req.body || {};
  if (!tool_name) {
    return res.status(400).json({ error: "tool_name is required" });
  }
  const result = await checkToolCallPreflight({
    agent_id,
    session_id,
    task_id,
    tool_name,
    target,
    keyId: req.apiKey.key_id,
    team,
    db: req.db,
  });
  res.json(result);
});

// A7: the human-approval queue - "manage_keys" (admin) or "audit_read"
// (A9 auditor role, since a pending/decided approval queue is exactly the
// "tool-call approval history" evidence an auditor account is meant to
// reach) may VIEW it; only an admin may decide entries (below).
router.get("/approvals", requireAuth(["manage_keys", "audit_read"]), async (req, res) => {
  res.json(await listPendingApprovals(req.db));
});

router.post("/approvals/:id/approve", requireAuth("manage_keys"), async (req, res) => {
  const { reason } = req.body || {};
  const updated = await decideApproval({ id: req.params.id, decision: "approved", decided_by: req.apiKey.key_id, decision_reason: reason || null, db: req.db });
  if (!updated) return res.status(404).json({ error: "No pending approval with that id" });
  await logAudit(req.apiKey.key_id, "tool_call_approval.approve", String(req.params.id), { reason: reason || null }, req.db);
  res.json(updated);
});

router.post("/approvals/:id/deny", requireAuth("manage_keys"), async (req, res) => {
  const { reason } = req.body || {};
  const updated = await decideApproval({ id: req.params.id, decision: "denied", decided_by: req.apiKey.key_id, decision_reason: reason || null, db: req.db });
  if (!updated) return res.status(404).json({ error: "No pending approval with that id" });
  await logAudit(req.apiKey.key_id, "tool_call_approval.deny", String(req.params.id), { reason: reason || null }, req.db);
  res.json(updated);
});

// "read" or "audit_read" (A9 auditor role) - the flagged tool-call log is
// exactly the kind of "tool-call approval history" evidence an auditor
// account is meant to reach without the rest of general dashboard "read".
router.get("/", requireAuth(["read", "audit_read"]), async (req, res) => {
  const onlyFlagged = req.query.flagged === "true";
  const rows = await listToolCalls({ onlyFlagged, agent_id: req.query.agent_id, db: req.db });
  res.json(rows);
});

module.exports = router;
