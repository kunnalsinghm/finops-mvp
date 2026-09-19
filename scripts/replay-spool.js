// scripts/replay-spool.js - re-insert usage events that were spooled to disk
// while the database was unavailable. Run once the DB is healthy again:
//   npm run replay-spool
const storage = require("../server/storage");
const { replaySpool, spoolPath } = require("../server/meteringSpool");

(async () => {
  await storage.ready;
  const result = await replaySpool();
  console.log(`Spool file: ${spoolPath()}`);
  console.log(`Replayed ${result.replayed} of ${result.total} event(s); ${result.remaining} remaining.`);
  process.exit(result.remaining > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Replay failed:", err.message);
  process.exit(2);
});
