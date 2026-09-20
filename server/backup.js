// backup.js - SQLite backups that are consistent, verified, and restorable.
//
// WHY THE REWRITE. The previous version copied the database file with
// fs.copyFileSync. This database runs in WAL mode, where recent writes live in a
// separate "-wal" file until a checkpoint, so copying only the main file yields
// a backup that is stale at best and - measured against a live connection -
// can contain no tables at all. A backup nobody has restored is a hope, not a
// backup; this module makes three things true instead:
//
//   1. CONSISTENT  - the copy is made with SQLite's own VACUUM INTO, which
//      produces a complete, WAL-free snapshot even while the server is writing.
//   2. VERIFIED    - every backup is opened and integrity-checked the moment it
//      is written. A backup that fails is deleted and reported as a FAILURE
//      (and never triggers pruning of the older good ones).
//   3. RESTORABLE  - restoreBackup() is a tested code path, and verifyBackup()
//      proves a backup can be brought up to the CURRENT schema by the current
//      code (the "restore last month's backup after an upgrade" case).
//
// Postgres deployments are not covered here: use pg_dump / your provider's
// snapshots and point-in-time recovery (still an open item - see README).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");
const logger = require("./logger");
const migrator = require("./storage/migrator");

const DATA_DIR = path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_PATH = process.env.FINOPS_DB_PATH || path.join(DATA_DIR, "finops.db");
const RETENTION_COUNT = Number(process.env.FINOPS_BACKUP_RETENTION) || 7;

// A file that lacks these is not a usable Guard database, whatever its integrity.
const REQUIRED_TABLES = ["usage_events", "api_keys", "budgets"];
const COUNTED_TABLES = ["usage_events", "api_keys", "budgets", "alerts_log", "audit_log", "users"];

const isPostgres = () => process.env.FINOPS_DB_DRIVER === "postgres";
const quote = (p) => `'${String(p).replace(/'/g, "''")}'`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function isBackupName(f) {
  return f.startsWith("finops-") && f.endsWith(".db");
}

// ORDER BACKUPS BY CREATION SEQUENCE, NEVER BY THE CLOCK.
// Names are finops-<seq>-<timestamp>.db (seq = 6 digits, +1 per backup). An earlier
// version ordered by the timestamp alone, which assumes the system clock only moves
// forward. When it did not (NTP correction, VM resume, manual change) a fresh backup
// sorted as the OLDEST and was pruned the instant it was created - while the log said
// "created and verified" and `restore --latest` picked an older backup. The sequence
// number is immune to that. Files from before this change have no sequence; they sort
// as older than any sequenced backup, and among themselves by name as before.
const SEQ_NAME = /^finops-(\d{6})-(.+)\.db$/;
const backupSeq = (name) => { const m = SEQ_NAME.exec(name); return m ? Number(m[1]) : -1; };
const backupStamp = (name) => { const m = /^finops-(?:\d{6}-)?(\d{4}-.+)\.db$/.exec(name); return m ? m[1] : ""; };
function newestFirst(a, b) {
  return backupSeq(b) - backupSeq(a) || b.localeCompare(a);
}
function nextSequence(backupDir) {
  const names = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(isBackupName) : [];
  return Math.max(0, ...names.map(backupSeq)) + 1;
}

// Consistent point-in-time copy of a live SQLite database into a new file.
function snapshotDatabase(srcPath, destPath) {
  const src = new DatabaseSync(srcPath);
  try {
    src.exec("PRAGMA busy_timeout = 5000");
    src.exec(`VACUUM INTO ${quote(destPath)}`);
  } finally {
    src.close();
  }
}

// SQLite records its journal mode in the file header (bytes 18-19; 2 = WAL). Opening a
// WAL-flagged file - even read-only - creates "-shm" and "-wal" files BESIDE it. Backups
// made by the old file-copy implementation are all WAL-flagged, so inspecting one in place
// would litter (and modify) the backup folder.
function hasWalHeader(file) {
  const buf = Buffer.alloc(20);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    if (fs.readSync(fd, buf, 0, 20, 0) < 20) return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return buf[18] === 2 || buf[19] === 2;
}

