// routes/backup.js

const express = require("express");
const { requireAuth } = require("../auth");
const { runBackup, listBackups } = require("../backup");

const router = express.Router();

router.get("/", requireAuth("manage_keys"), (req, res) => {
  res.json(listBackups());
});

router.post("/run", requireAuth("manage_keys"), (req, res) => {
  const backupPath = runBackup();
  if (!backupPath) {
    return res.status(500).json({ error: "Backup failed - check server logs" });
  }
  res.json({ ok: true, backupPath });
});

module.exports = router;