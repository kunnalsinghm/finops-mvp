// test/focusExport.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// focusExport.js now requires gpuUsage.js (for the GPU/blended FOCUS
// mapping), which transitively requires storage - this file needs the
// same DB isolation as every other storage-touching test file now,
// where previously it needed none. Falling back to the shared default
// path here is exactly the class of bug fixed elsewhere in this codebase
// (see server/db.js's own header comment for the incident that motivated
// that fix) - isolating it properly the first time, rather than letting
// it default and risk the same failure mode again.
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-focusExport-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_focusExport_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[focusExport.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { toFocusRow, toFocusRows, toFocusRowFromGpu, exportFocus, FOCUS_COLUMNS, billingPeriodFor, buildTags } = require("../server/focusExport");
const { ingestGpuUsage } = require("../server/gpuUsage");

function sampleRow(overrides = {}) {
  return {
    event_time: "2026-03-15T10:30:00.000Z",
    provider: "openai",
    model: "gpt-4o-mini",
    team: "growth",
    environment: "production",
    git_branch: "main",
    input_tokens: 500,
    output_tokens: 150,
    cost_usd: 0.0042,
    ...overrides,
  };
}

test("toFocusRow maps BilledCost and EffectiveCost from cost_usd", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.BilledCost, 0.0042);
  assert.equal(row.EffectiveCost, 0.0042);
});

test("toFocusRow maps Provider, Publisher, and ServiceName correctly", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.Provider, "openai");
  assert.equal(row.Publisher, "openai");
  assert.equal(row.ServiceName, "gpt-4o-mini");
});

test("toFocusRow sums input and output tokens into ConsumedQuantity", () => {
  const row = toFocusRow(sampleRow({ input_tokens: 500, output_tokens: 150 }));
  assert.equal(row.ConsumedQuantity, 650);
  assert.equal(row.ConsumedUnit, "Tokens");
});

test("toFocusRow builds a composite SkuId from provider and model", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.SkuId, "openai:gpt-4o-mini");
});

test("toFocusRow sets non-applicable columns to null, not fake values", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.RegionId, null);
  assert.equal(row.ResourceId, null);
  assert.equal(row.CommitmentDiscountType, null);
  assert.equal(row.ContractedCost, null);
});

test("toFocusRow encodes team/environment/git_branch into the Tags key-value JSON", () => {
  const row = toFocusRow(sampleRow());
  const tags = JSON.parse(row.Tags);
  assert.equal(tags.team, "growth");
  assert.equal(tags.environment, "production");
  assert.equal(tags.git_branch, "main");
});

test("toFocusRow sets Tags to null when no team/environment/git_branch present", () => {
  const row = toFocusRow(sampleRow({ team: null, environment: null, git_branch: null }));
  assert.equal(row.Tags, null);
});

test("toFocusRow encodes project_id/cost_center into the Tags key-value JSON alongside team/environment/git_branch", () => {
  const row = toFocusRow(sampleRow({ project_id: "checkout-svc", cost_center: "cc-4821" }));
  const tags = JSON.parse(row.Tags);
  assert.equal(tags.team, "growth");
  assert.equal(tags.project_id, "checkout-svc");
  assert.equal(tags.cost_center, "cc-4821");
});

test("toFocusRow omits project_id/cost_center from Tags when not present, without erroring", () => {
  const row = toFocusRow(sampleRow());
  const tags = JSON.parse(row.Tags);
  assert.equal(tags.project_id, undefined);
  assert.equal(tags.cost_center, undefined);
});

test("toFocusRow maps client_region into RegionId/RegionName when the client declared one", () => {
  const row = toFocusRow(sampleRow({ client_region: "eu-west-1" }));
  assert.equal(row.RegionId, "eu-west-1");
  assert.equal(row.RegionName, "eu-west-1");
});

test("toFocusRow leaves RegionId/RegionName null (honest null, not a fake value) when no region was declared", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.RegionId, null);
  assert.equal(row.RegionName, null);
});

test("toFocusRowFromGpu always leaves RegionId/RegionName null - self-hosted clusters have no client_region concept", () => {
  const row = toFocusRowFromGpu({
    event_time: "2026-03-15T10:30:00.000Z",
    cluster_name: "gpu-cluster-a",
    allocated_cost_usd: 12.5,
    allocated_team: "ml-team",
  });
  assert.equal(row.RegionId, null);
  assert.equal(row.RegionName, null);
});

test("billingPeriodFor returns the first and first-of-next-month for a given date", () => {
  const { start, end } = billingPeriodFor("2026-03-15T10:30:00.000Z");
  assert.equal(start, "2026-03-01T00:00:00.000Z");
  assert.equal(end, "2026-04-01T00:00:00.000Z");
});

test("billingPeriodFor handles December -> January year rollover", () => {
  const { start, end } = billingPeriodFor("2026-12-25T00:00:00.000Z");
  assert.equal(start, "2026-12-01T00:00:00.000Z");
  assert.equal(end, "2027-01-01T00:00:00.000Z");
});

