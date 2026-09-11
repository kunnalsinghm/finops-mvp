// test/reconcile.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-reconcile-*.db* files from a PREVIOUS run of
// this file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-reconcile-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-reconcile-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_reconcile_${process.pid}`;
}

// legacyDb is ONLY used for the SQLite-specific .close() + temp-file
// cleanup below - it must NOT be used to seed or read fixture data,
// because it always talks to the old sync SQLite backend regardless of
// FINOPS_DB_DRIVER. Seeding/reading test data goes through `storage`
// instead, so it actually lands in whichever backend is under test.
const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[reconcile.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { importCsv, getReconciliationReport } = require("../server/reconcile");

test("importCsv rejects a CSV missing required headers", async () => {
  await assert.rejects(() => importCsv("foo,bar\n1,2"), /must have headers/);
});

test("importCsv parses valid rows and skips malformed ones", async () => {
  const csv = "date,provider,cost\n2026-01-01,openai,5.00\nmalformed-row\n2026-01-02,anthropic,3.50";
  const result = await importCsv(csv);
  assert.equal(result.rowCount, 2);
});

test("re-importing the same day/provider REPLACES rather than adds", async () => {
  await importCsv("date,provider,cost\n2026-02-01,openai,10.00");
  let report = await getReconciliationReport();
  let row = report.find((r) => r.day === "2026-02-01" && r.provider === "openai");
  assert.equal(row.reported_cost, 10);

  const second = await importCsv("date,provider,cost\n2026-02-01,openai,7.00");
  assert.equal(second.replacedDayProviderPairs, 1);

  report = await getReconciliationReport();
  row = report.find((r) => r.day === "2026-02-01" && r.provider === "openai");
  assert.equal(row.reported_cost, 7);
});

test("getReconciliationReport flags a gap above the threshold", async () => {
  await importCsv("date,provider,cost\n2026-03-01,openai,100.00");
  const report = await getReconciliationReport({ thresholdPct: 10 });
  const row = report.find((r) => r.day === "2026-03-01");
  assert.equal(row.tracked_cost, 0);
  assert.equal(row.gap_pct, 100);
  assert.equal(row.flagged, true);
});

test("getReconciliationReport does not flag when tracked spend covers reported spend", async () => {
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, ?, ?, 1)`,
    ["2026-04-01T10:00:00Z", "openai", "gpt-4o", 10.0]
  );
  await importCsv("date,provider,cost\n2026-04-01,openai,10.00");
  const report = await getReconciliationReport({ thresholdPct: 10 });
  const row = report.find((r) => r.day === "2026-04-01");
  assert.equal(row.flagged, false);
});
