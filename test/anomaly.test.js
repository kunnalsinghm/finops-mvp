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

const {
  checkAnomaly,
  checkDailySpendAnomaly,
  checkRetryRateAnomaly,
  checkNewModelOrgWide,
  checkNewGeographyOrgWide,
  checkAllAnomalies,
  MIN_SAMPLE_SIZE,
  ANOMALY_MULTIPLIER,
  DAILY_SPEND_ANOMALY_THRESHOLD_PCT,
  RETRY_RATE_ANOMALY_THRESHOLD,
  MIN_TASKS_FOR_RETRY_RATE_CHECK,
} = require("../server/anomaly");

async function insertBaselineEvents(n, cost) {
  for (let i = 0; i < n; i++) {
    await storage.run(
      `INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, ?, ?, 1)`,
      [new Date().toISOString(), "openai", "gpt-4o", cost]
    );
  }
}

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

async function seedEvent({
  team = null,
  agent_id = null,
  task_id = null,
  task_status = null,
  provider = "openai",
  model = "gpt-4o",
  client_region = null,
  cost_usd = 0.1,
  event_time = new Date().toISOString(),
}) {
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, team, agent_id, task_id, task_status, client_region, cost_usd, tagged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [event_time, provider, model, team, agent_id, task_id, task_status, client_region, cost_usd]
  );
}

async function countAnomalyAlerts(pattern) {
  const rows = await storage.all("SELECT * FROM alerts_log WHERE type = 'anomaly'");
  return rows.filter((r) => pattern.test(r.message)).length;
}

test("checkNewModelOrgWide returns null with insufficient org-wide history (must run before anything else seeds usage_events - this check's history count is global/unscoped)", async () => {
  const result = await checkNewModelOrgWide({ provider: "openai", model: `brand-new-model-${process.pid}` });
  assert.equal(result, null);
});

test("checkNewGeographyOrgWide returns null with insufficient org-wide history (must run before anything else seeds usage_events - this check's history count is global/unscoped)", async () => {
  const result = await checkNewGeographyOrgWide({ client_region: `new-region-${process.pid}` });
  assert.equal(result, null);
});

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
  assert.equal(result.type, "cost-spike");
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

// ---- #2: daily-spend-exceeds-normal -------------------------------------

test("checkDailySpendAnomaly returns null with no team", async () => {
  const result = await checkDailySpendAnomaly({ team: null });
  assert.equal(result, null);
});

test("checkDailySpendAnomaly returns null with fewer than the minimum baseline days", async () => {
  const team = `daily-thin-${process.pid}`;
  await seedEvent({ team, cost_usd: 5, event_time: daysAgoIso(1) }); // only 1 prior day
  await seedEvent({ team, cost_usd: 50 }); // today
  const result = await checkDailySpendAnomaly({ team });
  assert.equal(result, null);
});

test("checkDailySpendAnomaly returns null when today's spend is within normal range of the baseline", async () => {
  const team = `daily-normal-${process.pid}`;
  for (const days of [1, 2, 3, 4]) await seedEvent({ team, cost_usd: 10, event_time: daysAgoIso(days) });
  await seedEvent({ team, cost_usd: 12 }); // today - close to the $10/day baseline
  const result = await checkDailySpendAnomaly({ team });
  assert.equal(result, null);
});

test("checkDailySpendAnomaly flags today's spend when it exceeds the threshold percentage of the baseline, and fires only once per day", async () => {
  const team = `daily-spike-${process.pid}`;
  for (const days of [1, 2, 3, 4]) await seedEvent({ team, cost_usd: 10, event_time: daysAgoIso(days) });
  // $10/day baseline; today is $50 -> 500%, well above the 200% threshold
  await seedEvent({ team, cost_usd: 50 });

  const first = await checkDailySpendAnomaly({ team });
  assert.ok(first, "expected a daily-spend anomaly to be flagged");
  assert.equal(first.type, "daily-spend");
  assert.ok(first.pct_of_normal > DAILY_SPEND_ANOMALY_THRESHOLD_PCT);

  // A second event pushes today's spend even higher, but the alert must not
  // refire for the same team on the same day.
  await seedEvent({ team, cost_usd: 20 });
  const second = await checkDailySpendAnomaly({ team });
  assert.equal(second, null, "must not refire for the same team on the same day");

  const alertCount = await countAnomalyAlerts(new RegExp(`Daily spend anomaly: team '${team}'`));
  assert.equal(alertCount, 1, "exactly one alerts_log row, not one per call");
});

test("checkDailySpendAnomaly returns null when there is no spend today at all", async () => {
  const team = `daily-noSpendToday-${process.pid}`;
  for (const days of [1, 2, 3]) await seedEvent({ team, cost_usd: 10, event_time: daysAgoIso(days) });
  const result = await checkDailySpendAnomaly({ team });
  assert.equal(result, null);
});

// ---- #3: retry-rate-exceeds-threshold ------------------------------------

test("checkRetryRateAnomaly returns null with no agent_id", async () => {
  const result = await checkRetryRateAnomaly({ agent_id: null });
  assert.equal(result, null);
});

