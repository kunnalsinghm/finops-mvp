// routes/query.js - "ask your dashboard" plain-English queries. See
// nlQuery.js for why this is rule-based rather than LLM-backed.

const express = require("express");
const { requireAuth } = require("../auth");
const { queryDashboard } = require("../nlQuery");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const q = req.query.q;
  if (!q) {
    return res.status(400).json({ error: "q query parameter is required" });
  }
  res.json(await queryDashboard(q, req.db));
});

module.exports = router;
