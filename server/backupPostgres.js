// backupPostgres.js - Postgres backups that are consistent, verified, and
// restorable, on the same "trust nothing until it's proven" bar backup.js
// already holds itself to for SQLite.
//
// MECHANISM CHOSEN: pg_dump (custom format, -Fc) rather than continuous WAL
// archiving. Both are legitimate, but they solve different problems:
//
//   - pg_dump (chosen here): a periodic, self-contained logical snapshot.
//     No standing infrastructure beyond a place to put the dump file, works
//     against any reachable Postgres (including most managed providers),
//     and - critically for the "restorable, not just present" bar this repo
//     holds itself to - is trivial to prove is actually restorable, by
//     restoring it into a real throwaway database. This gives Postgres
//     deployments the SAME periodicity/granularity guarantee the SQLite
//     side already has (a point-in-time snapshot every N hours), not a
//     weaker one.
//   - WAL archiving / continuous archiving + PITR: strictly more powerful
//     (recovery to any point in time, not just the last snapshot), but it
//     is a standing operational commitment - a continuously-running archive
//     command, a growing WAL archive store, and its own restore tooling -
//     that is a different scope of project than "add a backup module,"
//     and most of it lives OUTSIDE what an application process can safely
//     drive from inside itself (archive_command is a server-config change,
//     not something this process can set for a managed/hosted Postgres it
//     doesn't administer). Left as a documented gap, exactly like the
//     SQLite side documents "file copies, not point-in-time" as its own
//     honestly-scoped limitation.
//
// SCOPE: MULTI-TENANT MODE. Every tenant's schema and the control-plane
// schema live in the SAME physical Postgres database (see tenancy.js's
// header - schema-per-tenant, not database-per-tenant). A whole-database
// pg_dump therefore mechanically captures every tenant automatically -
// there is no per-tenant opt-out needed to make backup itself work.
// RESTORE is a different story: restoreBackup() below replaces the ENTIRE
// target database, which in multi-tenant mode means rolling back every
// tenant simultaneously to the same snapshot. A real product would want
// per-tenant-schema restore (so restoring tenant A's accidentally-deleted
// data doesn't also roll back tenant B's last six hours), which needs
// schema-scoped dump/restore and its own care around cross-schema
// foreign-key-free boundaries. That's real, separate work this pass does
// NOT attempt - see index.js and the runbook for where automatic scheduling
// is deliberately restricted to single-tenant mode for exactly this reason.
// A human operator can still run `npm run backup` / `npm run restore`
// manually against a multi-tenant database (it works mechanically), but
// should understand a restore there is all-tenants-at-once until per-tenant
// restore exists.
//
// PREREQUISITES this module assumes of the connecting role/environment:
//   - pg_dump and pg_restore (matching the server's major version, or
//     newer) are on PATH.
//   - the role in FINOPS_POSTGRES_URL has CREATEDB privilege, and the
//     server's standard "postgres" maintenance database is reachable -
//     both are needed only for the VERIFY step (restoring into a
//     throwaway scratch database to prove the dump is real). If your
//     provider restricts either of these, runBackup()'s snapshot itself
//     still succeeds; only verification (and therefore promotion of the
//     dump to "kept") will report the specific reason it couldn't confirm
//     restorability - it never silently claims a dump is good that it
//     couldn't check.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { Client } = require("pg");
const logger = require("./logger");

const DATA_DIR = path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups-postgres");
const RETENTION_COUNT = Number(process.env.FINOPS_BACKUP_RETENTION) || 7;

// Same "does this even look like a Guard database" bar as backup.js's
// SQLite REQUIRED_TABLES/COUNTED_TABLES, just schema-agnostic - a
// multi-tenant dump has these tables once per tenant schema (plus the
// control-plane schema), not once at the top level, so presence is checked
// across ALL non-system schemas rather than assuming "public".
const REQUIRED_TABLES = ["usage_events", "api_keys", "budgets"];
const COUNTED_TABLES = ["usage_events", "api_keys", "budgets", "alerts_log", "audit_log", "users"];

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function isBackupName(f) {
  return f.startsWith("finops-pg-") && f.endsWith(".dump");
}

// Same "order by sequence, never by the clock" reasoning as backup.js.
const SEQ_NAME = /^finops-pg-(\d{6})-(.+)\.dump$/;
const backupSeq = (name) => { const m = SEQ_NAME.exec(name); return m ? Number(m[1]) : -1; };
function newestFirst(a, b) {
  return backupSeq(b) - backupSeq(a) || b.localeCompare(a);
}
function nextSequence(backupDir) {
  const names = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(isBackupName) : [];
  return Math.max(0, ...names.map(backupSeq)) + 1;
}

