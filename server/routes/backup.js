// routes/backup.js

const express = require("express");
const { requireAuth } = require("../auth");
const sqliteBackup = require("../backup");
const pgBackup = require("../backupPostgres");

const router = express.Router();

// Dispatches to whichever backend is active so the dashboard/API surface
// doesn't need to know which one is running - same reasoning as the npm
// scripts (scripts/backup.js et al.).
function isPostgres() {
  return process.env.FINOPS_DB_DRIVER === "postgres";
}

router.get("/", requireAuth("manage_keys"), (req, res) => {
  res.json(isPostgres() ? pgBackup.listBackups() : sqliteBackup.listBackups());
});

router.post("/run", requireAuth("manage_keys"), async (req, res) => {
  try {
    const backupPath = isPostgres() ? await pgBackup.runBackup() : sqliteBackup.runBackup();
    if (!backupPath) {
      return res.status(500).json({ error: "Backup failed - check server logs" });
    }
    res.json({ ok: true, backupPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;