// scripts/restore.js - restore the database from a backup.
//
//   npm run restore -- --latest                 # newest backup in data/backups
//   npm run restore -- data/backups/finops-....db
//   npm run restore -- --latest --force         # replace an existing database
//
// STOP THE SERVER FIRST. The database being replaced is moved aside (never
// deleted), the backup is verified before anything is touched, and the result
// tells you whether a schema migration will run on next start.
const path = require("path");
const { restoreBackup, latestBackup, BACKUP_DIR } = require("../server/backup");

const args = process.argv.slice(2);
const force = args.includes("--force");
const useLatest = args.includes("--latest");
const targetIdx = args.indexOf("--target");
const target = targetIdx >= 0 ? path.resolve(args[targetIdx + 1]) : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--target");
const backupPath = useLatest ? latestBackup() : positional[0] && path.resolve(positional[0]);

if (!backupPath) {
  console.error(`Usage: npm run restore -- (--latest | <backup-file>) [--target <db-path>] [--force]\nBackups are in: ${BACKUP_DIR}`);
  process.exit(2);
}
try {
  const r = restoreBackup({ backupPath, targetPath: target, force });
  console.log(`Restored ${r.restoredFrom}\n  -> ${r.target}`);
  console.log(`Rows: ${Object.entries(r.counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  if (r.movedAside.length) console.log(`Previous database kept at:\n  ${r.movedAside.join("\n  ")}`);
  console.log(r.note);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
