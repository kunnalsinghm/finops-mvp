// scripts/restore.js - restore the database from a backup.
//
//   npm run restore -- --latest                 # newest backup for the active FINOPS_DB_DRIVER
//   npm run restore -- data/backups/finops-....db          # SQLite
//   npm run restore -- data/backups-postgres/finops-pg-....dump   # Postgres
//   npm run restore -- --latest --force         # replace an existing database
//
// Dispatches to the SQLite or Postgres implementation based on
// FINOPS_DB_DRIVER (or on the given file's extension, if a path is given
// explicitly). STOP THE SERVER FIRST. The backup is verified before
// anything is touched, and the existing data is never deleted outright -
// see backup.js / backupPostgres.js's restoreBackup() for exactly what
// "moved aside" / "safety dump" means for each backend.
const path = require("path");

const args = process.argv.slice(2);
const force = args.includes("--force");
const useLatest = args.includes("--latest");
const targetIdx = args.indexOf("--target");
const target = targetIdx >= 0 ? args[targetIdx + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--target");
const explicitPath = positional[0] ? path.resolve(positional[0]) : null;

const isPostgres = explicitPath
  ? explicitPath.endsWith(".dump")
  : process.env.FINOPS_DB_DRIVER === "postgres";

async function main() {
  if (isPostgres) {
    const { restoreBackup, latestBackup, BACKUP_DIR } = require("../server/backupPostgres");
    const backupPath = useLatest ? latestBackup() : explicitPath;
    if (!backupPath) {
      console.error(`Usage: npm run restore -- (--latest | <backup-file.dump>) [--target <postgres-connection-string>] [--force]\nBackups are in: ${BACKUP_DIR}`);
      process.exit(2);
    }
    try {
      const r = await restoreBackup({ backupPath, targetConnStr: target, force });
      console.log(`Restored ${r.restoredFrom}\n  -> ${r.target}`);
      console.log(`Rows: ${Object.entries(r.counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
      if (r.safetyDumpOfPreviousContents) console.log(`Previous database contents saved at:\n  ${r.safetyDumpOfPreviousContents}`);
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  } else {
    const { restoreBackup, latestBackup, BACKUP_DIR } = require("../server/backup");
    const backupPath = useLatest ? latestBackup() : explicitPath;
    if (!backupPath) {
      console.error(`Usage: npm run restore -- (--latest | <backup-file>) [--target <db-path>] [--force]\nBackups are in: ${BACKUP_DIR}`);
      process.exit(2);
    }
    try {
      const r = restoreBackup({ backupPath, targetPath: target ? path.resolve(target) : undefined, force });
      console.log(`Restored ${r.restoredFrom}\n  -> ${r.target}`);
      console.log(`Rows: ${Object.entries(r.counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
      if (r.movedAside.length) console.log(`Previous database kept at:\n  ${r.movedAside.join("\n  ")}`);
      console.log(r.note);
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
