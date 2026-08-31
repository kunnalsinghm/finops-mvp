// test/pricing.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-pricing-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const db = require("../server/db");

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { computeCost, setOverride, getRate } = require("../server/pricing");

test("computeCost returns correct cost for a known baseline model", () => {
  const result = computeCost({ provider: "anthropic", model: "claude-sonnet", input_tokens: 1000, output_tokens: 500 });
  assert.equal(result.rate_found, true);
  assert.equal(result.cost_usd, 0.0105);
});

test("computeCost returns rate_found:false for an unknown model", () => {
  const result = computeCost({ provider: "openai", model: "totally-made-up-model", input_tokens: 100, output_tokens: 50 });
  assert.equal(result.rate_found, false);
  assert.equal(result.cost_usd, null);
});

test("setOverride takes priority over the baseline catalogue", () => {
  setOverride({ provider: "openai", model: "gpt-4o", input_per_1k: 1, output_per_1k: 2 });
  const rate = getRate("openai", "gpt-4o");
  assert.equal(rate.source, "override");
  assert.equal(rate.input_per_1k, 1);

  const result = computeCost({ provider: "openai", model: "gpt-4o", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(result.cost_usd, 3);
});

test("computeCost handles zero tokens without error", () => {
  const result = computeCost({ provider: "anthropic", model: "claude-haiku", input_tokens: 0, output_tokens: 0 });
  assert.equal(result.cost_usd, 0);
});
