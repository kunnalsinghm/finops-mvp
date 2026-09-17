// test/anomaly.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-anomaly-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_anomaly_${process.pid}`;
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
    // storage.ready is a background schema-creation promise kicked off the
    // moment ../server/storage was required above. Some tests in this file
    // may never happen to await it internally before this teardown runs -
    // without this explicit await, pool.end() below could run WHILE that
    // background query is still in flight, producing "Cannot use a pool
    // after calling end on the pool" as an unhandled rejection after the
    // test already finished.
    try {
      await storage.ready;
    } catch {
      // If schema init itself failed, there's nothing further to await -
      // proceed to drop/end below regardless.
    }
    // Drop the whole disposable schema so re-running this file doesn't
    // collide with leftover rows/UNIQUE constraints from a prior run -
    // the Postgres equivalent of deleting the SQLite temp file below.
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[anomaly.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { checkAnomaly, MIN_SAMPLE_SIZE, ANOMALY_MULTIPLIER } = require("../server/anomaly");

async function insertBaselineEvents(n, cost) {
  for (let i = 0; i < n; i++) {
    await storage.run(
      `INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, ?, ?, 1)`,
      [new Date().toISOString(), "openai", "gpt-4o", cost]
    );
  }
}

test("checkAnomaly returns null when sample size is too small", async () => {
  await insertBaselineEvents(3, 0.1);
  const result = await checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 5.0, team: "x" });
  assert.equal(result, null);
});

test("checkAnomaly flags a cost far above the established baseline", async () => {
  await insertBaselineEvents(MIN_SAMPLE_SIZE, 0.1);
  const result = await checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 0.1 * ANOMALY_MULTIPLIER * 2, team: "x" });
  assert.ok(result, "expected an anomaly to be flagged");
  assert.equal(result.flagged, true);
  assert.match(result.message, /anomaly/i);
});

test("checkAnomaly does not flag cost within normal range of baseline", async () => {
  await insertBaselineEvents(MIN_SAMPLE_SIZE, 0.1);
  const result = await checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 0.15, team: "x" });
  assert.equal(result, null);
});

test("checkAnomaly ignores zero-cost events", async () => {
  const result = await checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 0, team: "x" });
  assert.equal(result, null);
});
