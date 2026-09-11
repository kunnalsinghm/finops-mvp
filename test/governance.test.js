// test/governance.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-governance-*.db* files from a PREVIOUS run of
// this file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-governance-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-governance-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_governance_${process.pid}`;
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
      console.warn(`[governance.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const {
  checkRateLimit,
  isQuarantined,
  checkQuarantineAllowance,
  quarantineKey,
  approveKey,
  getFallback,
} = require("../server/governance");

test("checkRateLimit allows requests within capacity", () => {
  const result = checkRateLimit("test-key-1", { capacity: 5, refillPerSec: 1 });
  assert.equal(result.allowed, true);
});

test("checkRateLimit blocks once capacity is exhausted", () => {
  const limit = { capacity: 3, refillPerSec: 0 };
  for (let i = 0; i < 3; i++) {
    const r = checkRateLimit("test-key-2", limit);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = checkRateLimit("test-key-2", limit);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);
});

test("quarantineKey marks a key quarantined and isQuarantined reflects it", async () => {
  await storage.run("INSERT INTO api_keys (key_id, label, role) VALUES (?, ?, ?)", ["qk_1", "test", "developer"]);
  assert.equal(await isQuarantined("qk_1"), false);
  await quarantineKey("qk_1", "suspicious activity");
  assert.equal(await isQuarantined("qk_1"), true);
});

test("approveKey lifts quarantine status", async () => {
  await storage.run("INSERT INTO api_keys (key_id, label, role) VALUES (?, ?, ?)", ["qk_2", "test2", "developer"]);
  await quarantineKey("qk_2", "test");
  assert.equal(await isQuarantined("qk_2"), true);
  await approveKey("qk_2");
  assert.equal(await isQuarantined("qk_2"), false);
});

test("checkQuarantineAllowance permits first request then blocks within 60s window", () => {
  const first = checkQuarantineAllowance("qk_3");
  assert.equal(first.allowed, true);
  const second = checkQuarantineAllowance("qk_3");
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterSec > 0 && second.retryAfterSec <= 60);
});

test("getFallback returns a cheaper model for known expensive models", () => {
  const fallback = getFallback("openai", "gpt-4o");
  assert.deepEqual(fallback, { provider: "openai", model: "gpt-4o-mini" });
});

test("getFallback returns null for a model with no defined fallback", () => {
  const fallback = getFallback("openai", "some-unmapped-model");
  assert.equal(fallback, null);
});
