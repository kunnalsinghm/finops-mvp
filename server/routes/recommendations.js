// routes/recommendations.js

const express = require("express");
const { requireAuth } = require("../auth");
const { getModelSwitchRecommendations, getCachingOpportunities } = require("../recommend");

const router = express.Router();

router.get("/", requireAuth("read"), (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json({
    model_switch: getModelSwitchRecommendations({ days }),
    caching_opportunities: getCachingOpportunities({ days }),
  });
});

module.exports = router;