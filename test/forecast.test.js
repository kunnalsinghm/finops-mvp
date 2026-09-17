// test/forecast.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-forecast-*.db* files from a PREVIOUS run of this
// file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to clean up after itself.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-forecast-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-forecast-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_forecast_${process.pid}`;
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
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[forecast.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { forecastSpend, getDailySpend, MIN_DAYS_FOR_FORECAST } = require("../server/forecast");

async function seedDay(daysAgo, cost) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 1)`,
    [d.toISOString(), cost]
  );
}

test("forecastSpend returns null with fewer than MIN_DAYS_FOR_FORECAST days of data", async () => {
  await seedDay(0, 10);
  await seedDay(1, 12);
  // Only 2 distinct days - below the minimum of 3
  const result = await forecastSpend({ lookbackDays: 7 });
  assert.equal(result, null);
});

test("forecastSpend computes a simple moving average once enough days exist", async () => {
  // Fresh DB slate isn't practical mid-file (other tests share state), so
  // seed a distinctly-dated cluster of days here and use a short lookback
  // that only captures these.
  await seedDay(2, 30); // total so far across this file: day0=10, day1=12, day2=30
  // days_with_data = 3, total = 52, avg = 52/3 = 17.333...
  const result = await forecastSpend({ lookbackDays: 7, horizonDays: 30 });
  assert.ok(result, "expected a forecast once 3+ days of data exist");
  assert.equal(result.days_with_data, 3);
  assert.equal(result.avg_daily_spend_usd, Math.round((52 / 3) * 10000) / 10000);
  assert.equal(result.projected_spend_usd, Math.round((52 / 3) * 30 * 100) / 100);
  assert.equal(result.method, "simple-moving-average");
  assert.match(result.caveat, /ignores trends/i);
});

test("forecastSpend respects the lookback window - older days don't count", async () => {
  await seedDay(20, 999); // way outside a 7-day lookback
  const result = await forecastSpend({ lookbackDays: 7, horizonDays: 30 });
  assert.ok(result);
  assert.equal(result.days_with_data, 3, "the 20-days-ago event should not be included in a 7-day lookback");
});

test("forecastSpend scales linearly with a different horizon", async () => {
  const short = await forecastSpend({ lookbackDays: 7, horizonDays: 30 });
  const long = await forecastSpend({ lookbackDays: 7, horizonDays: 60 });
  assert.equal(long.projected_spend_usd, Math.round(short.avg_daily_spend_usd * 60 * 100) / 100);
});

test("getDailySpend groups by calendar day and orders ascending", async () => {
  const daily = await getDailySpend({ days: 7 });
  assert.ok(daily.length >= 3);
  for (let i = 1; i < daily.length; i++) {
    assert.ok(daily[i].day >= daily[i - 1].day, "days should be in ascending order");
  }
});

test("MIN_DAYS_FOR_FORECAST is exported and is a small positive number", async () => {
  assert.ok(MIN_DAYS_FOR_FORECAST >= 1 && MIN_DAYS_FOR_FORECAST <= 7);
});
