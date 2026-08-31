// routes/semanticCache.js
const express = require("express");
const { requireAuth } = require("../auth");
const { getSemanticCacheStats, clearSemanticCache } = require("../semanticCache");
const router = express.Router();

router.get("/stats", requireAuth("read"), (req, res) => {
  res.json(getSemanticCacheStats());
});

router.post("/clear", requireAuth("manage_keys"), (req, res) => {
  clearSemanticCache();
  res.json({ ok: true });
});

module.exports = router;
