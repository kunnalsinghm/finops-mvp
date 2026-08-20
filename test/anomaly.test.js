// test/anomaly.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-anomaly-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const { checkAnomaly, MIN_SAMPLE_SIZE, ANOMALY_MULTIPLIER } = require("../server/anomaly");

function insertBaselineEvents(n, cost) {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, ?, ?, 1)`
    ).run(new Date().toISOString(), "openai", "gpt-4o", cost);
  }
}

test("checkAnomaly returns null when sample size is too small", () => {
  insertBaselineEvents(3, 0.1);
  const result = checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 5.0, team: "x" });
  assert.equal(result, null);
});

test("checkAnomaly flags a cost far above the established baseline", () => {
  insertBaselineEvents(MIN_SAMPLE_SIZE, 0.1);
  const result = checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 0.1 * ANOMALY_MULTIPLIER * 2, team: "x" });
  assert.ok(result, "expected an anomaly to be flagged");
  assert.equal(result.flagged, true);
  assert.match(result.message, /anomaly/i);
});

test("checkAnomaly does not flag cost within normal range of baseline", () => {
  insertBaselineEvents(MIN_SAMPLE_SIZE, 0.1);
  const result = checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 0.15, team: "x" });
  assert.equal(result, null);
});

test("checkAnomaly ignores zero-cost events", () => {
  const result = checkAnomaly({ provider: "openai", model: "gpt-4o", cost_usd: 0, team: "x" });
  assert.equal(result, null);
});