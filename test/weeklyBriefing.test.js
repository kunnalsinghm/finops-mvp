// test/weeklyBriefing.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-weeklyBriefing-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_weeklyBriefing_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[weeklyBriefing.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const {
  buildWeeklyBriefing,
  sendWeeklyBriefing,
  checkWeeklyBriefing,
  getIsoWeekKey,
  formatBriefingMessage,
} = require("../server/weeklyBriefing");

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function seedSpend({ team, cost_usd, daysAgo: d }) {
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, ?, 1)",
    [daysAgo(d), team, cost_usd]
  );
}

test("getIsoWeekKey returns the same key for two dates in the same ISO week", () => {
  // A known Monday and the following Sunday are in the same ISO week.
  const monday = new Date("2026-09-14T00:00:00Z");
  const sunday = new Date("2026-09-20T23:59:59Z");
  assert.equal(getIsoWeekKey(monday), getIsoWeekKey(sunday));
});

test("getIsoWeekKey returns a different key across a week boundary", () => {
  const sunday = new Date("2026-09-20T23:59:59Z");
  const nextMonday = new Date("2026-09-21T00:00:01Z");
  assert.notEqual(getIsoWeekKey(sunday), getIsoWeekKey(nextMonday));
});

test("buildWeeklyBriefing computes this-week total, last-week total, and delta_pct", async () => {
  const team = `wb-team-${process.pid}`;
  await seedSpend({ team, cost_usd: 100, daysAgo: 10 }); // last week
  await seedSpend({ team, cost_usd: 50, daysAgo: 2 });   // this week

  const briefing = await buildWeeklyBriefing();
  assert.ok(briefing.total_this_week >= 50, "this week's total must include the seeded $50");
  assert.ok(briefing.total_last_week >= 100, "last week's total must include the seeded $100");
  assert.equal(typeof briefing.delta_pct, "number");
});

test("buildWeeklyBriefing ranks top_movers by absolute dollar delta, largest first", async () => {
  const teamBig = `wb-big-mover-${process.pid}`;
  const teamSmall = `wb-small-mover-${process.pid}`;
  await seedSpend({ team: teamBig, cost_usd: 5, daysAgo: 10 });
  await seedSpend({ team: teamBig, cost_usd: 205, daysAgo: 2 }); // +200 swing
  await seedSpend({ team: teamSmall, cost_usd: 5, daysAgo: 10 });
  await seedSpend({ team: teamSmall, cost_usd: 6, daysAgo: 2 }); // +1 swing

  const briefing = await buildWeeklyBriefing();
  const bigIndex = briefing.top_movers.findIndex((m) => m.team === teamBig);
  const smallIndex = briefing.top_movers.findIndex((m) => m.team === teamSmall);
  assert.ok(bigIndex !== -1, "expected the large mover to appear in top_movers");
  if (smallIndex !== -1) {
    assert.ok(bigIndex < smallIndex, "the larger absolute swing must rank first");
  }
});

test("formatBriefingMessage handles the no-prior-week-spend case without throwing", () => {
  const msg = formatBriefingMessage({ total_this_week: 10, total_last_week: 0, delta_pct: null, top_movers: [] });
  assert.match(msg, /n\/a/);
});

test("sendWeeklyBriefing delivers (falls back to local alerts_log with no channels configured) and returns the briefing", async () => {
  const before = await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'weekly-briefing'");
  const briefing = await sendWeeklyBriefing();
  assert.ok(briefing.total_this_week !== undefined);
  const after = await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'weekly-briefing'");
  assert.equal(Number(after.n), Number(before.n) + 1);
});

test("checkWeeklyBriefing is a no-op on any day other than Monday (UTC)", async () => {
  const today = new Date();
  if (today.getUTCDay() === 1) return; // skip this assertion if the test happens to run on a Monday

  const before = await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'weekly-briefing'");
  await checkWeeklyBriefing();
  const after = await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'weekly-briefing'");
  assert.equal(Number(after.n), Number(before.n), "checkWeeklyBriefing must not send outside of Monday");
});
