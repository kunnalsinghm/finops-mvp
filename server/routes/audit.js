// routes/audit.js - read-only access to the audit trail

const express = require("express");
const { requireAuth } = require("../auth");
const { getAuditLog } = require("../audit");

const router = express.Router();

router.get("/", requireAuth("manage_keys"), (req, res) => {
  const { limit, action, actor } = req.query;
  res.json(getAuditLog({ limit: Number(limit) || 100, action, actor }));
});

module.exports = router;