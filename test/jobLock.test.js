// test/jobLock.test.js - periodic jobs run ONCE across instances (RFC 0001, phase A4).
//
// Every instance runs the same setInterval jobs (budget / burn-rate / commitment
// alerts, the weekly briefing, tenant checks, the tenant lifecycle sweep, the
// Postgres backup). With two instances, every tick ran twice. On Postgres each job
// tick now takes a session-level pg_try_advisory_lock keyed by the job name; the
// instance that gets it runs the job, the others skip (debug log) and wait for the
// next tick. The lock is released when the job finishes OR throws, and a graceful
// shutdown lets a running job finish first. SQLite is single-instance by nature and
// is unchanged: the job just runs.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-jobLock-\d+\.db/.test(f)) { try { fs.unlinkSync(path.join(__dirname, f)); } catch {} }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-jobLock-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
const SCHEMA = `test_joblock_${process.pid}`;
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = SCHEMA;
const pgOnly = { skip: isPostgres ? false : "Postgres only (FINOPS_DB_DRIVER=postgres)" };
const sqliteOnly = { skip: isPostgres ? "SQLite only" : false };

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const jobLock = require("../server/jobLock");
const scheduler = require("../server/scheduler");
const logger = require("../server/logger");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await storage.ready;
  if (isPostgres) await storage.run("CREATE TABLE IF NOT EXISTS job_run_log (job TEXT, round TEXT, pid INTEGER)");
});
test.afterEach(() => jobLock._reset());
test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
});

// Is the advisory lock for this job name held by anyone? (Tried from a fresh connection.)
async function lockIsFree(name) {
  const client = await storage.pool.connect();
  try {
    const r = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [`finops_job:${name}`]);
    if (r.rows[0].got) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`finops_job:${name}`]);
    return r.rows[0].got;
  } finally { client.release(); }
}

// ------------------------------------------------------------- two processes
function child(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "test-support", "jobLockChild.js")], {
      env: { ...process.env, FINOPS_DB_DRIVER: "postgres", FINOPS_POSTGRES_SCHEMA: SCHEMA, FINOPS_DB_PATH: dbPath, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve(out.trim().split("\n").pop()) : reject(new Error(`child exited ${code}: ${err || out}`))));
  });
}

test("three real processes contending for one tick: exactly one runs the job, the others skip", pgOnly, async () => {
  for (const round of ["r1", "r2", "r3"]) {
    const job = `tick-${round}-${process.pid}`;
    const startAt = Date.now() + 3000; // every child has booted by then, so they contend at the same instant
    const outs = await Promise.all([1, 2, 3].map(() => child({ JOB: job, ROUND: round, START_AT: String(startAt), HOLD_MS: "700" })));
    const ran = outs.map((o) => JSON.parse(o).ran);
    assert.equal(ran.filter(Boolean).length, 1, `round ${round}: exactly one process may run the job, got ${JSON.stringify(ran)}`);
    const rows = await storage.all("SELECT pid FROM job_run_log WHERE job = ?", [job]);
    assert.equal(rows.length, 1, "and the job body executed exactly once");
  }
});

// ---------------------------------------------------------------- in process
test("the job runs, returns its value, and the lock is free afterwards (so the next tick runs)", pgOnly, async () => {
  const name = `seq-${process.pid}`;
  let ran = 0;
  const a = await jobLock.runExclusive(name, async () => { ran++; return "A"; });
  assert.deepEqual({ ran: a.ran, value: a.value }, { ran: true, value: "A" });
  assert.equal(await lockIsFree(name), true);
  const b = await jobLock.runExclusive(name, async () => { ran++; return "B"; });
  assert.equal(b.ran, true);
  assert.equal(ran, 2);
});

test("a second tick that arrives while the first is still running skips (and says so at debug level)", pgOnly, async (t) => {
  const name = `overlap-${process.pid}`;
  const debug = t.mock.method(logger, "debug", () => {});
  let release;
  const gate = new Promise((r) => (release = r));
  const first = jobLock.runExclusive(name, () => gate);
  try {
    await sleep(100); // the first has the lock
    const second = await jobLock.runExclusive(name, async () => { throw new Error("must not run"); });
    assert.equal(second.ran, false);
    assert.ok(debug.mock.calls.some((c) => /skip/i.test(c.arguments[0]) && JSON.stringify(c.arguments[1] || {}).includes(name)), "the skip is logged with the job name");
  } finally {
    release(); // always let the first job finish, or a failed assertion leaves its lock connection checked out
  }
  assert.equal((await first).ran, true);
});

