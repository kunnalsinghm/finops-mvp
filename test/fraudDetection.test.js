// test/fraudDetection.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-fraudDetection-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_fraudDetection_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try {
      await storage.ready;
    } catch {
      // nothing further to await if schema init itself failed
    }
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[fraudDetection.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { checkKeyFraudSignals } = require("../server/fraudDetection");

// Backdates event_time so a batch of "history" events don't all land in
// "today" - the volume-spike check explicitly excludes today's events from
// the baseline, so history needs to actually be in the past.
async function insertHistoryEvent({ key_id, provider, model, client_region, daysAgo }) {
  const eventTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, user_id, client_region, cost_usd, tagged)
     VALUES (?, ?, ?, ?, ?, 0.01, 1)`,
    [eventTime, provider, model, key_id, client_region || null]
  );
}

async function insertTodayEvent({ key_id, provider, model }) {
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, user_id, cost_usd, tagged)
     VALUES (?, ?, ?, ?, 0.01, 1)`,
    [new Date().toISOString(), provider, model, key_id]
  );
}

test("checkKeyFraudSignals returns null for a key with no history at all", async () => {
  const result = await checkKeyFraudSignals({ key_id: "key_no_history", provider: "openai", model: "gpt-4o" });
  assert.equal(result, null);
});

test("checkKeyFraudSignals flags a volume spike against an established daily baseline", async () => {
  const key = "key_volume_spike";
  // ~1 request/day for 5 distinct days = an established, low baseline
  for (let d = 1; d <= 5; d++) {
    await insertHistoryEvent({ key_id: key, provider: "openai", model: "gpt-4o", daysAgo: d });
  }
  // Today: far more than 5x the ~1/day baseline
  for (let i = 0; i < 10; i++) {
    await insertTodayEvent({ key_id: key, provider: "openai", model: "gpt-4o" });
  }
  const result = await checkKeyFraudSignals({ key_id: key, provider: "openai", model: "gpt-4o" });
  assert.ok(result, "expected a fraud signal to be flagged");
  assert.ok(result.reasons.includes("volume-spike"), `expected volume-spike in ${result.reasons}`);
});

test("checkKeyFraudSignals does not flag normal, consistent daily volume", async () => {
  const key = "key_normal_volume";
  for (let d = 1; d <= 5; d++) {
    await insertHistoryEvent({ key_id: key, provider: "openai", model: "gpt-4o", daysAgo: d });
  }
  await insertTodayEvent({ key_id: key, provider: "openai", model: "gpt-4o" });
  const result = await checkKeyFraudSignals({ key_id: key, provider: "openai", model: "gpt-4o" });
  assert.equal(result, null);
});

test("checkKeyFraudSignals flags a brand-new model/provider combo on an established key", async () => {
  const key = "key_new_model";
  for (let i = 0; i < 25; i++) {
    await insertHistoryEvent({ key_id: key, provider: "openai", model: "gpt-4o", daysAgo: 1 });
  }
  const result = await checkKeyFraudSignals({ key_id: key, provider: "anthropic", model: "claude-opus" });
  assert.ok(result, "expected a fraud signal to be flagged");
  assert.ok(result.reasons.includes("new-model-mix"), `expected new-model-mix in ${result.reasons}`);
});

test("checkKeyFraudSignals does not flag a new model on a key with too little history", async () => {
  const key = "key_low_history_new_model";
  for (let i = 0; i < 3; i++) {
    await insertHistoryEvent({ key_id: key, provider: "openai", model: "gpt-4o", daysAgo: 1 });
  }
  const result = await checkKeyFraudSignals({ key_id: key, provider: "anthropic", model: "claude-opus" });
  assert.equal(result, null);
});

test("checkKeyFraudSignals flags a first-time client region on an established key", async () => {
  const key = "key_new_region";
  for (let i = 0; i < 6; i++) {
    await insertHistoryEvent({ key_id: key, provider: "openai", model: "gpt-4o", client_region: "us-east", daysAgo: 1 });
  }
  const result = await checkKeyFraudSignals({ key_id: key, provider: "openai", model: "gpt-4o", client_region: "ap-south" });
  assert.ok(result, "expected a fraud signal to be flagged");
  assert.ok(result.reasons.includes("new-region"), `expected new-region in ${result.reasons}`);
});

test("checkKeyFraudSignals does not flag a repeat region", async () => {
  const key = "key_repeat_region";
  for (let i = 0; i < 6; i++) {
    await insertHistoryEvent({ key_id: key, provider: "openai", model: "gpt-4o", client_region: "us-east", daysAgo: 1 });
  }
  const result = await checkKeyFraudSignals({ key_id: key, provider: "openai", model: "gpt-4o", client_region: "us-east" });
  assert.equal(result, null);
});

test("checkKeyFraudSignals ignores client_region when none is provided", async () => {
  const key = "key_no_region_header";
  for (let i = 0; i < 6; i++) {
    await insertHistoryEvent({ key_id: key, provider: "openai", model: "gpt-4o", client_region: "us-east", daysAgo: 1 });
  }
  const result = await checkKeyFraudSignals({ key_id: key, provider: "openai", model: "gpt-4o" });
  assert.equal(result, null);
});
