// test/reconcile.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-reconcile-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
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
  db.prepare(
    `INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, ?, ?, 1)`
  ).run("2026-04-01T10:00:00Z", "openai", "gpt-4o", 10.0);
  await importCsv("date,provider,cost\n2026-04-01,openai,10.00");
  const report = await getReconciliationReport({ thresholdPct: 10 });
  const row = report.find((r) => r.day === "2026-04-01");
  assert.equal(row.flagged, false);
});