test("the lock is released when the job THROWS, and the error still reaches the caller", pgOnly, async () => {
  const name = `throws-${process.pid}`;
  await assert.rejects(() => jobLock.runExclusive(name, async () => { throw new Error("job blew up"); }), /job blew up/);
  assert.equal(await lockIsFree(name), true, "a job that throws must not wedge the lock for every instance");
  const again = await jobLock.runExclusive(name, async () => "ok");
  assert.equal(again.ran, true);
});

test("if the unlock itself fails, the connection is destroyed rather than pooled, so the lock is still freed", pgOnly, async (t) => {
  const name = `unlockfail-${process.pid}`;
  const realConnect = storage.pool.connect.bind(storage.pool);
  t.mock.method(storage.pool, "connect", async () => {
    const c = await realConnect();
    const q = c.query.bind(c);
    c.query = async (sql, ...rest) => {
      if (/pg_advisory_unlock/.test(String(sql))) throw new Error("connection broke during unlock");
      return q(sql, ...rest);
    };
    return c;
  });
  const r = await jobLock.runExclusive(name, async () => "done");
  t.mock.restoreAll();
  assert.equal(r.ran, true, "the job's own result is not lost to a cleanup failure");
  assert.equal(await lockIsFree(name), true, "a connection that still held the lock must not go back into the pool");
});

test("different jobs do not exclude each other", pgOnly, async () => {
  const a = `A-${process.pid}`, b = `B-${process.pid}`;
  let release;
  const gate = new Promise((r) => (release = r));
  const first = jobLock.runExclusive(a, () => gate);
  try {
    await sleep(80);
    const other = await jobLock.runExclusive(b, async () => "ran");
    assert.equal(other.ran, true);
  } finally {
    release();
    await first;
  }
});

test("drain(): waits for a running job, then the lock is free and no new job starts", pgOnly, async () => {
  const name = `drain-${process.pid}`;
  let finished = false;
  const running = jobLock.runExclusive(name, async () => { await sleep(300); finished = true; });
  await sleep(80);
  const drained = await jobLock.drain({ timeoutMs: 5000 });
  assert.equal(finished, true, "drain waited for the job");
  assert.equal(drained.timedOut, false);
  await running;
  assert.equal(await lockIsFree(name), true);
  const after = await jobLock.runExclusive(`new-${process.pid}`, async () => { throw new Error("must not start while shutting down"); });
  assert.equal(after.ran, false);
  assert.equal(after.reason, "shutting-down");
});

test("drain() past its timeout force-releases the lock, so a stuck job cannot block shutdown", pgOnly, async () => {
  const name = `stuck-${process.pid}`;
  let release;
  const gate = new Promise((r) => (release = r));
  const running = jobLock.runExclusive(name, () => gate);
  try {
    await sleep(80);
    const t0 = Date.now();
    const drained = await jobLock.drain({ timeoutMs: 200 });
    assert.equal(drained.timedOut, true);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(await lockIsFree(name), true, "the lock's connection was destroyed, which frees the lock");
  } finally {
    release();
    await running; // the job's own cleanup must cope with the connection already being gone
  }
});

test("SQLite (single-instance by nature): the job simply runs, every time", sqliteOnly, async () => {
  let ran = 0;
  const [a, b] = await Promise.all([
    jobLock.runExclusive("any", async () => { ran++; return 1; }),
    jobLock.runExclusive("any", async () => { ran++; return 2; }),
  ]);
  assert.equal(a.ran && b.ran, true);
  assert.equal(ran, 2);
});

// ------------------------------------------------------------------ scheduler
const stubChecks = (counter) => ({
  checkBudgetAlerts: async () => { counter.n++; await sleep(150); },
  checkBurnRate: async () => { counter.n++; },
  checkCommitmentAlerts: async () => { counter.n++; },
  checkWeeklyBriefing: async () => { counter.n++; },
});

