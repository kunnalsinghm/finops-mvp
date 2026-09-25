// routes/shadowTest.js - read-only views into shadow A/B test results.
// The tests themselves are triggered opt-in via the proxy
// (X-Enable-Shadow-Test), not through this route - this is reporting only.

const express = require("express");
const { requireAuth } = require("../auth");
const { getShadowTestSummary, getShadowComparisons } = require("../shadowTest");
const { listFlaggedTestCases } = require("../flaggedTestCases");

const router = express.Router();

router.get("/summary", requireAuth("read"), async (req, res) => {
  const days = Number(req.query.days) || 90;
  res.json(await getShadowTestSummary({ days, db: req.db }));
});

router.get("/comparisons", requireAuth("read"), async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(await getShadowComparisons({ limit, db: req.db }));
});

// A8: cheap groundwork for Compass - see flaggedTestCases.js. Read-only
// reporting here too, same as the two routes above; nothing writes to
// flagged_test_cases through this route file, only via the signals that
// capture it directly (shadowTest.js, anomaly.js).
router.get("/flagged-test-cases", requireAuth("read"), async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json(await listFlaggedTestCases({ limit, source: req.query.source, db: req.db }));
});

module.exports = router;
