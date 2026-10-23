// Child process for test/jobLock.test.js (kept OUT of test/ because `npm test` runs every .js file under it): one "instance" trying to run a job.
// Waits until START_AT (so every child has finished booting and they all contend
// at the same instant), then runs the job under the lock, holding it for HOLD_MS,
// and prints {"ran": true|false}.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  process.env.FINOPS_DB_DRIVER = "postgres";
  const storage = require("../server/storage");
  await storage.ready;
  const { runExclusive } = require("../server/jobLock");
  const startAt = Number(process.env.START_AT || 0);
  if (startAt > Date.now()) await sleep(startAt - Date.now());
  const result = await runExclusive(process.env.JOB, async () => {
    await sleep(Number(process.env.HOLD_MS || 500));
    await storage.run("INSERT INTO job_run_log (job, round, pid) VALUES (?, ?, ?)", [process.env.JOB, process.env.ROUND, process.pid]);
  });
  console.log(JSON.stringify({ ran: result.ran }));
  await storage.pool.end();
  process.exit(0);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
