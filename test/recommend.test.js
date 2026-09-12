// test/recommend.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-recommend-*.db* files from a PREVIOUS run of
// this file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-recommend-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-recommend-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_recommend_${process.pid}`;
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
      console.warn(`[recommend.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { getModelSwitchRecommendations, getCachingOpportunities } = require("../server/recommend");
const { runShadowTest } = require("../server/shadowTest");

// Now async and awaited at every call site (including inside loops) - a
// synchronous fire-and-forget insert here would race the subsequent read
// on Postgres (no such race existed against SQLite's synchronous driver,
// which is why this pattern was never a problem before).
async function insertEvent({ provider, model, input_tokens, output_tokens, cost_usd, daysAgo = 0 }) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, input_tokens, output_tokens, cost_usd, tagged)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [d.toISOString(), provider, model, input_tokens, output_tokens, cost_usd]
  );
}

test("getModelSwitchRecommendations suggests a cheaper alternative when spend is significant", async () => {
  for (let i = 0; i < 20; i++) {
    await insertEvent({ provider: "openai", model: "gpt-4o", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5 });
  }
  const recs = await getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.provider === "openai" && r.current.model === "gpt-4o");
  assert.ok(rec, "expected a recommendation for openai/gpt-4o");
  assert.equal(rec.suggested.model, "gpt-4o-mini");
  assert.ok(rec.estimated_savings_usd > 0);
  assert.match(rec.caveat, /quality/i);
});

test("getModelSwitchRecommendations skips trivial spend (< $1 total)", async () => {
  await insertEvent({ provider: "anthropic", model: "claude-opus", input_tokens: 100, output_tokens: 50, cost_usd: 0.05 });
  const recs = await getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.model === "claude-opus");
  assert.equal(rec, undefined);
});

test("getModelSwitchRecommendations ignores events outside the day window", async () => {
  for (let i = 0; i < 20; i++) {
    await insertEvent({ provider: "anthropic", model: "claude-sonnet", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5, daysAgo: 90 });
  }
  const recs = await getModelSwitchRecommendations({ days: 7 });
  const rec = recs.find((r) => r.current.model === "claude-sonnet");
  assert.equal(rec, undefined);
});

test("getCachingOpportunities flags low-variance repeated call patterns", async () => {
  for (let i = 0; i < 25; i++) {
    await insertEvent({ provider: "openai", model: "gpt-4o-mini", input_tokens: 500, output_tokens: 100, cost_usd: 0.01 });
  }
  const opportunities = await getCachingOpportunities({ days: 30 });
  const found = opportunities.find((o) => o.provider === "openai" && o.model === "gpt-4o-mini");
  assert.ok(found, "expected a caching opportunity to be flagged for near-identical repeated calls");
});

test("getCachingOpportunities does not flag low-volume usage", async () => {
  for (let i = 0; i < 5; i++) {
    await insertEvent({ provider: "bedrock", model: "titan-text-express", input_tokens: 500, output_tokens: 100, cost_usd: 0.01 });
  }
  const opportunities = await getCachingOpportunities({ days: 30 });
  const found = opportunities.find((o) => o.model === "titan-text-express");
  assert.equal(found, undefined);
});

test("getModelSwitchRecommendations upgrades confidence to shadow-tested-similar once enough high-similarity shadow samples exist", async (t) => {
  for (let i = 0; i < 20; i++) {
    await insertEvent({ provider: "anthropic", model: "claude-opus", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5 });
  }

  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "the same answer every time" }], usage: { input_tokens: 50, output_tokens: 20 } }),
  }));

  for (let i = 0; i < 6; i++) {
    await runShadowTest({
      providerName: "anthropic",
      primaryModel: "claude-opus",
      primaryRequestBody: { model: "claude-opus", messages: [] },
      primaryResponseJson: { content: [{ type: "text", text: "the same answer every time" }] },
      primaryCostUsd: 0.5,
      providerKey: "sk-ant-test",
      team: "eng",
      endpoint: { url: "https://x.test", authHeader: () => ({}), extractUsage: () => ({ input_tokens: 50, output_tokens: 20 }) },
      sampleRate: 1.0,
    });
  }

  const recs = await getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.model === "claude-opus");
  assert.ok(rec, "expected a recommendation for claude-opus");
  assert.equal(rec.confidence, "shadow-tested-similar");
  assert.match(rec.caveat, /Shadow-tested on \d+ real requests/);
  assert.ok(rec.shadow_test);
  assert.ok(rec.shadow_test.avg_similarity > 0.8);
});

test("getModelSwitchRecommendations flags shadow-tested-diverges when shadow-tested outputs don't match well", async (t) => {
  for (let i = 0; i < 20; i++) {
    await insertEvent({ provider: "anthropic", model: "claude-sonnet", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5 });
  }

  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "completely different unrelated topic about weather patterns" }], usage: { input_tokens: 50, output_tokens: 20 } }),
  }));

  for (let i = 0; i < 6; i++) {
    await runShadowTest({
      providerName: "anthropic",
      primaryModel: "claude-sonnet",
      primaryRequestBody: { model: "claude-sonnet", messages: [] },
      primaryResponseJson: { content: [{ type: "text", text: "the quarterly financial report has been finalized" }] },
      primaryCostUsd: 0.5,
      providerKey: "sk-ant-test",
      team: "eng",
      endpoint: { url: "https://x.test", authHeader: () => ({}), extractUsage: () => ({ input_tokens: 50, output_tokens: 20 }) },
      sampleRate: 1.0,
    });
  }

  const recs = await getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.model === "claude-sonnet");
  assert.ok(rec, "expected a recommendation for claude-sonnet");
  assert.equal(rec.confidence, "shadow-tested-diverges");
  assert.match(rec.caveat, /NOT recommended/);
});
