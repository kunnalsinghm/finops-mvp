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

// ---- A8: streaming shadow tests, LLM-as-judge, flagged_test_cases ----

const { callLlmJudge } = require("../server/shadowTest");
const { listFlaggedTestCases } = require("../server/flaggedTestCases");

function sseBody(lines) {
  const text = lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      yield encoder.encode(text);
    },
  };
}

function openaiStreamChunks(text, { prompt_tokens = 10, completion_tokens = 5 } = {}) {
  const chunks = text.split(" ").map((word, i) => ({ choices: [{ delta: { content: (i > 0 ? " " : "") + word } }] }));
  chunks.push({ choices: [{ delta: {} }], usage: { prompt_tokens, completion_tokens } });
  return chunks;
}

function anthropicStreamChunks(text, { input_tokens = 10, output_tokens = 5 } = {}) {
  return [
    { type: "message_start", message: { usage: { input_tokens } } },
    ...text.split(" ").map((word, i) => ({ type: "content_block_delta", delta: { text: (i > 0 ? " " : "") + word } })),
    { type: "message_delta", usage: { output_tokens } },
  ];
}

test("runShadowTest (streamed): makes a streaming shadow call and compares reassembled text against primaryResponseText", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    assert.equal(url, fakeOpenAIEndpoint.url);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "gpt-4o-mini");
    assert.equal(body.stream, true, "the shadow call must ALSO be a streaming request when the primary was");
    assert.deepEqual(body.stream_options, { include_usage: true });
    return { ok: true, body: sseBody(openaiStreamChunks("primary answer text here")) };
  });

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true },
    primaryResponseText: "primary answer text here",
    primaryCostUsd: 0.05,
    providerKey: "sk-test",
    team: "streaming-test",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
    streamed: true,
  });

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.team === "streaming-test");
  assert.ok(row, "expected a shadow_comparisons row from the streaming path");
  assert.equal(Number(row.streamed), 1);
  assert.equal(row.shadow_error, null);
  assert.equal(row.similarity, 1, "identical reassembled text on both sides should score similarity 1");
  assert.ok(row.shadow_cost_usd >= 0);
});

test("runShadowTest (streamed): Anthropic content_block_delta reassembly also works, and a differing shadow scores lower similarity", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    body: sseBody(anthropicStreamChunks("something totally unrelated about giraffes")),
  }));

  await runShadowTest({
    providerName: "anthropic",
    primaryModel: "claude-opus",
    primaryRequestBody: { model: "claude-opus", messages: [], stream: true },
    primaryResponseText: "the quarterly revenue figures are attached",
    primaryCostUsd: 0.1,
    providerKey: "sk-ant-test",
    team: "streaming-anthropic-test",
    endpoint: fakeAnthropicEndpoint,
    sampleRate: 1.0,
    streamed: true,
  });

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.team === "streaming-anthropic-test");
  assert.ok(row);
  assert.equal(Number(row.streamed), 1);
  assert.ok(row.similarity < 0.5);
});

test("runShadowTest (streamed): an HTTP error on the streaming shadow call is recorded as shadow_error, not thrown", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: false,
    status: 503,
    body: null,
    json: async () => ({ error: { message: "overloaded" } }),
  }));

  await assert.doesNotReject(
    runShadowTest({
      providerName: "openai",
      primaryModel: "gpt-4o",
      primaryRequestBody: { model: "gpt-4o", messages: [], stream: true },
      primaryResponseText: "ok",
      primaryCostUsd: 0.02,
      providerKey: "sk-test",
      team: "streaming-error-test",
      endpoint: fakeOpenAIEndpoint,
      sampleRate: 1.0,
      streamed: true,
    })
  );

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.team === "streaming-error-test");
  assert.ok(row);
  assert.match(row.shadow_error, /503/);
});

test("the non-streaming path is unaffected by A8 - streamed defaults to false and the column records 0", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, json: async () => primaryOpenAIResponse("same text") }));

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [] },
    primaryResponseJson: primaryOpenAIResponse("same text"),
    primaryCostUsd: 0.01,
    providerKey: "sk-test",
    team: "non-streaming-unaffected-test",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
  });

  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.team === "non-streaming-unaffected-test");
  assert.ok(row);
  assert.equal(Number(row.streamed), 0);
  assert.equal(row.judge_score, null, "no FINOPS_SHADOW_JUDGE_MODEL configured for this call - judge_score must stay null");
});

// ---- LLM-as-judge ----

test("callLlmJudge parses a plain numeric score out of the judge model's reply", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "gpt-4o");
    assert.match(body.messages[0].content, /RESPONSE A:/);
    return { ok: true, json: async () => primaryOpenAIResponse("0.85") };
  });

  const score = await callLlmJudge({
    providerName: "openai",
    endpoint: fakeOpenAIEndpoint,
    providerKey: "sk-test",
    judgeModel: "gpt-4o",
    primaryText: "the answer is 42",
    shadowText: "42 is the answer",
  });
  assert.equal(score, 0.85);
});

