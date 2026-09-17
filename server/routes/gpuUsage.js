// routes/gpuUsage.js - GPU/self-hosted inference cost ingestion + the
// blended API+GPU cost view. See gpuUsage.js for the shared-cluster
// allocation method and its documented limitations.

const express = require("express");
const { requireAuth } = require("../auth");
const { ingestGpuUsage, getBlendedCostByTeam } = require("../gpuUsage");

const router = express.Router();

router.post("/ingest", requireAuth("write"), async (req, res) => {
  try {
    const id = await ingestGpuUsage(req.body || {});
    res.status(201).json({ ok: true, id });
  } catch (err) {
    const status = err.code === "VALIDATION" ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get("/blended", requireAuth("read"), async (req, res) => {
  res.json(await getBlendedCostByTeam());
});

module.exports = router;
