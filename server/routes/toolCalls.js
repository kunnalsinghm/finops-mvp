// routes/toolCalls.js - agent tool-call ingestion + audit review. See
// toolCallGovernance.js for why this is a reporting mechanism, not a live
// blocking gate.

const express = require("express");
const { requireAuth } = require("../auth");
const { logToolCall, listToolCalls } = require("../toolCallGovernance");

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
  });
  res.status(201).json(result);
});

router.get("/", requireAuth("read"), async (req, res) => {
  const onlyFlagged = req.query.flagged === "true";
  const rows = await listToolCalls({ onlyFlagged, agent_id: req.query.agent_id });
  res.json(rows);
});

module.exports = router;
