// routes/keys.js - create/list/quarantine/revoke API keys

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { quarantineKey, approveKey } = require("../governance");

const router = express.Router();

function generateKey() {
  return "fk_" + crypto.randomBytes(20).toString("hex");
}

router.get("/", requireAuth("read"), (req, res) => {
  const rows = db
    .prepare("SELECT id, key_id, label, role, team, status, quarantine_reason, created_at FROM api_keys ORDER BY id DESC")
    .all();
  res.json(rows);
});

router.post("/", requireAuth("manage_keys"), (req, res) => {
  const { label, role = "developer", team } = req.body || {};
  if (!label) return res.status(400).json({ error: "label is required" });
  if (!["admin", "budget-manager", "developer", "viewer"].includes(role)) {
    return res.status(400).json({ error: "invalid role" });
  }
  const key_id = generateKey();
  db.prepare(
    "INSERT INTO api_keys (key_id, label, role, team) VALUES (?, ?, ?, ?)"
  ).run(key_id, label, role, team || null);

  // key_id is only ever shown here at creation time - treat it like a password
  res.status(201).json({ key_id, label, role, team });
});

router.post("/:keyId/quarantine", requireAuth("approve_quarantine"), (req, res) => {
  const { reason = "manually quarantined" } = req.body || {};
  quarantineKey(req.params.keyId, reason);
  res.json({ ok: true });
});

router.post("/:keyId/approve", requireAuth("approve_quarantine"), (req, res) => {
  approveKey(req.params.keyId);
  res.json({ ok: true });
});

router.post("/:keyId/revoke", requireAuth("manage_keys"), (req, res) => {
  db.prepare("UPDATE api_keys SET status = 'revoked' WHERE key_id = ?").run(req.params.keyId);
  res.json({ ok: true });
});

module.exports = router;