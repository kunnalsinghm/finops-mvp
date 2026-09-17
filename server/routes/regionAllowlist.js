// routes/regionAllowlist.js - manage data-residency allow-list entries.
// Mirrors routes/modelAllowlist.js exactly (same read/write permission
// split, same validation shape).

const express = require("express");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { addRegionAllowlistEntry, removeRegionAllowlistEntry, listRegionAllowlistEntries } = require("../dataResidency");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const { scope_type, scope_value } = req.query;
  res.json(await listRegionAllowlistEntries({ scope_type, scope_value }));
});

router.post("/", requireAuth("manage_keys"), async (req, res) => {
  const { scope_type, scope_value, region } = req.body || {};
  if (!scope_type || !scope_value || !region) {
    return res.status(400).json({ error: "scope_type, scope_value, and region are all required" });
  }
  if (!["key", "team"].includes(scope_type)) {
    return res.status(400).json({ error: "scope_type must be 'key' or 'team'" });
  }
  try {
    const id = await addRegionAllowlistEntry({ scope_type, scope_value, region });
    await logAudit(req.apiKey.key_id, "region_allowlist.add", scope_value, { scope_type, region });
    res.status(201).json({ id, scope_type, scope_value, region });
  } catch (err) {
    if (err.message && /unique/i.test(err.message)) {
      return res.status(409).json({ error: "This exact allow-list entry already exists" });
    }
    throw err;
  }
});

router.delete("/:id", requireAuth("manage_keys"), async (req, res) => {
  const removed = await removeRegionAllowlistEntry(req.params.id);
  if (!removed) return res.status(404).json({ error: "No allow-list entry with that id" });
  await logAudit(req.apiKey.key_id, "region_allowlist.remove", req.params.id, {});
  res.json({ ok: true });
});

module.exports = router;
