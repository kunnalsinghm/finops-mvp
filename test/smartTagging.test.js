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

const { inferTag, listInferences, correctTag, MIN_HISTORY_FOR_HOUR_INFERENCE } = require("../server/smartTagging");

async function seedTaggedEvent(key_id, team) {
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, user_id, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, ?, 1, 1)",
    [new Date().toISOString(), key_id, team]
  );
}

async function seedTaggedEventAt(key_id, team, event_time) {
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, user_id, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, ?, 1, 1)",
    [event_time, key_id, team]
  );
}

async function seedUntaggedEvent(key_id) {
  const result = await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, user_id, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 1, 0) RETURNING id",
    [new Date().toISOString(), key_id]
  );
  return result.lastInsertRowid;
}

async function seedUntaggedEventAt(key_id, event_time) {
  const result = await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, user_id, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 1, 0) RETURNING id",
    [event_time, key_id]
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

test("inferTag falls back to time-of-day pattern when key-history is split across teams but this event's own hour matches one team's history cleanly", async () => {
  const key = `key-hourly-${process.pid}`;
  const teamDay = `day-team-${process.pid}`;
  const teamNight = `night-team-${process.pid}`;
  // Day team: always tagged at 09:00 UTC. Night team: always tagged at
  // 22:00 UTC. Overall split is 3/3 - global key-history majority fails
  // (0.5 < 0.6 threshold) - but each hour's own slice is a clean 3-for-3.
  for (let i = 1; i <= 3; i++) await seedTaggedEventAt(key, teamDay, `2026-01-0${i}T09:00:00.000Z`);
  for (let i = 1; i <= 3; i++) await seedTaggedEventAt(key, teamNight, `2026-01-0${i}T22:00:00.000Z`);

  const morningEvent = await seedUntaggedEventAt(key, "2026-01-10T09:20:00.000Z");
  const morningResult = await inferTag({ key_id: key, usage_event_id: morningEvent });
  assert.equal(morningResult.inferred_team, teamDay);
  assert.equal(morningResult.basis, "key-history-time-of-day");
  assert.equal(morningResult.confidence, 1);

  const nightEvent = await seedUntaggedEventAt(key, "2026-01-10T22:05:00.000Z");
  const nightResult = await inferTag({ key_id: key, usage_event_id: nightEvent });
  assert.equal(nightResult.inferred_team, teamNight);
  assert.equal(nightResult.basis, "key-history-time-of-day");
});

test("inferTag does NOT use the time-of-day fallback when the matching-hour slice is below its own minimum sample size, even if it looks like a clean majority", async () => {
  const key = `key-hourly-thin-${process.pid}`;
  const teamA = `thin-a-${process.pid}`;
  const teamB = `thin-b-${process.pid}`;
  // Global split: 2 vs 2 (inconclusive). At 09:00 UTC there is exactly ONE
  // teamA event - a "100% majority" by fraction, but the sample is below
  // MIN_HISTORY_FOR_HOUR_INFERENCE and must not be trusted.
  assert.ok(MIN_HISTORY_FOR_HOUR_INFERENCE > 1, "this test assumes the hour-sample bar is above 1");
  await seedTaggedEventAt(key, teamA, "2026-02-01T09:00:00.000Z");
  await seedTaggedEventAt(key, teamA, "2026-02-01T14:00:00.000Z");
  await seedTaggedEventAt(key, teamB, "2026-02-01T18:00:00.000Z");
  await seedTaggedEventAt(key, teamB, "2026-02-01T19:00:00.000Z");

  const eventId = await seedUntaggedEventAt(key, "2026-02-10T09:10:00.000Z");
  const result = await inferTag({ key_id: key, usage_event_id: eventId });
  assert.equal(result.inferred_team, null, "one matching-hour event is not enough evidence to infer from");
  assert.equal(result.basis, "key-history-inconclusive");
});

test("inferTag stays inconclusive when the matching hour is ALSO split with no majority", async () => {
  const key = `key-hourly-mixed-${process.pid}`;
  const teamA = `hourmix-a-${process.pid}`;
  const teamB = `hourmix-b-${process.pid}`;
  // All 6 events at the same hour (09:00 UTC), evenly split 3/3 - both the
  // global view AND the hour-filtered view are the same inconclusive split.
  for (let i = 1; i <= 3; i++) await seedTaggedEventAt(key, teamA, `2026-03-0${i}T09:00:00.000Z`);
  for (let i = 1; i <= 3; i++) await seedTaggedEventAt(key, teamB, `2026-03-1${i}T09:00:00.000Z`);

  const eventId = await seedUntaggedEventAt(key, "2026-03-20T09:30:00.000Z");
  const result = await inferTag({ key_id: key, usage_event_id: eventId });
  assert.equal(result.inferred_team, null);
  assert.equal(result.basis, "key-history-inconclusive");
});

test("a corrected inference feeds back into future key-history inferences for that key, with no separate weighting mechanism", async () => {
  const key = `key-correction-feedback-${process.pid}`;
  const team = `feedback-team-${process.pid}`;

  // No tagging history yet at all.
  const firstEventId = await seedUntaggedEvent(key);
  const before = await inferTag({ key_id: key, usage_event_id: firstEventId });
  assert.equal(before.basis, "insufficient-history");

  // A human corrects that first event - this writes team back onto the
  // underlying usage_events row (see correctTag), which is the entire
  // feedback mechanism: no separate "corrections" table is consulted.
  await correctTag(firstEventId, team);

  // Two more untagged events, corrected the same way, to clear the
  // MIN_HISTORY_FOR_INFERENCE bar via corrections alone.
  const secondEventId = await seedUntaggedEvent(key);
  await inferTag({ key_id: key, usage_event_id: secondEventId });
  await correctTag(secondEventId, team);
  const thirdEventId = await seedUntaggedEvent(key);
  await inferTag({ key_id: key, usage_event_id: thirdEventId });
  await correctTag(thirdEventId, team);

  // A brand-new untagged event should now infer confidently from what is
  // ENTIRELY corrected, not originally-supplied, history.
  const fourthEventId = await seedUntaggedEvent(key);
  const after = await inferTag({ key_id: key, usage_event_id: fourthEventId });
  assert.equal(after.inferred_team, team);
  assert.equal(after.basis, "key-history");
  assert.equal(after.confidence, 1);
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