// Reads a database file and reports whether it is sound and what is in it. The file is
// never modified and nothing is created beside it. Never throws: a file that can't even
// be opened is reported, not raised.
function inspectDatabase(file) {
  const report = { file, ok: false, problems: [], integrity: null, tables: [], counts: {}, schemaVersion: null };
  let db;
  let scratchDir = null;
  try {
    if (!fs.existsSync(file)) {
      report.problems.push("file does not exist");
      return report;
    }
    if (fs.existsSync(file + "-wal") && fs.statSync(file + "-wal").size > 0) {
      report.problems.push("an unmerged -wal file sits beside it; copying only the main file would silently lose recent data");
    }
    let openPath = file;
    if (hasWalHeader(file)) {
      // Inspect a throwaway copy so SQLite's sidecar files land in a temp dir, not next to the backup.
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "finops-inspect-"));
      openPath = path.join(scratchDir, "inspect.db");
      fs.copyFileSync(file, openPath);
    }
    db = new DatabaseSync(openPath, { readOnly: true });
    report.integrity = db.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check);
    if (!(report.integrity.length === 1 && report.integrity[0] === "ok")) {
      report.problems.push(`integrity check failed: ${report.integrity.slice(0, 3).join("; ")}`);
    }
    report.tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of REQUIRED_TABLES) {
      if (!report.tables.includes(t)) report.problems.push(`required table '${t}' is missing`);
    }
    for (const t of COUNTED_TABLES) {
      if (report.tables.includes(t)) report.counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    }
    report.schemaVersion = report.tables.includes(migrator.MIGRATIONS_TABLE)
      ? db.prepare(`SELECT MAX(version) AS v FROM ${migrator.MIGRATIONS_TABLE}`).get().v
      : 1; // no migrations table == a database from before migrations existed == the v1 baseline
  } catch (err) {
    report.problems.push(`cannot be read as a SQLite database: ${err.message}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    if (scratchDir) try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  report.ok = report.problems.length === 0;
  return report;
}

function runBackup({ dbPath = DB_PATH, backupDir = BACKUP_DIR, retention = RETENTION_COUNT } = {}) {
  if (isPostgres()) {
    logger.warn("Built-in backup covers SQLite only. Use pg_dump / provider snapshots + PITR for Postgres.");
    return null;
  }
  if (!fs.existsSync(dbPath)) {
    logger.warn("Backup skipped - no database file exists yet", { dbPath });
    return null;
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const now = stamp();
  const existing = fs.readdirSync(backupDir).filter(isBackupName).sort(newestFirst);
  if (existing.length && backupStamp(existing[0]) > now) {
    logger.warn("The system clock appears to have gone BACKWARDS since the last backup; ordering by sequence, so nothing is lost", {
      lastBackupStamp: backupStamp(existing[0]), nowStamp: now,
    });
  }
  const backupPath = path.join(backupDir, `finops-${String(nextSequence(backupDir)).padStart(6, "0")}-${now}.db`);

  try {
    snapshotDatabase(dbPath, backupPath);
  } catch (err) {
    try { fs.rmSync(backupPath, { force: true }); } catch { /* ignore */ }
    logger.error("Database backup failed", { error: err.message });
    return null;
  }

  // Trust nothing: open what we just wrote. A backup that can't be read is worse
  // than none, because it looks like protection.
  const report = inspectDatabase(backupPath);
  if (!report.ok) {
    try { fs.rmSync(backupPath, { force: true }); } catch { /* ignore */ }
    logger.error("Database backup FAILED verification and was discarded (older backups were kept)", {
      backupPath,
      problems: report.problems,
    });
    return null;
  }
  logger.info("Database backup created and verified", { backupPath, schemaVersion: report.schemaVersion, counts: report.counts });

  pruneOldBackups({ backupDir, retention, keep: backupPath });
  return backupPath;
}

function pruneOldBackups({ backupDir = BACKUP_DIR, retention = RETENTION_COUNT, keep = null } = {}) {
  if (!fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir).filter(isBackupName).sort(newestFirst);
  const protectedName = keep ? path.basename(keep) : null;
  const keepSet = new Set(files.slice(0, retention));
  if (protectedName) keepSet.add(protectedName); // the backup we just made must survive, whatever its name sorts as
  for (const f of files) {
    if (keepSet.has(f)) continue;
    fs.unlinkSync(path.join(backupDir, f));
    for (const ext of ["-wal", "-shm"]) fs.rmSync(path.join(backupDir, f + ext), { force: true });
    logger.info("Pruned old backup", { file: f });
  }
  sweepOrphanSidecars(backupDir);
}

// "-wal"/"-shm" files whose database file no longer exists are meaningless leftovers (an
// earlier version created them while verifying old-format backups and never removed them).
// Only ever touches sidecars of OUR backup files, and only when the main file is gone.
function sweepOrphanSidecars(backupDir) {
  if (!fs.existsSync(backupDir)) return;
  const all = new Set(fs.readdirSync(backupDir));
  for (const name of all) {
    const m = /^((?:finops|pre-migration)-.+\.db)-(?:wal|shm)$/.exec(name);
    if (m && !all.has(m[1])) {
      fs.rmSync(path.join(backupDir, name), { force: true });
      logger.info("Removed orphaned SQLite sidecar file", { file: name });
    }
  }
}

function listBackups({ backupDir = BACKUP_DIR } = {}) {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter(isBackupName)
    .map((f) => {
      const st = fs.statSync(path.join(backupDir, f));
      return { name: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => newestFirst(a.name, b.name));
}

function latestBackup({ backupDir = BACKUP_DIR } = {}) {
  const [first] = listBackups({ backupDir });
  return first ? path.join(backupDir, first.name) : null;
}

// "Is this backup actually usable?" - the question a backup must be able to
// answer BEFORE the day you need it. Checks the file, then proves the CURRENT
// code can bring it up to the current schema (on a throwaway copy; the backup
// itself is never modified).
function verifyBackup(file) {
  const before = inspectDatabase(file);
  const result = { file, ok: false, problems: [...before.problems], before, after: null };
  if (!before.ok) return result;

  const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "finops-verify-")), "restore-test.db");
  try {
    fs.copyFileSync(file, work);
    migrator.migrateSqliteFile(work);
    result.after = inspectDatabase(work);
    result.problems.push(...result.after.problems.map((p) => `after migrating to current schema: ${p}`));
    for (const t of Object.keys(before.counts)) {
      if (result.after.counts[t] !== before.counts[t]) {
        result.problems.push(`row count for '${t}' changed during migration (${before.counts[t]} -> ${result.after.counts[t]})`);
      }
    }
  } catch (err) {
    result.problems.push(`cannot be brought to the current schema by this version of the code: ${err.message}`);
  } finally {
    fs.rmSync(path.dirname(work), { recursive: true, force: true });
  }
  result.ok = result.problems.length === 0;
  return result;
}

// Replace the live database with a backup. STOP THE SERVER FIRST.
//
// Safe by construction:
//   - the backup is fully verified (incl. migratability) BEFORE anything is touched;
//   - the new file is staged beside the target and re-checked, then swapped in
//     with a rename;
//   - the database being replaced is never deleted: it is moved aside, along with
//     its -wal/-shm files (a stale WAL left next to a restored main file would be
//     replayed onto it and corrupt it);
//   - refuses to overwrite an existing database unless force is set.
function restoreBackup({ backupPath, targetPath = DB_PATH, force = false } = {}) {
  if (!backupPath) throw new Error("restoreBackup: backupPath is required");
  const report = verifyBackup(backupPath);
  if (!report.ok) {
    throw new Error(`Refusing to restore '${backupPath}' - it failed verification:\n  - ${report.problems.join("\n  - ")}`);
  }
  const exists = fs.existsSync(targetPath);
  if (exists && !force) {
    throw new Error(`'${targetPath}' already exists. Re-run with force to replace it (the current database is moved aside, not deleted).`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const staged = `${targetPath}.restoring-${stamp()}`;
  const movedAside = [];
  try {
    fs.copyFileSync(backupPath, staged);
    const check = inspectDatabase(staged);
    if (!check.ok) throw new Error(`staged copy failed verification: ${check.problems.join("; ")}`);

    const suffix = `.replaced-${stamp()}`;
    for (const ext of ["", "-wal", "-shm"]) {
      const from = targetPath + ext;
      if (fs.existsSync(from)) {
        fs.renameSync(from, from + suffix);
        movedAside.push({ from, to: from + suffix });
      }
    }
    fs.renameSync(staged, targetPath);
  } catch (err) {
    // Undo: put back whatever we moved aside, discard the staged copy. If the
    // undo itself fails, SAY SO and say where the data is - an operator staring
    // at a missing database must never have to guess.
    const stuck = [];
    for (const m of movedAside.reverse()) {
      try { fs.renameSync(m.to, m.from); } catch { stuck.push(m); }
    }
    try { fs.rmSync(staged, { force: true }); } catch { /* ignore */ }
    const busy = ["EBUSY", "EPERM", "EACCES"].includes(err.code) ? " Is the server still running? Stop it and try again." : "";
    if (stuck.length) {
      throw new Error(
        `Restore failed AND the automatic rollback could not fully complete.${busy} ` +
          `Your previous database files are safe at:\n  ${stuck.map((m) => `${m.to}  (was ${m.from})`).join("\n  ")}\n` +
          `Rename them back to their original names to recover. (${err.message})`
      );
    }
    throw new Error(`Restore failed and was rolled back; the existing database was left as it was.${busy} (${err.message})`);
  }
  logger.info("Database restored from backup", { backupPath, targetPath, movedAside: movedAside.map((m) => m.to) });
  return {
    restoredFrom: backupPath,
    target: targetPath,
    backupSchemaVersion: report.before.schemaVersion,
    currentSchemaVersion: report.after.schemaVersion,
    counts: report.before.counts,
    movedAside: movedAside.map((m) => m.to),
    note:
      report.before.schemaVersion < report.after.schemaVersion
        ? `The backup is at schema v${report.before.schemaVersion}; it will be migrated to v${report.after.schemaVersion} automatically on next start (a pre-migration snapshot is taken first).`
        : "The backup is already at the current schema version.",
  };
}

module.exports = {
  runBackup,
  pruneOldBackups,
  listBackups,
  latestBackup,
  snapshotDatabase,
  inspectDatabase,
  verifyBackup,
  restoreBackup,
  BACKUP_DIR,
};
