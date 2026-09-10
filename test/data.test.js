// test/data.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-data-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const { exportUsageEvents, purgeUsageEvents, getUsageEventsRaw, csvEscape } = require("../server/data");

function insertEvent(event_time, provider = "openai", model = "gpt-4o", cost_usd = 1.23) {
  db.prepare(`INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, ?, ?, 1)`).run(
    event_time,
    provider,
    model,
    cost_usd
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
  insertEvent("2026-01-01T00:00:00.000Z");
  insertEvent("2026-01-05T00:00:00.000Z");
  insertEvent("2026-01-10T00:00:00.000Z");

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
  insertEvent("2020-01-01T00:00:00.000Z");
  insertEvent("2020-01-02T00:00:00.000Z");

  const before = await getUsageEventsRaw({});
  const oldCount = before.filter((r) => r.event_time < "2021-01-01T00:00:00.000Z").length;
  assert.ok(oldCount >= 2);

  // Also implicitly confirms logAudit() didn't throw - purgeUsageEvents awaits
  // it before returning, so a broken audit call would surface right here.
  const deleted = await purgeUsageEvents("2021-01-01T00:00:00.000Z", "test-actor");
  assert.equal(deleted, oldCount);

  const after = await getUsageEventsRaw({});
  assert.ok(after.every((r) => r.event_time >= "2021-01-01T00:00:00.000Z"));
});
