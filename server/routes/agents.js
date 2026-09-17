// routes/agents.js - agent-level cost attribution (see agentAttribution.js
// for the cost-per-task/cost-per-successful-completion/retry-rate/
// token-efficiency formulas and the documented judgment calls behind each).

const express = require("express");
const { requireAuth } = require("../auth");
const { listAgentSummaries, getAgentSummary, getAgentTaskBreakdown } = require("../agentAttribution");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const summaries = await listAgentSummaries();
  res.json(summaries);
});

router.get("/:agentId", requireAuth("read"), async (req, res) => {
  const summary = await getAgentSummary(req.params.agentId);
  res.json(summary);
});

router.get("/:agentId/tasks", requireAuth("read"), async (req, res) => {
  const tasks = await getAgentTaskBreakdown(req.params.agentId);
  res.json(tasks);
});

module.exports = router;