test("billingPeriodFor returns nulls for an invalid date", () => {
  const { start, end } = billingPeriodFor("not-a-date");
  assert.equal(start, null);
  assert.equal(end, null);
});

test("toFocusRows produces one output row per input row, preserving order", () => {
  const rows = [sampleRow({ model: "gpt-4o-mini" }), sampleRow({ model: "gpt-4o" })];
  const result = toFocusRows(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0].ServiceName, "gpt-4o-mini");
  assert.equal(result[1].ServiceName, "gpt-4o");
});

test("FOCUS_COLUMNS matches the keys produced by toFocusRow exactly", () => {
  const row = toFocusRow(sampleRow());
  const rowKeys = Object.keys(row).sort();
  const expectedKeys = [...FOCUS_COLUMNS].sort();
  assert.deepEqual(rowKeys, expectedKeys, "toFocusRow output keys must match FOCUS_COLUMNS exactly");
});

test("toFocusRowFromGpu maps a single-owner (non-shared) GPU row with no split_method", () => {
  const row = toFocusRowFromGpu({
    event_time: "2026-03-15T10:30:00.000Z",
    cluster_name: "cluster-alpha",
    gpu_type: "H100",
    allocated_cost_usd: 42,
    allocated_team: "ml-team",
    split_method: null,
  });
  assert.equal(row.BilledCost, 42);
  assert.equal(row.EffectiveCost, 42);
  assert.equal(row.SubAccountId, "ml-team");
  assert.equal(row.ResourceId, "cluster-alpha");
  assert.equal(row.ServiceCategory, "Compute");
  assert.equal(row.Provider, "self-hosted");
  assert.equal(row.ConsumedQuantity, null, "utilization_pct is a rate, not a consumed quantity - must be honestly null, not faked");
  const tags = JSON.parse(row.Tags);
  assert.equal(tags.split_allocation_method, undefined, "a directly-measured (non-shared) row must not claim a split method");
});

test("toFocusRowFromGpu marks an allocated (shared-cluster) row with its split_method in Tags and description", () => {
  const row = toFocusRowFromGpu({
    event_time: "2026-03-15T10:30:00.000Z",
    cluster_name: "shared-cluster",
    gpu_type: "A100",
    allocated_cost_usd: 30,
    allocated_team: "growth",
    split_method: "relative-api-spend",
  });
  const tags = JSON.parse(row.Tags);
  assert.equal(tags.split_allocation_method, "relative-api-spend");
  assert.match(row.ChargeDescription, /allocated share/);
});

test("toFocusRowFromGpu output keys match FOCUS_COLUMNS exactly, same as API rows", () => {
  const row = toFocusRowFromGpu({
    event_time: "2026-03-15T10:30:00.000Z",
    cluster_name: "cluster-x",
    allocated_cost_usd: 1,
    allocated_team: "team-x",
    split_method: null,
  });
  const rowKeys = Object.keys(row).sort();
  const expectedKeys = [...FOCUS_COLUMNS].sort();
  assert.deepEqual(rowKeys, expectedKeys, "GPU rows must conform to the exact same FOCUS schema as API rows - that's the whole point of a unified export");
});

test("exportFocus includes both API and GPU rows in one unified export", async () => {
  const team = `focus-blend-team-${process.pid}`;
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 5, 1)",
    [new Date().toISOString(), team]
  );
  await ingestGpuUsage({ cluster_name: `focus-cluster-${process.pid}`, cost_usd: 15, team });

  const rows = await exportFocus({ format: "json" });
  assert.ok(rows.some((r) => r.SubAccountId === team && r.Provider === "openai"));
  assert.ok(rows.some((r) => r.SubAccountId === team && r.Provider === "self-hosted"));
});

test("exportFocus splits a shared GPU cluster's cost across its teams in the export", async () => {
  const teamA = `focus-shared-a-${process.pid}`;
  const teamB = `focus-shared-b-${process.pid}`;
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 60, 1)",
    [new Date().toISOString(), teamA]
  );
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 40, 1)",
    [new Date().toISOString(), teamB]
  );
  await ingestGpuUsage({ cluster_name: `focus-shared-cluster-${process.pid}`, cost_usd: 100, shared_across_teams: `${teamA},${teamB}` });

  const rows = await exportFocus({ format: "json" });
  const gpuRowA = rows.find((r) => r.SubAccountId === teamA && r.Provider === "self-hosted" && r.ResourceId.includes("focus-shared-cluster"));
  const gpuRowB = rows.find((r) => r.SubAccountId === teamB && r.Provider === "self-hosted" && r.ResourceId.includes("focus-shared-cluster"));

  assert.equal(gpuRowA.BilledCost, 60, "team A had 60% of combined API spend between these two teams, so gets 60% of the shared GPU cost");
  assert.equal(gpuRowB.BilledCost, 40);
});
