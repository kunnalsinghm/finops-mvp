// test/recommend.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-recommend-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const { getModelSwitchRecommendations, getCachingOpportunities } = require("../server/recommend");
const { runShadowTest } = require("../server/shadowTest");

function insertEvent({ provider, model, input_tokens, output_tokens, cost_usd, daysAgo = 0 }) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  db.prepare(
    `INSERT INTO usage_events (event_time, provider, model, input_tokens, output_tokens, cost_usd, tagged)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  ).run(d.toISOString(), provider, model, input_tokens, output_tokens, cost_usd);
}

test("getModelSwitchRecommendations suggests a cheaper alternative when spend is significant", () => {
  for (let i = 0; i < 20; i++) {
    insertEvent({ provider: "openai", model: "gpt-4o", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5 });
  }
  const recs = getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.provider === "openai" && r.current.model === "gpt-4o");
  assert.ok(rec, "expected a recommendation for openai/gpt-4o");
  assert.equal(rec.suggested.model, "gpt-4o-mini");
  assert.ok(rec.estimated_savings_usd > 0);
  assert.match(rec.caveat, /quality/i);
});

test("getModelSwitchRecommendations skips trivial spend (< $1 total)", () => {
  insertEvent({ provider: "anthropic", model: "claude-opus", input_tokens: 100, output_tokens: 50, cost_usd: 0.05 });
  const recs = getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.model === "claude-opus");
  assert.equal(rec, undefined);
});

test("getModelSwitchRecommendations ignores events outside the day window", () => {
  for (let i = 0; i < 20; i++) {
    insertEvent({ provider: "anthropic", model: "claude-sonnet", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5, daysAgo: 90 });
  }
  const recs = getModelSwitchRecommendations({ days: 7 });
  const rec = recs.find((r) => r.current.model === "claude-sonnet");
  assert.equal(rec, undefined);
});

test("getCachingOpportunities flags low-variance repeated call patterns", () => {
  for (let i = 0; i < 25; i++) {
    insertEvent({ provider: "openai", model: "gpt-4o-mini", input_tokens: 500, output_tokens: 100, cost_usd: 0.01 });
  }
  const opportunities = getCachingOpportunities({ days: 30 });
  const found = opportunities.find((o) => o.provider === "openai" && o.model === "gpt-4o-mini");
  assert.ok(found, "expected a caching opportunity to be flagged for near-identical repeated calls");
});

test("getCachingOpportunities does not flag low-volume usage", () => {
  for (let i = 0; i < 5; i++) {
    insertEvent({ provider: "bedrock", model: "titan-text-express", input_tokens: 500, output_tokens: 100, cost_usd: 0.01 });
  }
  const opportunities = getCachingOpportunities({ days: 30 });
  const found = opportunities.find((o) => o.model === "titan-text-express");
  assert.equal(found, undefined);
});

test("getModelSwitchRecommendations upgrades confidence to shadow-tested-similar once enough high-similarity shadow samples exist", async (t) => {
  for (let i = 0; i < 20; i++) {
    insertEvent({ provider: "anthropic", model: "claude-opus", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5 });
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

  const recs = getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.model === "claude-opus");
  assert.ok(rec, "expected a recommendation for claude-opus");
  assert.equal(rec.confidence, "shadow-tested-similar");
  assert.match(rec.caveat, /Shadow-tested on \d+ real requests/);
  assert.ok(rec.shadow_test);
  assert.ok(rec.shadow_test.avg_similarity > 0.8);
});

test("getModelSwitchRecommendations flags shadow-tested-diverges when shadow-tested outputs don't match well", async (t) => {
  for (let i = 0; i < 20; i++) {
    insertEvent({ provider: "anthropic", model: "claude-sonnet", input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5 });
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

  const recs = getModelSwitchRecommendations({ days: 30 });
  const rec = recs.find((r) => r.current.model === "claude-sonnet");
  assert.ok(rec, "expected a recommendation for claude-sonnet");
  assert.equal(rec.confidence, "shadow-tested-diverges");
  assert.match(rec.caveat, /NOT recommended/);
});
