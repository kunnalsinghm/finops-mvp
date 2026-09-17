// test/pricing.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-pricing-*.db* files from a PREVIOUS run of this
// file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-pricing-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-pricing-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_pricing_${process.pid}`;
}

const db = require("../server/db");
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
      console.warn(`[pricing.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { computeCost, setOverride, getRate } = require("../server/pricing");

test("computeCost returns correct cost for a known baseline model", async () => {
  const result = await computeCost({ provider: "anthropic", model: "claude-sonnet", input_tokens: 1000, output_tokens: 500 });
  assert.equal(result.rate_found, true);
  assert.equal(result.cost_usd, 0.0105);
});

test("computeCost returns rate_found:false for an unknown model", async () => {
  const result = await computeCost({ provider: "openai", model: "totally-made-up-model", input_tokens: 100, output_tokens: 50 });
  assert.equal(result.rate_found, false);
  assert.equal(result.cost_usd, null);
});

test("setOverride takes priority over the baseline catalogue", async () => {
  await setOverride({ provider: "openai", model: "gpt-4o", input_per_1k: 1, output_per_1k: 2 });
  const rate = await getRate("openai", "gpt-4o");
  assert.equal(rate.source, "override");
  assert.equal(rate.input_per_1k, 1);

  const result = await computeCost({ provider: "openai", model: "gpt-4o", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(result.cost_usd, 3);
});

test("computeCost handles zero tokens without error", async () => {
  const result = await computeCost({ provider: "anthropic", model: "claude-haiku", input_tokens: 0, output_tokens: 0 });
  assert.equal(result.cost_usd, 0);
});