test("scheduler: the four single-tenant checks run once per tick, however many instances tick together", pgOnly, async () => {
  const counter = { n: 0 };
  const results = await Promise.all([1, 2, 3].map(() =>
    scheduler.runPeriodicChecks({ multiTenant: false, isShuttingDown: () => false, checks: stubChecks(counter) })));
  assert.equal(counter.n, 4, "four checks, once - not 12");
  assert.equal(results.filter((r) => r && r.ran).length, 1);
});

test("scheduler: a failing check is logged and does not stop the other checks or wedge the lock", pgOnly, async () => {
  const counter = { n: 0 };
  const checks = stubChecks(counter);
  checks.checkBurnRate = async () => { counter.n++; throw new Error("burn-rate exploded"); };
  await scheduler.runPeriodicChecks({ multiTenant: false, isShuttingDown: () => false, checks });
  assert.equal(counter.n, 4);
  assert.equal(await lockIsFree("periodic-checks"), true);
});

test("scheduler: multi-tenant runs the tenant checks and the lifecycle sweep under separate locks", pgOnly, async () => {
  const calls = [];
  const tenantJobs = { runPeriodicChecksForAllTenants: async () => { calls.push("tenant-checks"); await sleep(150); } };
  const tenantLifecycle = { runLifecycleSweep: async () => { calls.push("lifecycle"); await sleep(150); } };
  const deps = { multiTenant: true, isShuttingDown: () => false, tenantJobs, tenantLifecycle };
  await Promise.all([scheduler.runPeriodicChecks(deps), scheduler.runPeriodicChecks(deps)]);
  assert.deepEqual(calls.sort(), ["lifecycle", "tenant-checks"], "each ran once across two overlapping ticks");
});

test("scheduler: nothing starts while the process is shutting down", async () => {
  const counter = { n: 0 };
  const r = await scheduler.runPeriodicChecks({ multiTenant: false, isShuttingDown: () => true, checks: stubChecks(counter) });
  assert.equal(counter.n, 0);
  assert.equal(r.ran, false);
});

test("scheduler: the Postgres backup tick runs under the 'backup' lock; SQLite backs up locally with no lock", async () => {
  const calls = [];
  const deps = {
    multiTenant: false, driver: isPostgres ? "postgres" : "sqlite", isShuttingDown: () => false,
    pgBackup: { runBackup: async () => { calls.push("pg"); await sleep(150); } },
    sqliteBackup: () => { calls.push("sqlite"); },
  };
  if (isPostgres) {
    await Promise.all([scheduler.runBackupTick(deps), scheduler.runBackupTick(deps)]);
    assert.deepEqual(calls, ["pg"], "two instances' backup ticks: one dump");
  } else {
    await scheduler.runBackupTick(deps);
    assert.deepEqual(calls, ["sqlite"]);
  }
});

test("scheduler: multi-tenant Postgres does not schedule an automatic backup (a restore would roll back every tenant)", async () => {
  const calls = [];
  await scheduler.runBackupTick({ multiTenant: true, driver: "postgres", isShuttingDown: () => false, pgBackup: { runBackup: async () => calls.push("pg") }, sqliteBackup: () => calls.push("sqlite") });
  assert.deepEqual(calls, []);
});

// ------------------------------------------------------------- wiring + logger
test("index.js schedules through the scheduler and drains jobs on shutdown (no bare check calls left)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  assert.match(src, /scheduler\.runPeriodicChecks/);
  assert.match(src, /scheduler\.runBackupTick/);
  assert.match(src, /jobLock\.drain/, "a graceful shutdown must wait for running jobs before closing the database");
  for (const bare of ["checkBudgetAlerts()", "checkBurnRate()", "checkCommitmentAlerts()", "checkWeeklyBriefing()"]) {
    assert.ok(!src.includes(bare), `index.js must not call ${bare} directly: that would bypass the lock`);
  }
});

test("logger.debug is silent by default and writes when FINOPS_LOG_LEVEL=debug", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  delete process.env.FINOPS_LOG_LEVEL;
  logger.debug("quiet", { a: 1 });
  assert.equal(log.mock.calls.length, 0);
  process.env.FINOPS_LOG_LEVEL = "debug";
  try {
    logger.debug("loud", { a: 1 });
    assert.equal(log.mock.calls.length, 1);
    assert.match(String(log.mock.calls[0].arguments[0]), /\[DEBUG\] loud/);
  } finally { delete process.env.FINOPS_LOG_LEVEL; }
});
