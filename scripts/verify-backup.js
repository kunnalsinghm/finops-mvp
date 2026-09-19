// scripts/verify-backup.js - prove a backup is actually restorable.
//
//   npm run backup:verify                       # newest backup
//   npm run backup:verify -- path/to/backup.db
//
// Opens the backup, checks integrity, and proves the CURRENT code can migrate it
// to the current schema with no rows lost - on a throwaway copy, never touching
// the backup or the live database. Exit code 0 = restorable, 1 = not. Run it on
// a schedule (cron / Task Scheduler): an unverified backup is a hope, not a backup.
const path = require("path");
const { verifyBackup, latestBackup } = require("../server/backup");

const file = process.argv[2] ? path.resolve(process.argv[2]) : latestBackup();
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
