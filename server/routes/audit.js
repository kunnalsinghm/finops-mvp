// routes/audit.js - read-only access to the audit trail

const express = require("express");
const { requireAuth } = require("../auth");
const { getAuditLog } = require("../audit");

const router = express.Router();

// manage_keys (admin) or audit_read (auditor - A9) - see auth.js's
// ROLE_PERMISSIONS.auditor comment for why this is a distinct permission
// rather than an alias for "read".
router.get("/", requireAuth(["manage_keys", "audit_read"]), async (req, res) => {
  const { limit, action, actor } = req.query;
  res.json(await getAuditLog({ limit: Number(limit) || 100, action, actor, db: req.db }));
});

module.exports = router;