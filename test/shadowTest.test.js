// test/shadowTest.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-shadowTest-*.db* files from a PREVIOUS run of
// this file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-shadowTest-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-shadowTest-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_shadowtest_${process.pid}`;
}

let db;
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
      console.warn(`[shadowTest.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

db = require("../server/db");
const {
  runShadowTest,
  getShadowStatsForPair,
  getShadowTestSummary,
  getShadowComparisons,
  extractResponseText,
} = require("../server/shadowTest");

const fakeOpenAIEndpoint = {
  url: "https://api.openai.test/v1/chat/completions",
  authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  extractUsage: (json) => ({
    input_tokens: json?.usage?.prompt_tokens || 0,
    output_tokens: json?.usage?.completion_tokens || 0,
  }),
};

const fakeAnthropicEndpoint = {
  url: "https://api.anthropic.test/v1/messages",
  authHeader: (key) => ({ "x-api-key": key }),
  extractUsage: (json) => ({
    input_tokens: json?.usage?.input_tokens || 0,
    output_tokens: json?.usage?.output_tokens || 0,
  }),
};

function primaryOpenAIResponse(text) {
  return { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 50, completion_tokens: 20 } };
}

function primaryAnthropicResponse(text) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 50, output_tokens: 20 } };
}

test("extractResponseText reads OpenAI chat completion shape", () => {
  const text = extractResponseText("openai", primaryOpenAIResponse("hello there"));
  assert.equal(text, "hello there");
});

test("extractResponseText reads Anthropic messages shape", () => {
  const text = extractResponseText("anthropic", primaryAnthropicResponse("hi friend"));
  assert.equal(text, "hi friend");
});

test("extractResponseText returns empty string for an unrecognized provider", () => {
  assert.equal(extractResponseText("bedrock", {}), "");
});

test("runShadowTest is a no-op when the model has no known cheaper alternative", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  });

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o-mini", // already the cheap option - no alternative defined
    primaryRequestBody: { model: "gpt-4o-mini", messages: [] },
    primaryResponseJson: primaryOpenAIResponse("x"),
    primaryCostUsd: 0.01,
    providerKey: "sk-test",
    team: "eng",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
  });

  assert.equal(fetchCalled, false, "should never call fetch when there's no cheaper alternative to test");
});

test("runShadowTest respects sampleRate=0 (always sampled out)", async (t) => {
  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  });

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    primaryResponseJson: primaryOpenAIResponse("primary answer text"),
    primaryCostUsd: 0.05,
    providerKey: "sk-test",
    team: "eng",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 0,
  });

  assert.equal(fetchCalled, false, "sampleRate=0 should never trigger the shadow call");
});

test("runShadowTest records a successful comparison with similarity and real cost", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    assert.equal(url, fakeOpenAIEndpoint.url);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "gpt-4o-mini", "shadow call should target the cheaper alternative model");
    return { ok: true, json: async () => primaryOpenAIResponse("primary answer text here") };
  });

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    primaryResponseJson: primaryOpenAIResponse("primary answer text here"),
    primaryCostUsd: 0.05,
    providerKey: "sk-test",
    team: "eng",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
  });

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.provider === "openai" && r.primary_model === "gpt-4o" && r.team === "eng");
  assert.ok(row, "expected a shadow_comparisons row to be inserted");
  assert.equal(row.shadow_model, "gpt-4o-mini");
  assert.equal(row.shadow_error, null);
  assert.equal(row.similarity, 1, "identical text on both sides should score similarity 1");
  assert.ok(row.shadow_cost_usd >= 0);
});

test("runShadowTest records a lower similarity score when outputs differ", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => primaryOpenAIResponse("something totally unrelated about giraffes"),
  }));

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    primaryResponseJson: primaryOpenAIResponse("the quarterly revenue figures are attached"),
    primaryCostUsd: 0.05,
    providerKey: "sk-test",
    team: "finance",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
  });

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.team === "finance");
  assert.ok(row);
  assert.ok(row.similarity < 0.5, "unrelated text should score low similarity");
});

test("runShadowTest records shadow_error on an upstream HTTP error, without throwing", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: "rate limited" } }),
  }));

  await assert.doesNotReject(
    runShadowTest({
      providerName: "anthropic",
      primaryModel: "claude-opus",
      primaryRequestBody: { model: "claude-opus", messages: [] },
      primaryResponseJson: primaryAnthropicResponse("ok"),
      primaryCostUsd: 0.1,
      providerKey: "sk-ant-test",
      team: "eng",
      endpoint: fakeAnthropicEndpoint,
      sampleRate: 1.0,
    })
  );

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.provider === "anthropic" && r.primary_model === "claude-opus");
  assert.ok(row);
  assert.match(row.shadow_error, /429/);
  assert.equal(row.shadow_cost_usd, null);
});

test("runShadowTest records shadow_error on a network exception, without throwing", async (t) => {
  t.mock.method(global, "fetch", async () => {
    throw new Error("socket hang up");
  });

  await assert.doesNotReject(
    runShadowTest({
      providerName: "anthropic",
      primaryModel: "claude-sonnet",
      primaryRequestBody: { model: "claude-sonnet", messages: [] },
      primaryResponseJson: primaryAnthropicResponse("ok"),
      primaryCostUsd: 0.02,
      providerKey: "sk-ant-test",
      team: "eng",
      endpoint: fakeAnthropicEndpoint,
      sampleRate: 1.0,
    })
  );

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.provider === "anthropic" && r.primary_model === "claude-sonnet");
  assert.ok(row);
  assert.match(row.shadow_error, /socket hang up/);
});

test("getShadowStatsForPair aggregates only successful rows for a specific pair", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => primaryAnthropicResponse("the report is ready for review today"),
  }));

  for (let i = 0; i < 6; i++) {
    await runShadowTest({
      providerName: "anthropic",
      primaryModel: "claude-sonnet",
      primaryRequestBody: { model: "claude-sonnet", messages: [] },
      primaryResponseJson: primaryAnthropicResponse("the report is ready for review today"),
      primaryCostUsd: 0.03,
      providerKey: "sk-ant-test",
      team: "stats-pair-test",
      endpoint: fakeAnthropicEndpoint,
      sampleRate: 1.0,
    });
  }

  // Note: an earlier test in this file already recorded one FAILED
  // (shadow_error) row for this same anthropic/claude-sonnet pair - that
  // row must be excluded from these averages, which is exactly what this
  // assertion also verifies.
  const stats = await getShadowStatsForPair("anthropic", "claude-sonnet", "claude-haiku");
  assert.ok(stats.sample_count >= 7, "expected the 6 new rows plus the earlier errored row");
  assert.ok(stats.successful_count >= 6);
  assert.ok(stats.avg_similarity > 0.9, "identical repeated text should average near-1.0 similarity");
});

test("getShadowTestSummary groups by provider/primary/shadow model", async () => {
  const summary = await getShadowTestSummary({ days: 365 });
  const pair = summary.find((s) => s.provider === "openai" && s.primary_model === "gpt-4o" && s.shadow_model === "gpt-4o-mini");
  assert.ok(pair, "expected a summary row for openai gpt-4o -> gpt-4o-mini");
  assert.ok(pair.sample_count > 0);
});
