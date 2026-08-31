// routes/data.js

const express = require("express");
const { requireAuth } = require("../auth");
const { exportUsageEvents, purgeUsageEvents } = require("../data");
const { exportFocus } = require("../focusExport");

const router = express.Router();

router.get("/export", requireAuth("read"), (req, res) => {
  const { from, to, format = "json" } = req.query;
  const result = exportUsageEvents({ from, to, format });

  if (format === "csv") {
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", "attachment; filename=usage_events_export.csv");
    return res.send(result);
  }
  res.json(result);
});

router.get("/export/focus", requireAuth("read"), (req, res) => {
  const { from, to, format = "json" } = req.query;
  const result = exportFocus({ from, to, format });

  if (format === "csv") {
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", "attachment; filename=focus_export.csv");
    return res.send(result);
  }
  res.json(result);
});

router.delete("/purge", requireAuth("manage_keys"), (req, res) => {
  const { before } = req.body || {};
  if (!before) {
    return res.status(400).json({ error: "'before' (ISO date) is required in the request body - retention purges must be explicit" });
  }
  try {
    const rowsDeleted = purgeUsageEvents(before, req.apiKey.key_id);
    res.json({ ok: true, rowsDeleted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;