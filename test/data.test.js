// test/data.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-data-*.db* files from a PREVIOUS run of this file
// that never got a chance to clean up (e.g. Ctrl+C, a crashed process, a
// killed terminal) - test.after() below only runs on a normal exit, so an
// interrupted run leaves orphaned temp DB files behind indefinitely
// otherwise. Doing this at startup, not just teardown, means the next run
// cleans up after the last one even if that one never got the chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-data-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-data-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_data_${process.pid}`;
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
      console.warn(`[data.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { exportUsageEvents, purgeUsageEvents, getUsageEventsRaw, csvEscape } = require("../server/data");

async function insertEvent(event_time, provider = "openai", model = "gpt-4o", cost_usd = 1.23) {
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, ?, ?, 1)`,
    [event_time, provider, model, cost_usd]
  );
}

test("csvEscape leaves plain values unchanged", () => {
  assert.equal(csvEscape("hello"), "hello");
  assert.equal(csvEscape(42), "42");
});

test("csvEscape quotes and escapes values containing commas, quotes, or newlines", () => {
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvEscape("line1\nline2"), '"line1\nline2"');
});

test("csvEscape returns an empty string for null/undefined", () => {
  assert.equal(csvEscape(null), "");
  assert.equal(csvEscape(undefined), "");
});

test("getUsageEventsRaw filters by from/to and orders ascending", async () => {
  await insertEvent("2026-01-01T00:00:00.000Z");
  await insertEvent("2026-01-05T00:00:00.000Z");
  await insertEvent("2026-01-10T00:00:00.000Z");

  const rows = await getUsageEventsRaw({ from: "2026-01-02T00:00:00.000Z", to: "2026-01-09T00:00:00.000Z" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_time, "2026-01-05T00:00:00.000Z");
});

test("getUsageEventsRaw with no filters returns everything, ascending", async () => {
  const rows = await getUsageEventsRaw({});
  assert.ok(rows.length >= 3);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].event_time >= rows[i - 1].event_time);
  }
});

test("exportUsageEvents defaults to json and returns raw rows", async () => {
  const rows = await exportUsageEvents({});
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 3);
});

test("exportUsageEvents with format csv returns a header row plus one row per event", async () => {
  const csv = await exportUsageEvents({ format: "csv" });
  const lines = csv.split("\n");
  const rows = await getUsageEventsRaw({});
  assert.equal(lines.length, rows.length + 1, "expected one header line plus one line per row");
  assert.match(lines[0], /event_time/);
});

test("exportUsageEvents with format csv returns an empty string when there are no matching rows", async () => {
  const csv = await exportUsageEvents({ from: "2099-01-01T00:00:00.000Z", format: "csv" });
  assert.equal(csv, "");
});

test("purgeUsageEvents requires an explicit cutoff date", async () => {
  await assert.rejects(purgeUsageEvents(undefined, "test-actor"), /beforeIsoDate is required/);
});

test("purgeUsageEvents deletes only events older than the cutoff and returns the count deleted", async () => {
  await insertEvent("2020-01-01T00:00:00.000Z");
  await insertEvent("2020-01-02T00:00:00.000Z");

  const before = await getUsageEventsRaw({});
  const oldCount = before.filter((r) => r.event_time < "2021-01-01T00:00:00.000Z").length;
  assert.ok(oldCount >= 2);

  const deleted = await purgeUsageEvents("2021-01-01T00:00:00.000Z", "test-actor");
  assert.equal(deleted, oldCount);

  const after = await getUsageEventsRaw({});
  assert.ok(after.every((r) => r.event_time >= "2021-01-01T00:00:00.000Z"));
});
