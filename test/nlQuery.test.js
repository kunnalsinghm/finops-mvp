// test/nlQuery.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-nlQuery-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_nlQuery_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[nlQuery.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { queryDashboard } = require("../server/nlQuery");

async function seedEvent(team, cost_usd) {
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, ?, 1)",
    [new Date().toISOString(), team, cost_usd]
  );
}

test("queryDashboard returns understood:false for an empty query", async () => {
  const result = await queryDashboard("");
  assert.equal(result.understood, false);
});

test("queryDashboard returns understood:false for a query matching no known shape", async () => {
  const result = await queryDashboard("please compose a haiku about kubernetes");
  assert.equal(result.understood, false);
});

test("queryDashboard answers a specific team's spend for a recognized team name", async () => {
  const team = `nlq-growth-${process.pid}`;
  await seedEvent(team, 42);

  const result = await queryDashboard(`what did we spend on ${team} today`);
  assert.equal(result.understood, true);
  assert.equal(result.intent, "spend_total");
  assert.equal(result.team, team);
  assert.ok(result.answer_text.includes(team));
  assert.ok(result.answer_text.includes("42"));
});

test("queryDashboard answers total spend with no team when none is mentioned/recognized", async () => {
  const result = await queryDashboard("what was our total spend today");
  assert.equal(result.understood, true);
  assert.equal(result.intent, "spend_total");
  assert.equal(result.team, null);
});

test("queryDashboard answers a top-spenders query, ranked descending", async () => {
  const teamBig = `nlq-top-big-${process.pid}`;
  const teamSmall = `nlq-top-small-${process.pid}`;
  await seedEvent(teamBig, 100);
  await seedEvent(teamSmall, 5);

  const result = await queryDashboard("who are the top spenders today");
  assert.equal(result.understood, true);
  assert.equal(result.intent, "top_spenders");

  const bigIndex = result.data.findIndex((d) => d.team === teamBig);
  const smallIndex = result.data.findIndex((d) => d.team === teamSmall);
  assert.ok(bigIndex !== -1 && smallIndex !== -1);
  assert.ok(bigIndex < smallIndex, "the bigger spender must rank first");
});

test("queryDashboard defaults to all-time when no timeframe phrase is recognized", async () => {
  const result = await queryDashboard("what did we spend");
  assert.equal(result.timeframe, "all time");
});

test("queryDashboard recognizes 'last week' as a distinct timeframe from 'today'", async () => {
  const resultToday = await queryDashboard("what did we spend today");
  const resultLastWeek = await queryDashboard("what did we spend last week");
  assert.notEqual(resultToday.timeframe, resultLastWeek.timeframe);
});
