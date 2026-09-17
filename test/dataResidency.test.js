// test/dataResidency.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-dataResidency-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_dataResidency_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[dataResidency.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { checkRegionAllowed, addRegionAllowlistEntry, removeRegionAllowlistEntry, listRegionAllowlistEntries } = require("../server/dataResidency");

test("checkRegionAllowed is unrestricted (allowed) when no region is supplied at all", async () => {
  const result = await checkRegionAllowed({ keyId: "no-region-key", team: "no-region-team", region: null });
  assert.equal(result.allowed, true);
  assert.equal(result.scope, null);
});

test("checkRegionAllowed is unrestricted when neither key nor team has any allow-list entries", async () => {
  const result = await checkRegionAllowed({ keyId: `unrestricted-key-${process.pid}`, team: `unrestricted-team-${process.pid}`, region: "eu-west" });
  assert.equal(result.allowed, true);
  assert.equal(result.scope, null);
});

test("checkRegionAllowed enforces a team-level allow-list", async () => {
  const team = `team-residency-${process.pid}`;
  await addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "eu-west" });

  const allowed = await checkRegionAllowed({ keyId: "irrelevant-key", team, region: "eu-west" });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.scope, "team");

  const blocked = await checkRegionAllowed({ keyId: "irrelevant-key", team, region: "us-east" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "team");
});

test("checkRegionAllowed: key-level entries take precedence over team-level entries", async () => {
  const key = `key-residency-${process.pid}`;
  const team = `team-residency-precedence-${process.pid}`;
  await addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "us-east" });
  await addRegionAllowlistEntry({ scope_type: "key", scope_value: key, region: "eu-west" });

  // Team allows us-east, but this key has its OWN list (eu-west only) -
  // the key's list wins entirely, team entries are ignored for this call.
  const result = await checkRegionAllowed({ keyId: key, team, region: "us-east" });
  assert.equal(result.allowed, false);
  assert.equal(result.scope, "key");
});

test("addRegionAllowlistEntry rejects an exact duplicate", async () => {
  const team = `dup-team-${process.pid}`;
  await addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "eu-west" });
  await assert.rejects(() => addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "eu-west" }));
});

test("removeRegionAllowlistEntry deletes a row and re-opens access for that scope", async () => {
  const team = `remove-team-${process.pid}`;
  const id = await addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "ap-south" });

  let blocked = await checkRegionAllowed({ keyId: "x", team, region: "us-east" });
  assert.equal(blocked.allowed, false);

  const removed = await removeRegionAllowlistEntry(id);
  assert.equal(removed, true);

  const nowUnrestricted = await checkRegionAllowed({ keyId: "x", team, region: "us-east" });
  assert.equal(nowUnrestricted.allowed, true);
});

test("listRegionAllowlistEntries filters by scope when provided", async () => {
  const team = `list-team-${process.pid}`;
  await addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "eu-west" });
  const rows = await listRegionAllowlistEntries({ scope_type: "team", scope_value: team });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.scope_value === team));
});
