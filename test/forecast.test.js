// test/forecast.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-forecast-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const { forecastSpend, getDailySpend, MIN_DAYS_FOR_FORECAST } = require("../server/forecast");

const insertEvent = db.prepare(`
  INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged)
  VALUES (?, 'openai', 'gpt-4o', ?, 1)
`);

function seedDay(daysAgo, cost) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  insertEvent.run(d.toISOString(), cost);
}

test("forecastSpend returns null with fewer than MIN_DAYS_FOR_FORECAST days of data", () => {
  seedDay(0, 10);
  seedDay(1, 12);
  // Only 2 distinct days - below the minimum of 3
  const result = forecastSpend({ lookbackDays: 7 });
  assert.equal(result, null);
});

test("forecastSpend computes a simple moving average once enough days exist", () => {
  // Fresh DB slate isn't practical mid-file (other tests share state), so
  // seed a distinctly-dated cluster of days here and use a short lookback
  // that only captures these.
  seedDay(2, 30); // total so far across this file: day0=10, day1=12, day2=30
  // days_with_data = 3, total = 52, avg = 52/3 = 17.333...
  const result = forecastSpend({ lookbackDays: 7, horizonDays: 30 });
  assert.ok(result, "expected a forecast once 3+ days of data exist");
  assert.equal(result.days_with_data, 3);
  assert.equal(result.avg_daily_spend_usd, Math.round((52 / 3) * 10000) / 10000);
  assert.equal(result.projected_spend_usd, Math.round((52 / 3) * 30 * 100) / 100);
  assert.equal(result.method, "simple-moving-average");
  assert.match(result.caveat, /ignores trends/i);
});

test("forecastSpend respects the lookback window - older days don't count", () => {
  seedDay(20, 999); // way outside a 7-day lookback
  const result = forecastSpend({ lookbackDays: 7, horizonDays: 30 });
  assert.ok(result);
  assert.equal(result.days_with_data, 3, "the 20-days-ago event should not be included in a 7-day lookback");
});

test("forecastSpend scales linearly with a different horizon", () => {
  const short = forecastSpend({ lookbackDays: 7, horizonDays: 30 });
  const long = forecastSpend({ lookbackDays: 7, horizonDays: 60 });
  assert.equal(long.projected_spend_usd, Math.round(short.avg_daily_spend_usd * 60 * 100) / 100);
});

test("getDailySpend groups by calendar day and orders ascending", () => {
  const daily = getDailySpend({ days: 7 });
  assert.ok(daily.length >= 3);
  for (let i = 1; i < daily.length; i++) {
    assert.ok(daily[i].day >= daily[i - 1].day, "days should be in ascending order");
  }
});

test("MIN_DAYS_FOR_FORECAST is exported and is a small positive number", () => {
  assert.ok(MIN_DAYS_FOR_FORECAST >= 1 && MIN_DAYS_FOR_FORECAST <= 7);
});
