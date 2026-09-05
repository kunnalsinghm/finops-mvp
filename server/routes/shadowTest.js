// routes/shadowTest.js - read-only views into shadow A/B test results.
// The tests themselves are triggered opt-in via the proxy
// (X-Enable-Shadow-Test), not through this route - this is reporting only.

const express = require("express");
const { requireAuth } = require("../auth");
const { getShadowTestSummary, getShadowComparisons } = require("../shadowTest");

const router = express.Router();

router.get("/summary", requireAuth("read"), (req, res) => {
  const days = Number(req.query.days) || 90;
  res.json(getShadowTestSummary({ days }));
});

router.get("/comparisons", requireAuth("read"), (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(getShadowComparisons({ limit }));
});

module.exports = router;
