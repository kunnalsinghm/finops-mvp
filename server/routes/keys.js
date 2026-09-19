// routes/keys.js - create/list/quarantine/revoke API keys

const express = require("express");
const crypto = require("crypto");
const db = require("../storage");
const { requireAuth } = require("../auth");
const { quarantineKey, approveKey } = require("../governance");
const { logAudit } = require("../audit");
const router = express.Router();

function generateKey() {
  return "fk_" + crypto.randomBytes(20).toString("hex");
}

router.get("/", requireAuth("read"), async (req, res) => {
  const rows = await db.all(
    "SELECT id, key_id, label, role, team, allow_background, status, quarantine_reason, created_at FROM api_keys ORDER BY id DESC"
  );
  res.json(rows);
});

router.post("/", requireAuth("manage_keys"), async (req, res) => {
  const { label, role = "developer", team, allow_background = false } = req.body || {};
  if (!label) return res.status(400).json({ error: "label is required" });
  if (typeof allow_background !== "boolean") {
    return res.status(400).json({ error: "allow_background must be true or false" });
  }
  if (!["admin", "budget-manager", "developer", "viewer"].includes(role)) {
    return res.status(400).json({ error: "invalid role" });
  }
  const key_id = generateKey();
  await db.run("INSERT INTO api_keys (key_id, label, role, team, allow_background) VALUES (?, ?, ?, ?, ?)", [
    key_id,
    label,
    role,
    team || null,
    allow_background ? 1 : 0,
  ]);

  // key_id is only ever shown here at creation time - treat it like a password
  res.status(201).json({ key_id, label, role, team, allow_background });
});

// Bind an existing key to a team / grant or revoke background-workload rights
// without recreating it (recreating would mean redistributing a new secret).
// A team binding is what makes team budgets, allow-lists and quotas
// enforceable against this key - see keyIdentity.js. Pass "team": null to
// unbind. Only the fields present in the body are changed.
router.patch("/:keyId", requireAuth("manage_keys"), async (req, res) => {
  const body = req.body || {};
  const existing = await db.get("SELECT key_id, team, allow_background FROM api_keys WHERE key_id = ?", [req.params.keyId]);
  if (!existing) return res.status(404).json({ error: "Unknown key" });

  const sets = [];
  const params = [];
  if ("team" in body) {
    if (body.team !== null && (typeof body.team !== "string" || !body.team.trim())) {
      return res.status(400).json({ error: "team must be a non-empty string, or null to unbind" });
    }
    sets.push("team = ?");
    params.push(body.team === null ? null : body.team.trim());
  }
  if ("allow_background" in body) {
    if (typeof body.allow_background !== "boolean") {
      return res.status(400).json({ error: "allow_background must be true or false" });
    }
    sets.push("allow_background = ?");
    params.push(body.allow_background ? 1 : 0);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update - provide team and/or allow_background" });

  await db.run(`UPDATE api_keys SET ${sets.join(", ")} WHERE key_id = ?`, [...params, req.params.keyId]);
  await logAudit(req.apiKey.key_id, "key.update", req.params.keyId, {
    before: { team: existing.team, allow_background: Boolean(existing.allow_background) },
    changes: body,
  });
  const updated = await db.get("SELECT key_id, label, role, team, allow_background, status FROM api_keys WHERE key_id = ?", [req.params.keyId]);
  res.json({ ...updated, allow_background: Boolean(updated.allow_background) });
});

router.post("/:keyId/quarantine", requireAuth("approve_quarantine"), async (req, res) => {
  const { reason = "manually quarantined" } = req.body || {};
  await quarantineKey(req.params.keyId, reason);
  res.json({ ok: true });
});

router.post("/:keyId/approve", requireAuth("approve_quarantine"), async (req, res) => {
  await approveKey(req.params.keyId);
  res.json({ ok: true });
});

router.post("/:keyId/revoke", requireAuth("manage_keys"), async (req, res) => {
  await db.run("UPDATE api_keys SET status = 'revoked' WHERE key_id = ?", [req.params.keyId]);
  res.json({ ok: true });
});

module.exports = router;
