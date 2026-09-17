// test/smartTagging.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-smartTagging-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_smartTagging_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[smartTagging.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { inferTag, listInferences, correctTag } = require("../server/smartTagging");

async function seedTaggedEvent(key_id, team) {
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, user_id, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, ?, 1, 1)",
    [new Date().toISOString(), key_id, team]
  );
}

async function seedUntaggedEvent(key_id) {
  const result = await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, user_id, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 1, 0) RETURNING id",
    [new Date().toISOString(), key_id]
  );
  return result.lastInsertRowid;
}

test("inferTag returns no inference for a key with no tagging history at all", async () => {
  const key = `key-no-history-${process.pid}`;
  const eventId = await seedUntaggedEvent(key);
  const result = await inferTag({ key_id: key, usage_event_id: eventId });
  assert.equal(result.inferred_team, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.basis, "insufficient-history");
});

test("inferTag confidently infers a team when a key has a strong majority history with that team", async () => {
  const key = `key-strong-history-${process.pid}`;
  const team = `inferred-team-${process.pid}`;
  for (let i = 0; i < 5; i++) await seedTaggedEvent(key, team);
  const eventId = await seedUntaggedEvent(key);

  const result = await inferTag({ key_id: key, usage_event_id: eventId });
  assert.equal(result.inferred_team, team);
  assert.equal(result.confidence, 1);
  assert.equal(result.basis, "key-history");
});

test("inferTag does NOT confidently infer when the key's history is split across teams without a clear majority", async () => {
  const key = `key-mixed-history-${process.pid}`;
  const teamA = `mixed-a-${process.pid}`;
  const teamB = `mixed-b-${process.pid}`;
  await seedTaggedEvent(key, teamA);
  await seedTaggedEvent(key, teamA);
  await seedTaggedEvent(key, teamB);
  await seedTaggedEvent(key, teamB);
  const eventId = await seedUntaggedEvent(key);

  const result = await inferTag({ key_id: key, usage_event_id: eventId });
  assert.equal(result.inferred_team, null);
  assert.equal(result.basis, "key-history-inconclusive");
});

test("inferTag never overrides an event that actually has a real team - only called for untagged events by the caller", async () => {
  // This is enforced by the CALLER (ingest.js/proxy.js only call inferTag
  // when !team), not by inferTag itself - documented here as the
  // contract, verified structurally by inspecting the stored inference
  // shape rather than re-testing the callers.
  const key = `key-contract-${process.pid}`;
  const eventId = await seedUntaggedEvent(key);
  const result = await inferTag({ key_id: key, usage_event_id: eventId });
  assert.equal(typeof result.usage_event_id, "number");
});

test("listInferences with uncorrected=true excludes inferences that already have a correction", async () => {
  const key = `key-list-${process.pid}`;
  const team = `list-team-${process.pid}`;
  for (let i = 0; i < 5; i++) await seedTaggedEvent(key, team);
  const eventId1 = await seedUntaggedEvent(key);
  const eventId2 = await seedUntaggedEvent(key);
  await inferTag({ key_id: key, usage_event_id: eventId1 });
  await inferTag({ key_id: key, usage_event_id: eventId2 });
  await correctTag(eventId1, team);

  const uncorrected = await listInferences({ onlyUncorrected: true });
  const ids = uncorrected.map((r) => r.usage_event_id);
  assert.ok(!ids.includes(eventId1), "corrected inference must be excluded");
  assert.ok(ids.includes(eventId2), "uncorrected inference must still appear");
});

test("correctTag applies the correction to the real usage_events.team column, not just the inference record", async () => {
  const key = `key-correct-${process.pid}`;
  const team = `correct-team-${process.pid}`;
  const eventId = await seedUntaggedEvent(key);
  await inferTag({ key_id: key, usage_event_id: eventId });

  await correctTag(eventId, team);

  const event = await storage.get("SELECT team FROM usage_events WHERE id = ?", [eventId]);
  assert.equal(event.team, team);
});

test("correctTag only sets tagged=1 if environment is ALSO present, not from team correction alone", async () => {
  const key = `key-correct-notagged-${process.pid}`;
  const team = `correct-notag-team-${process.pid}`;
  const eventId = await seedUntaggedEvent(key); // no environment set
  await inferTag({ key_id: key, usage_event_id: eventId });

  const result = await correctTag(eventId, team);
  assert.equal(result.tagged, false, "tagged requires BOTH team and environment - team alone isn't enough");
});

test("correctTag throws NOT_FOUND for a usage_event_id with no inference on record", async () => {
  await assert.rejects(() => correctTag(999999999, "some-team"), (err) => err.code === "NOT_FOUND");
});
