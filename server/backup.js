// backup.js - automatic SQLite backups with retention.

const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const DATA_DIR = path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_PATH = process.env.FINOPS_DB_PATH || path.join(DATA_DIR, "finops.db");

const RETENTION_COUNT = Number(process.env.FINOPS_BACKUP_RETENTION) || 7;

function runBackup() {
  if (!fs.existsSync(DB_PATH)) {
    logger.warn("Backup skipped - no database file exists yet", { DB_PATH });
    return null;
  }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `finops-${timestamp}.db`);

  try {
    fs.copyFileSync(DB_PATH, backupPath);
    logger.info("Database backup created", { backupPath });
  } catch (err) {
    logger.error("Database backup failed", { error: err.message });
    return null;
  }

  pruneOldBackups();
  return backupPath;
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("finops-") && f.endsWith(".db"))
    .sort((a, b) => b.localeCompare(a)); // newest first - filename embeds an ISO timestamp, so string sort is reliable (mtime is not, e.g. after a git checkout)

  const toDelete = files.slice(RETENTION_COUNT);
  for (const f of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    logger.info("Pruned old backup", { file: f });
  }
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("finops-") && f.endsWith(".db"))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { runBackup, pruneOldBackups, listBackups, BACKUP_DIR };
