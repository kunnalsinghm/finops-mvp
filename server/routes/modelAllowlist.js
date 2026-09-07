// routes/modelAllowlist.js - manage model allow-list entries. Reads are
// available to anyone with dashboard read access; writes (add/remove) are
// admin-only (manage_keys), same as api key management.

const express = require("express");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { addAllowlistEntry, removeAllowlistEntry, listAllowlistEntries } = require("../modelAllowlist");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const { scope_type, scope_value } = req.query;
  res.json(await listAllowlistEntries({ scope_type, scope_value }));
});

router.post("/", requireAuth("manage_keys"), async (req, res) => {
  const { scope_type, scope_value, provider, model } = req.body || {};
  if (!scope_type || !scope_value || !provider || !model) {
    return res.status(400).json({ error: "scope_type, scope_value, provider, and model are all required" });
  }
  if (!["key", "team"].includes(scope_type)) {
    return res.status(400).json({ error: "scope_type must be 'key' or 'team'" });
  }
  try {
    const id = await addAllowlistEntry({ scope_type, scope_value, provider, model });
    await logAudit(req.apiKey.key_id, "model_allowlist.add", scope_value, { scope_type, provider, model });
    res.status(201).json({ id, scope_type, scope_value, provider, model });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "This exact allow-list entry already exists" });
    }
    throw err;
  }
});

router.delete("/:id", requireAuth("manage_keys"), async (req, res) => {
  const removed = await removeAllowlistEntry(req.params.id);
  if (!removed) return res.status(404).json({ error: "No allow-list entry with that id" });
  await logAudit(req.apiKey.key_id, "model_allowlist.remove", req.params.id, {});
  res.json({ ok: true });
});

module.exports = router;
