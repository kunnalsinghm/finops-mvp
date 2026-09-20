// routes/cache.js

const express = require("express");
const { requireAuth } = require("../auth");
const { getCacheStats, clearCache } = require("../cache");

const router = express.Router();

router.get("/stats", requireAuth("read"), (req, res) => {
  res.json(getCacheStats(req.tenantId));
});

router.post("/clear", requireAuth("manage_keys"), (req, res) => {
  clearCache(req.tenantId);
  res.json({ ok: true });
});

module.exports = router;