// test/gpuUsage.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-gpuUsage-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_gpuUsage_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[gpuUsage.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { ingestGpuUsage, getBlendedCostByTeam } = require("../server/gpuUsage");

async function seedApiSpend(team, cost_usd) {
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, ?, 1)",
    [new Date().toISOString(), team, cost_usd]
  );
}

test("ingestGpuUsage requires either team or shared_across_teams", async () => {
  await assert.rejects(
    () => ingestGpuUsage({ cluster_name: "cluster-a", cost_usd: 10 }),
    (err) => err.code === "VALIDATION"
  );
});

test("ingestGpuUsage requires cluster_name and cost_usd", async () => {
  await assert.rejects(
    () => ingestGpuUsage({ team: "some-team", cost_usd: 10 }),
    (err) => err.code === "VALIDATION"
  );
});

test("getBlendedCostByTeam combines direct API spend and direct (single-owner) GPU spend for a team", async () => {
  const team = `blend-direct-${process.pid}`;
  await seedApiSpend(team, 10);
  await ingestGpuUsage({ cluster_name: "cluster-x", cost_usd: 25, team });

  const rows = await getBlendedCostByTeam();
  const row = rows.find((r) => r.team === team);
  assert.equal(row.api_cost_usd, 10);
  assert.equal(row.gpu_cost_usd, 25);
  assert.equal(row.blended_total_usd, 35);
});

test("getBlendedCostByTeam splits a shared cluster's cost proportionally by relative API spend", async () => {
  const teamA = `blend-shared-a-${process.pid}`;
  const teamB = `blend-shared-b-${process.pid}`;
  await seedApiSpend(teamA, 75); // 75% of combined API spend
  await seedApiSpend(teamB, 25); // 25% of combined API spend
  await ingestGpuUsage({ cluster_name: "shared-cluster", cost_usd: 100, shared_across_teams: `${teamA},${teamB}` });

  const rows = await getBlendedCostByTeam();
  const rowA = rows.find((r) => r.team === teamA);
  const rowB = rows.find((r) => r.team === teamB);

  assert.equal(rowA.gpu_cost_usd, 75, "team A had 75% of the combined API spend, so gets 75% of the shared GPU cost");
  assert.equal(rowB.gpu_cost_usd, 25);
});

test("getBlendedCostByTeam splits evenly when neither team sharing a cluster has any API spend to weight by", async () => {
  const teamA = `blend-even-a-${process.pid}`;
  const teamB = `blend-even-b-${process.pid}`;
  await ingestGpuUsage({ cluster_name: "even-cluster", cost_usd: 100, shared_across_teams: `${teamA},${teamB}` });

  const rows = await getBlendedCostByTeam();
  const rowA = rows.find((r) => r.team === teamA);
  const rowB = rows.find((r) => r.team === teamB);

  assert.equal(rowA.gpu_cost_usd, 50);
  assert.equal(rowB.gpu_cost_usd, 50);
});

test("getBlendedCostByTeam sorts by blended_total_usd descending", async () => {
  const rows = await getBlendedCostByTeam();
  const totals = rows.map((r) => r.blended_total_usd);
  const sorted = [...totals].sort((a, b) => b - a);
  assert.deepEqual(totals, sorted);
});