test("checkRetryRateAnomaly returns null with fewer tasks than the minimum sample size", async () => {
  const agent_id = `agent-thin-${process.pid}`;
  assert.ok(MIN_TASKS_FOR_RETRY_RATE_CHECK > 2, "this test assumes the minimum is above 2");
  await seedEvent({ agent_id, task_id: "t1" });
  await seedEvent({ agent_id, task_id: "t1" }); // retried
  await seedEvent({ agent_id, task_id: "t2" });
  const result = await checkRetryRateAnomaly({ agent_id });
  assert.equal(result, null);
});

test("checkRetryRateAnomaly returns null when retry rate is at or below the threshold", async () => {
  const agent_id = `agent-normal-${process.pid}`;
  // 5 tasks, only 1 retried (20%), below the 50% threshold
  await seedEvent({ agent_id, task_id: "t1" });
  await seedEvent({ agent_id, task_id: "t1" });
  for (const t of ["t2", "t3", "t4", "t5"]) await seedEvent({ agent_id, task_id: t });
  const result = await checkRetryRateAnomaly({ agent_id });
  assert.equal(result, null);
});

test("checkRetryRateAnomaly flags a high retry rate, and fires only once per day", async () => {
  const agent_id = `agent-retrying-${process.pid}`;
  // 5 tasks, 4 retried (80%), above the 50% threshold
  for (const t of ["t1", "t2", "t3", "t4"]) {
    await seedEvent({ agent_id, task_id: t });
    await seedEvent({ agent_id, task_id: t });
  }
  await seedEvent({ agent_id, task_id: "t5" });

  const first = await checkRetryRateAnomaly({ agent_id });
  assert.ok(first, "expected a retry-rate anomaly to be flagged");
  assert.equal(first.type, "retry-rate");
  assert.ok(first.retry_rate > RETRY_RATE_ANOMALY_THRESHOLD);

  const second = await checkRetryRateAnomaly({ agent_id });
  assert.equal(second, null, "must not refire for the same agent on the same day");

  const alertCount = await countAnomalyAlerts(new RegExp(`Retry-rate anomaly: agent '${agent_id}'`));
  assert.equal(alertCount, 1);
});

// ---- #4: new-model-appears (org-wide) -------------------------------------

test("checkNewModelOrgWide returns null for a provider/model combo that's already been used", async () => {
  await insertBaselineEvents(25, 0.1); // establish org-wide history using openai/gpt-4o
  const result = await checkNewModelOrgWide({ provider: "openai", model: "gpt-4o" });
  assert.equal(result, null);
});

test("checkNewModelOrgWide flags a provider/model combo never used anywhere, once there's enough org-wide history", async () => {
  await insertBaselineEvents(25, 0.1);
  const result = await checkNewModelOrgWide({ provider: "anthropic", model: `never-before-seen-${process.pid}` });
  assert.ok(result, "expected a new-model anomaly to be flagged");
  assert.equal(result.type, "new-model");
});

// ---- #5: new-geography-begins (org-wide) ----------------------------------

test("checkNewGeographyOrgWide returns null for a region that's already been reported", async () => {
  const region = `known-region-${process.pid}`;
  for (let i = 0; i < 25; i++) await seedEvent({ client_region: region });
  const result = await checkNewGeographyOrgWide({ client_region: region });
  assert.equal(result, null);
});

test("checkNewGeographyOrgWide flags a region never reported anywhere, once there's enough org-wide history", async () => {
  for (let i = 0; i < 25; i++) await seedEvent({ client_region: `known-region-b-${process.pid}` });
  const result = await checkNewGeographyOrgWide({ client_region: `never-before-seen-region-${process.pid}` });
  assert.ok(result, "expected a new-geography anomaly to be flagged");
  assert.equal(result.type, "new-geography");
});

// ---- orchestrator ---------------------------------------------------------

test("checkAllAnomalies aggregates every check that fired, and skips a check whose required field is absent", async () => {
  const team = `orch-team-${process.pid}`;
  // Sufficient daily-spend baseline + spike for this team
  for (const days of [1, 2, 3, 4]) await seedEvent({ team, cost_usd: 10, event_time: daysAgoIso(days) });
  await seedEvent({ team, cost_usd: 80 });

  // No agent_id passed at all -> retry-rate check must be skipped, not error
  const results = await checkAllAnomalies({
    provider: "openai",
    model: "gpt-4o",
    cost_usd: 0.1,
    team,
    agent_id: null,
    client_region: null,
  });

  const types = results.map((r) => r.type);
  assert.ok(types.includes("daily-spend"), "daily-spend anomaly should be in the aggregated results");
  assert.ok(!types.includes("retry-rate"), "retry-rate must be skipped when agent_id is absent, not errored");
});

test("checkAllAnomalies returns an empty array, not an error, when nothing fires", async () => {
  const results = await checkAllAnomalies({
    provider: "openai",
    model: "gpt-4o",
    cost_usd: 0,
    team: null,
    agent_id: null,
    client_region: null,
  });
  assert.deepEqual(results, []);
});