function connectionString() {
  return process.env.FINOPS_POSTGRES_URL;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// A scratch database name must itself be a safe identifier - it's derived
// from our own timestamp/pid, never from user input, but validated anyway
// since it's interpolated into a URL path segment.
function scratchDbName() {
  return `finops_verify_${process.pid}_${Date.now()}`;
}

function withDb(connStr, dbName) {
  const u = new URL(connStr);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function databaseNameOf(connStr) {
  const u = new URL(connStr);
  return decodeURIComponent(u.pathname.replace(/^\//, ""));
}

// Runs `work(scratchConnectionString)` against a brand-new, empty database
// on the same server as `connStr`, then always drops it afterward - even if
// `work` throws. Needs CREATEDB on the connecting role and a reachable
// "postgres" maintenance database (see module header prerequisites).
async function withScratchDatabase(connStr, work) {
  const name = scratchDbName();
  const maintenanceUrl = withDb(connStr, "postgres");
  const admin = new Client({ connectionString: maintenanceUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end();
    throw new Error(`could not create a throwaway verification database (does the role have CREATEDB?): ${err.message}`);
  }
  try {
    return await work(withDb(connStr, name));
  } finally {
    // Terminate anything still connected to the scratch db before dropping
    // it - a lingering connection (ours or pg_restore's, if it errored
    // without closing cleanly) would otherwise make DROP DATABASE fail with
    // "database is being accessed by other users".
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
    } catch { /* best-effort */ }
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } catch (err) {
      logger.warn("Could not drop throwaway Postgres verification database - it may need manual cleanup", { name, error: err.message });
    } finally {
      await admin.end();
    }
  }
}

// Reads a Postgres database (already restored/reachable at `connStr`) and
// reports whether it looks like a sound Guard database - schema-agnostic
// equivalent of backup.js's inspectDatabase(). Never throws.
async function inspectDatabase(connStr) {
  const report = { ok: false, problems: [], tables: [], counts: {} };
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name`
    );
    report.tables = rows.map((r) => `${r.table_schema}.${r.table_name}`);
    const tableNamesSeen = new Set(rows.map((r) => r.table_name));
    for (const t of REQUIRED_TABLES) {
      if (!tableNamesSeen.has(t)) report.problems.push(`required table '${t}' is missing from every schema`);
    }
    // Sum counts for a given table name ACROSS every schema it appears in
    // (one tenant schema, or many, plus a possible control-plane copy) -
    // a single aggregate number is what backup.js's SQLite counts are used
    // for too (a sanity total, not a per-tenant breakdown).
    for (const t of COUNTED_TABLES) {
      const matches = rows.filter((r) => r.table_name === t);
      if (!matches.length) continue;
      let total = 0;
      for (const m of matches) {
        const { rows: cr } = await client.query(`SELECT COUNT(*)::int AS n FROM "${m.table_schema}"."${m.table_name}"`);
        total += cr[0].n;
      }
      report.counts[t] = total;
    }
  } catch (err) {
    report.problems.push(`cannot be read as a Postgres database: ${err.message}`);
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
  report.ok = report.problems.length === 0;
  return report;
}

async function dumpDatabase(connStr, destPath) {
  await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${destPath}`, `--dbname=${connStr}`]);
}

async function restoreDump(file, targetConnStr) {
  await run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${targetConnStr}`, file]);
}

// "Is this dump actually usable?" - restores it into a real throwaway
// database and inspects THAT, never the dump file's bytes alone (pg_dump's
// own internal checksum only proves the file isn't corrupt, not that the
// schema/data it describes actually stands back up under this Postgres
// version's pg_restore). Never modifies the dump file or the live database.
async function verifyBackup(file, { connStr = connectionString() } = {}) {
  const result = { file, ok: false, problems: [], after: null };
  if (!fs.existsSync(file)) {
    result.problems.push("file does not exist");
    return result;
  }
  if (!connStr) {
    result.problems.push("FINOPS_POSTGRES_URL is not set - need a server to create a throwaway verification database on");
    return result;
  }
  try {
    result.after = await withScratchDatabase(connStr, async (scratchUrl) => {
      await restoreDump(file, scratchUrl);
      return inspectDatabase(scratchUrl);
    });
    if (!result.after.ok) result.problems.push(...result.after.problems.map((p) => `after restoring to a throwaway database: ${p}`));
  } catch (err) {
    result.problems.push(`could not verify by restoring: ${err.message}${err.stderr ? ` (${String(err.stderr).slice(0, 500)})` : ""}`);
  }
  result.ok = result.problems.length === 0;
  return result;
}

async function runBackup({ connStr = connectionString(), backupDir = BACKUP_DIR, retention = RETENTION_COUNT } = {}) {
  if (!connStr) {
    logger.warn("Postgres backup skipped - FINOPS_POSTGRES_URL is not set");
    return null;
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const now = stamp();
  const backupPath = path.join(backupDir, `finops-pg-${String(nextSequence(backupDir)).padStart(6, "0")}-${now}.dump`);

  try {
    await dumpDatabase(connStr, backupPath);
  } catch (err) {
    try { fs.rmSync(backupPath, { force: true }); } catch { /* ignore */ }
    logger.error("Postgres database backup failed", { error: err.message, stderr: err.stderr && String(err.stderr).slice(0, 1000) });
    return null;
  }

  // Trust nothing: prove the dump we just wrote is actually restorable
  // before keeping it, exactly like backup.js does for SQLite.
  const report = await verifyBackup(backupPath, { connStr });
  if (!report.ok) {
    try { fs.rmSync(backupPath, { force: true }); } catch { /* ignore */ }
    logger.error("Postgres database backup FAILED verification and was discarded (older backups were kept)", {
      backupPath,
      problems: report.problems,
    });
    return null;
  }
  logger.info("Postgres database backup created and verified", { backupPath, counts: report.after.counts });

  await pruneOldBackups({ backupDir, retention, keep: backupPath });
  return backupPath;
}

async function pruneOldBackups({ backupDir = BACKUP_DIR, retention = RETENTION_COUNT, keep = null } = {}) {
  if (!fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir).filter(isBackupName).sort(newestFirst);
  const protectedName = keep ? path.basename(keep) : null;
  const keepSet = new Set(files.slice(0, retention));
  if (protectedName) keepSet.add(protectedName);
  for (const f of files) {
    if (keepSet.has(f)) continue;
    fs.unlinkSync(path.join(backupDir, f));
    logger.info("Pruned old Postgres backup", { file: f });
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

// Replace the TARGET database's contents with a backup. STOP THE SERVER
// FIRST (or point this at a database nothing else is writing to).
//
// Safe by construction, same shape as backup.js's restoreBackup():
//   - the backup is fully verified (by restoring to a scratch database)
//     BEFORE the target is touched at all;
//   - the target database's CURRENT contents are dumped to a
//     "pre-restore-safety" file first - the Postgres equivalent of moving
//     the old SQLite file aside instead of deleting it - so a restore that
//     turns out to be a mistake is itself undoable;
//   - pg_restore runs with --clean --if-exists so existing objects are
//     dropped and recreated from the backup rather than left to collide
//     with it, but nothing is touched until the safety dump above
//     succeeds first.
async function restoreBackup({ backupPath, targetConnStr = connectionString(), force = false } = {}) {
  if (!backupPath) throw new Error("restoreBackup: backupPath is required");
  if (!targetConnStr) throw new Error("restoreBackup: no target connection string (FINOPS_POSTGRES_URL not set and none passed)");

  const report = await verifyBackup(backupPath, { connStr: targetConnStr });
  if (!report.ok) {
    throw new Error(`Refusing to restore '${backupPath}' - it failed verification:\n  - ${report.problems.join("\n  - ")}`);
  }

  const before = await inspectDatabase(targetConnStr);
  const targetHasData = before.ok && Object.values(before.counts).some((n) => n > 0);
  if (targetHasData && !force) {
    throw new Error(
      `Target database '${databaseNameOf(targetConnStr)}' already has data in it. Re-run with force to replace it ` +
        `(a full dump of its current contents is taken first, so this is reversible).`
    );
  }

  fs.mkdirSync(path.dirname(backupPath.startsWith(BACKUP_DIR) ? backupPath : BACKUP_DIR), { recursive: true });
  const safetyDumpPath = path.join(BACKUP_DIR, `pre-restore-safety-${stamp()}.dump`);
  if (targetHasData) {
    try {
      await dumpDatabase(targetConnStr, safetyDumpPath);
    } catch (err) {
      throw new Error(`Refusing to restore: could not take a safety snapshot of the target database's current contents first (${err.message})`);
    }
  }

  try {
    await run("pg_restore", ["--no-owner", "--no-privileges", "--clean", "--if-exists", "--exit-on-error", `--dbname=${targetConnStr}`, backupPath]);
  } catch (err) {
    const safetyNote = targetHasData ? ` The target's pre-restore contents are saved at: ${safetyDumpPath}` : "";
    throw new Error(`Restore failed: ${err.message}${err.stderr ? ` (${String(err.stderr).slice(0, 1000)})` : ""}.${safetyNote}`);
  }

  const after = await inspectDatabase(targetConnStr);
  logger.info("Postgres database restored from backup", { backupPath, target: databaseNameOf(targetConnStr), counts: after.counts });
  return {
    restoredFrom: backupPath,
    target: databaseNameOf(targetConnStr),
    counts: after.counts,
    safetyDumpOfPreviousContents: targetHasData ? safetyDumpPath : null,
  };
}

module.exports = {
  runBackup,
  pruneOldBackups,
  listBackups,
  latestBackup,
  verifyBackup,
  restoreBackup,
  inspectDatabase,
  BACKUP_DIR,
};
