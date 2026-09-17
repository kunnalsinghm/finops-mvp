// test/tokenQuota.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-tokenQuota-*.db* files from a PREVIOUS run of
// this file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-tokenQuota-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-tokenQuota-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_tokenquota_${process.pid}`;
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
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[tokenQuota.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { checkTokenQuota, addQuota, removeQuota, listQuotas } = require("../server/tokenQuota");

// Now async and awaited at every call site - a synchronous fire-and-forget
// insert here would race checkTokenQuota's read on Postgres (no such race
// existed against SQLite's synchronous driver, which is why this bug never
// surfaced until testing against a real Postgres backend).
async function seedTokens({ team, keyId, inputTokens, outputTokens, daysAgo = 0 }) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, team, user_id, input_tokens, output_tokens, cost_usd, tagged)
     VALUES (?, 'openai', 'gpt-4o', ?, ?, ?, ?, 0.01, 1)`,
    [d.toISOString(), team || null, keyId || null, inputTokens, outputTokens]
  );
}

test("checkTokenQuota is unrestricted when neither key nor team has any quota rows", async () => {
  const result = await checkTokenQuota({ keyId: "fk_nobody", team: "no-team" });
  assert.equal(result.allowed, true);
  assert.equal(result.scope, null);
});

test("checkTokenQuota enforces a team-level daily quota", async () => {
  await addQuota({ scope_type: "team", scope_value: "eng-daily", period: "daily", token_limit: 1000 });

  const underLimit = await checkTokenQuota({ keyId: "fk_x", team: "eng-daily" });
  assert.equal(underLimit.allowed, true);

  await seedTokens({ team: "eng-daily", inputTokens: 600, outputTokens: 500 }); // 1100 total, over 1000

  const overLimit = await checkTokenQuota({ keyId: "fk_x", team: "eng-daily" });
  assert.equal(overLimit.allowed, false);
  assert.equal(overLimit.scope, "team");
  assert.equal(overLimit.violations[0].period, "daily");
  assert.equal(overLimit.violations[0].used, 1100);
});

test("checkTokenQuota: key-level quota takes precedence over team-level quota", async () => {
  await addQuota({ scope_type: "team", scope_value: "precedence-team", period: "daily", token_limit: 100000 });
  await addQuota({ scope_type: "key", scope_value: "fk_restricted", period: "daily", token_limit: 500 });

  await seedTokens({ team: "precedence-team", keyId: "fk_restricted", inputTokens: 300, outputTokens: 300 }); // 600 total

  // This key's own limit (500) is exceeded, even though its team's limit
  // (100000) is nowhere close - key-level must win entirely.
  const result = await checkTokenQuota({ keyId: "fk_restricted", team: "precedence-team" });
  assert.equal(result.allowed, false);
  assert.equal(result.scope, "key");
});

test("checkTokenQuota: a different key on the same team is unaffected by another key's quota", async () => {
  const otherKey = await checkTokenQuota({ keyId: "fk_other_on_team", team: "precedence-team" });
  assert.equal(otherKey.allowed, true);
  assert.equal(otherKey.scope, "team");
});

test("checkTokenQuota: a key/team can have both daily and weekly quotas, and either can trigger a block", async () => {
  await addQuota({ scope_type: "team", scope_value: "dual-period", period: "daily", token_limit: 50000 });
  await addQuota({ scope_type: "team", scope_value: "dual-period", period: "weekly", token_limit: 100 });

  await seedTokens({ team: "dual-period", inputTokens: 60, outputTokens: 60 }); // 120 total - under daily, over weekly

  const result = await checkTokenQuota({ keyId: "fk_y", team: "dual-period" });
  assert.equal(result.allowed, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].period, "weekly");
});

test("checkTokenQuota: only counts events within the period window", async () => {
  await addQuota({ scope_type: "team", scope_value: "old-events-team", period: "daily", token_limit: 100 });
  await seedTokens({ team: "old-events-team", inputTokens: 500, outputTokens: 500, daysAgo: 10 }); // way over limit, but 10 days ago

  const result = await checkTokenQuota({ keyId: "fk_z", team: "old-events-team" });
  assert.equal(result.allowed, true, "events from 10 days ago should not count toward today's daily quota");
});

test("addQuota rejects a duplicate scope+period combination", async () => {
  await addQuota({ scope_type: "team", scope_value: "dup-quota-test", period: "daily", token_limit: 1000 });
  await assert.rejects(async () => {
    await addQuota({ scope_type: "team", scope_value: "dup-quota-test", period: "daily", token_limit: 2000 });
  }, /unique/i);
});

test("removeQuota deletes a row and re-opens access for that scope/period", async () => {
  const id = await addQuota({ scope_type: "team", scope_value: "temp-quota-team", period: "daily", token_limit: 10 });
  await seedTokens({ team: "temp-quota-team", inputTokens: 20, outputTokens: 20 });

  const before = await checkTokenQuota({ keyId: "fk_temp", team: "temp-quota-team" });
  assert.equal(before.allowed, false);

  await removeQuota(id);

  const after = await checkTokenQuota({ keyId: "fk_temp", team: "temp-quota-team" });
  assert.equal(after.allowed, true);
});

test("removeQuota returns false for a non-existent id", async () => {
  assert.equal(await removeQuota(999999), false);
});

test("listQuotas filters by scope when provided", async () => {
  await addQuota({ scope_type: "team", scope_value: "list-quota-test", period: "daily", token_limit: 1000 });
  await addQuota({ scope_type: "team", scope_value: "list-quota-test", period: "weekly", token_limit: 5000 });

  const filtered = await listQuotas({ scope_type: "team", scope_value: "list-quota-test" });
  assert.equal(filtered.length, 2);

  const all = await listQuotas();
  assert.ok(all.length >= 2);
});
