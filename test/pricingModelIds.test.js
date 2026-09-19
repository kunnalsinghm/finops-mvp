// test/pricingModelIds.test.js - real provider model IDs must be priced, and a
// price we can't determine must be visibly unknown, never a silent $0.
// (The original catalogue only knew placeholder names like "claude-sonnet", so
// every real request - "claude-sonnet-4-5-20250929", "gpt-4.1" - was metered
// at $0 and no dollar budget could ever trip.)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-pricingids-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-pricingids-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_pricingids_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const { computeCost, setOverride, normalizeModelId, BASELINE_CATALOGUE } = require("../server/pricing");

test.before(async () => { await storage.ready; });
test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
});

test("normalizeModelId strips date snapshots and -latest, lowercases, tolerates junk", () => {
  assert.equal(normalizeModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("gpt-4o-2024-08-06"), "gpt-4o");
  assert.equal(normalizeModelId("Claude-Opus-4-5-latest"), "claude-opus-4-5");
  assert.equal(normalizeModelId("gpt-4.1"), "gpt-4.1"); // the "4.1" is not a date
  assert.equal(normalizeModelId(null), "");
});

test("a dated snapshot of a known model is priced EXACTLY as that model (not approximate)", async () => {
  const dated = await computeCost({ provider: "anthropic", model: "claude-sonnet-4-5-20250929", input_tokens: 1000, output_tokens: 1000 });
  const plain = await computeCost({ provider: "anthropic", model: "claude-sonnet-4-5", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(dated.rate_found, true);
  assert.equal(dated.approximate, false);
  assert.equal(dated.cost_usd, plain.cost_usd);
  assert.ok(dated.cost_usd > 0, "was $0 before this fix");

  const gpt = await computeCost({ provider: "openai", model: "gpt-4o-2024-08-06", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(gpt.approximate, false);
  assert.equal(gpt.cost_usd, 0.0125);
});

test("modern real model IDs that were previously unpriced now have rates", async () => {
  for (const [provider, model] of [
    ["openai", "gpt-4.1"], ["openai", "gpt-4.1-mini"], ["openai", "o4-mini"], ["openai", "gpt-5"],
    ["anthropic", "claude-opus-4-5"], ["anthropic", "claude-haiku-4-5-20251001"], ["anthropic", "claude-sonnet-5"],
  ]) {
    const r = await computeCost({ provider, model, input_tokens: 1000, output_tokens: 1000 });
    assert.equal(r.rate_found, true, `${provider}/${model} should be priced`);
    assert.ok(r.cost_usd > 0);
  }
});

test("a longer, more specific model wins over its shorter prefix (gpt-4.1-mini is not gpt-4.1)", async () => {
  const mini = await computeCost({ provider: "openai", model: "gpt-4.1-mini", input_tokens: 1000, output_tokens: 0 });
  const full = await computeCost({ provider: "openai", model: "gpt-4.1", input_tokens: 1000, output_tokens: 0 });
  assert.ok(mini.cost_usd < full.cost_usd);
  assert.equal(mini.approximate, false);
});

test("a NEW model in a known family is priced via the family but labelled approximate", async () => {
  const r = await computeCost({ provider: "anthropic", model: "claude-sonnet-5-2", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(r.rate_found, true);
  assert.equal(r.approximate, true);
  assert.equal(r.source, "baseline-family");
  assert.equal(r.matched_family, "claude-sonnet-5");
});

test("the family fallback only matches on a '-' boundary (no accidental prefix hits)", async () => {
  // "gpt-5.6-sol" must NOT be treated as a member of the "gpt-5" family just
  // because the strings share a prefix - it has a different price, and a wrong
  // guess is worse than an honest "unknown".
  const r = await computeCost({ provider: "openai", model: "gpt-5.6-sol", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(r.rate_found, false);
  assert.equal(r.cost_usd, null);
});

test("a completely unknown model is unpriced (null), never a guessed number", async () => {
  const r = await computeCost({ provider: "anthropic", model: "totally-new-thing", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(r.rate_found, false);
  assert.equal(r.cost_usd, null);
});

test("an override beats everything, including for a dated snapshot of the overridden model", async () => {
  await setOverride({ provider: "anthropic", model: "claude-opus-4-1", input_per_1k: 0.5, output_per_1k: 1 });
  const r = await computeCost({ provider: "anthropic", model: "claude-opus-4-1-20250805", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(r.source, "override");
  assert.equal(r.cost_usd, 1.5);
});

test("an override for one exact dated snapshot outranks the family override", async () => {
  await setOverride({ provider: "openai", model: "gpt-4.1", input_per_1k: 1, output_per_1k: 1 });
  await setOverride({ provider: "openai", model: "gpt-4.1-2025-04-14", input_per_1k: 9, output_per_1k: 9 });
  const snap = await computeCost({ provider: "openai", model: "gpt-4.1-2025-04-14", input_tokens: 1000, output_tokens: 0 });
  const other = await computeCost({ provider: "openai", model: "gpt-4.1-2099-01-01", input_tokens: 1000, output_tokens: 0 });
  assert.equal(snap.cost_usd, 9);
  assert.equal(other.cost_usd, 1);
});

test("the catalogue is well-formed: every rate is a positive number and output >= input", () => {
  for (const [provider, models] of Object.entries(BASELINE_CATALOGUE)) {
    for (const [model, r] of Object.entries(models)) {
      assert.ok(r.input_per_1k > 0 && r.output_per_1k > 0, `${provider}/${model} has a non-positive rate`);
      assert.ok(r.output_per_1k >= r.input_per_1k, `${provider}/${model}: output cheaper than input is almost certainly a typo`);
    }
  }
});
