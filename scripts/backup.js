// scripts/backup.js - run a one-off backup from the command line.
// Usage: npm run backup

const { runBackup } = require("../server/backup");

const result = runBackup();
if (result) {
  console.log(`Backup created: ${result}`);
  process.exit(0);
} else {
  console.error("Backup failed or was skipped - see logs/ for details.");
  process.exit(1);
}
