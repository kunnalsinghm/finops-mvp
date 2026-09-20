// routes/tags.js - review and correct smart-tagging inferences (see
// smartTagging.js). Corrections both record feedback AND immediately fix
// the underlying event's team, so this is a real workflow, not just a
// feedback log nobody acts on.

const express = require("express");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { listInferences, correctTag } = require("../smartTagging");

const router = express.Router();

// ?uncorrected=true filters to inferences nobody has reviewed yet - the
// actual worklist a human would want, rather than the full history.
router.get("/inferences", requireAuth("read"), async (req, res) => {
  const onlyUncorrected = req.query.uncorrected === "true";
  const rows = await listInferences({ onlyUncorrected, db: req.db });
  res.json(rows);
});

router.post("/:usageEventId/correct", requireAuth("write"), async (req, res) => {
  const { team } = req.body || {};
  if (!team) {
    return res.status(400).json({ error: "team is required" });
  }
  try {
    const result = await correctTag(Number(req.params.usageEventId), team, req.db);
    await logAudit(req.apiKey.key_id, "tag.correct", req.params.usageEventId, { team }, req.db);
    res.json(result);
  } catch (err) {
    const status = err.code === "NOT_FOUND" ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
