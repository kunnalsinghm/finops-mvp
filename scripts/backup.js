// scripts/backup.js - run a one-off backup from the command line.
// Usage: npm run backup
//
// Dispatches to the SQLite or Postgres backup implementation based on
// FINOPS_DB_DRIVER, so the same command works regardless of backend.

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

async function main() {
  if (isPostgres) {
    const { runBackup } = require("../server/backupPostgres");
    const result = await runBackup();
    if (result) {
      console.log(`Postgres backup created: ${result}`);
      process.exit(0);
    } else {
      console.error("Postgres backup failed or was skipped - see logs/ for details.");
      process.exit(1);
    }
  } else {
    const { runBackup } = require("../server/backup");
    const result = runBackup();
    if (result) {
      console.log(`Backup created: ${result}`);
      process.exit(0);
    } else {
      console.error("Backup failed or was skipped - see logs/ for details.");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
