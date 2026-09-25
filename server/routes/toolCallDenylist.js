// routes/toolCallDenylist.js - manage tool-call deny-list entries. Reads
// available to anyone with dashboard read access; writes (add/remove) are
// admin-only (manage_keys) - same pattern as routes/modelAllowlist.js.

const express = require("express");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { addDenylistEntry, removeDenylistEntry, listDenylistEntries } = require("../toolCallDenylist");

const router = express.Router();

router.get("/", requireAuth("read"), async (req, res) => {
  const { scope_type, scope_value } = req.query;
  res.json(await listDenylistEntries({ scope_type, scope_value, db: req.db }));
});

router.post("/", requireAuth("manage_keys"), async (req, res) => {
  const { scope_type, scope_value, tool_name, target_pattern, reason } = req.body || {};
  if (!scope_type || !scope_value || !tool_name) {
    return res.status(400).json({ error: "scope_type, scope_value, and tool_name are all required" });
  }
  if (!["key", "team"].includes(scope_type)) {
    return res.status(400).json({ error: "scope_type must be 'key' or 'team'" });
  }
  const id = await addDenylistEntry({ scope_type, scope_value, tool_name, target_pattern: target_pattern || null, reason: reason || null, db: req.db });
  await logAudit(req.apiKey.key_id, "tool_call_denylist.add", scope_value, { scope_type, tool_name, target_pattern: target_pattern || null }, req.db);
  res.status(201).json({ id, scope_type, scope_value, tool_name, target_pattern: target_pattern || null, reason: reason || null });
});

router.delete("/:id", requireAuth("manage_keys"), async (req, res) => {
  const removed = await removeDenylistEntry(req.params.id, req.db);
  if (!removed) return res.status(404).json({ error: "No deny-list entry with that id" });
  await logAudit(req.apiKey.key_id, "tool_call_denylist.remove", req.params.id, {}, req.db);
  res.json({ ok: true });
});

module.exports = router;