test("callLlmJudge returns null (never throws) on an unparseable reply, an HTTP error, or a network exception", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, json: async () => primaryOpenAIResponse("I cannot determine this.") }));
  assert.equal(
    await callLlmJudge({ providerName: "openai", endpoint: fakeOpenAIEndpoint, providerKey: "k", judgeModel: "gpt-4o", primaryText: "a", shadowText: "b" }),
    null
  );

  t.mock.method(global, "fetch", async () => ({ ok: false, status: 500, json: async () => null }));
  assert.equal(
    await callLlmJudge({ providerName: "openai", endpoint: fakeOpenAIEndpoint, providerKey: "k", judgeModel: "gpt-4o", primaryText: "a", shadowText: "b" }),
    null
  );

  t.mock.method(global, "fetch", async () => { throw new Error("boom"); });
  assert.equal(
    await callLlmJudge({ providerName: "openai", endpoint: fakeOpenAIEndpoint, providerKey: "k", judgeModel: "gpt-4o", primaryText: "a", shadowText: "b" }),
    null
  );
});

test("runShadowTest calls the judge and stores judge_score ADDITIVELY alongside the always-on lexical similarity, only when a judge model is configured", async (t) => {
  let call = 0;
  t.mock.method(global, "fetch", async (url, opts) => {
    call++;
    const body = JSON.parse(opts.body);
    if (body.model === "gpt-4o-mini") {
      // the shadow model call itself
      return { ok: true, json: async () => primaryOpenAIResponse("a reasonably similar answer") };
    }
    // the judge call
    assert.equal(body.model, "gpt-4o-judge");
    return { ok: true, json: async () => primaryOpenAIResponse("0.72") };
  });

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [] },
    primaryResponseJson: primaryOpenAIResponse("a similar answer indeed"),
    primaryCostUsd: 0.01,
    providerKey: "sk-test",
    team: "judge-test",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
    judgeModel: "gpt-4o-judge",
  });

  assert.equal(call, 2, "expected exactly two fetch calls: the shadow model, then the judge");
  const rows = await getShadowComparisons({ limit: 10 });
  const row = rows.find((r) => r.team === "judge-test");
  assert.ok(row);
  assert.ok(row.similarity !== null, "the lexical similarity score must still be computed");
  assert.equal(row.judge_score, 0.72);
});

test("runShadowTest does NOT call the judge when FINOPS_SHADOW_JUDGE_MODEL / judgeModel is not set (default off)", async (t) => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => primaryOpenAIResponse("same") };
  });

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [] },
    primaryResponseJson: primaryOpenAIResponse("same"),
    primaryCostUsd: 0.01,
    providerKey: "sk-test",
    team: "no-judge-test",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
  });

  assert.equal(calls, 1, "only the shadow model call should happen - no judge call by default");
});

// ---- flagged_test_cases capture ----

test("runShadowTest captures a flagged test case when similarity falls below FLAG_SIMILARITY_BELOW", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => primaryOpenAIResponse("completely unrelated giraffe zoo elephant content"),
  }));

  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [{ role: "user", content: "what were Q3 revenues" }] },
    primaryResponseJson: primaryOpenAIResponse("quarterly revenue figures attached for review"),
    primaryCostUsd: 0.01,
    providerKey: "sk-test",
    team: "flag-capture-test",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
  });

  const flagged = await listFlaggedTestCases({ source: "shadow-low-similarity" });
  const entry = flagged.find((f) => f.model === "gpt-4o" && f.reason.includes("gpt-4o-mini"));
  assert.ok(entry, "expected a flagged_test_cases row for the low-similarity shadow comparison");
  assert.equal(entry.source, "shadow-low-similarity");
  assert.equal(entry.provider, "openai");
});

test("runShadowTest does NOT capture a flagged test case when similarity is high", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, json: async () => primaryOpenAIResponse("identical text") }));

  const before = (await listFlaggedTestCases({ source: "shadow-low-similarity" })).length;
  await runShadowTest({
    providerName: "openai",
    primaryModel: "gpt-4o",
    primaryRequestBody: { model: "gpt-4o", messages: [] },
    primaryResponseJson: primaryOpenAIResponse("identical text"),
    primaryCostUsd: 0.01,
    providerKey: "sk-test",
    team: "no-flag-test",
    endpoint: fakeOpenAIEndpoint,
    sampleRate: 1.0,
  });
  const after = (await listFlaggedTestCases({ source: "shadow-low-similarity" })).length;
  assert.equal(after, before, "a high-similarity comparison must not add a flagged test case");
});
