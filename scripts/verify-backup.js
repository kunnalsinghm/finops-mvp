// scripts/verify-backup.js - prove a backup is actually restorable.
//
//   npm run backup:verify                       # newest backup for the active FINOPS_DB_DRIVER
//   npm run backup:verify -- path/to/backup.db          # SQLite
//   npm run backup:verify -- path/to/backup.dump        # Postgres
//
// Dispatches to the SQLite or Postgres implementation based on
// FINOPS_DB_DRIVER (or on the given file's extension, if a path is given
// explicitly). Opens the backup and proves the CURRENT code/server can
// actually restore it - on a throwaway copy/database, never touching the
// backup or the live database. Exit code 0 = restorable, 1 = not. Run it on
// a schedule (cron / Task Scheduler): an unverified backup is a hope, not a
// backup.
const path = require("path");

const explicitPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const isPostgres = explicitPath
  ? explicitPath.endsWith(".dump")
  : process.env.FINOPS_DB_DRIVER === "postgres";

async function main() {
  if (isPostgres) {
    const { verifyBackup, latestBackup } = require("../server/backupPostgres");
    const file = explicitPath || latestBackup();
    if (!file) {
      console.error("No Postgres backup found. Run: npm run backup");
      process.exit(1);
    }
    const r = await verifyBackup(file);
    console.log(`Backup: ${file}`);
    if (r.ok) {
      console.log("OK - restorable (verified by restoring into a throwaway database).");
      console.log(`Rows: ${Object.entries(r.after.counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
      process.exit(0);
    }
    console.error("NOT RESTORABLE:\n  - " + r.problems.join("\n  - "));
    process.exit(1);
  } else {
    const { verifyBackup, latestBackup } = require("../server/backup");
    const file = explicitPath || latestBackup();
    if (!file) {
      console.error("No backup found. Run: npm run backup");
      process.exit(1);
    }
    const r = verifyBackup(file);
    console.log(`Backup: ${file}`);
    if (r.ok) {
      console.log(`OK - restorable. Schema v${r.before.schemaVersion} -> v${r.after.schemaVersion}.`);
      console.log(`Rows: ${Object.entries(r.before.counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
      process.exit(0);
    }
    console.error("NOT RESTORABLE:\n  - " + r.problems.join("\n  - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
