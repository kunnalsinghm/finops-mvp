// test/costs.test.js
//
// server/routes/costs.js had ZERO automated test coverage before this file.
// These are the exact queries the dashboard renders from, so a grouping or
// rounding bug here shows up directly as a wrong number on someone's
// screen - and every query was flagged in this codebase's own comments as
// having needed a rewrite specifically to avoid a Postgres-only SQL error
// (ROUND(double precision, integer) has no overload), so this is exactly
// the kind of route where "passes on SQLite" and "actually correct" have
// already proven to be two different things once.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-costs-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-costs-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_costs_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const costsRoute = require("../server/routes/costs");

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/costs", costsRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[costs.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

function request(pathName, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: server.address().port, path: pathName, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let keyCounter = 0;
async function makeApiKey(role = "admin") {
  keyCounter++;
  const key_id = `fk_test_costs_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

async function seedEvent({ team = null, environment = null, feature_id = null, customer_id = null, project_id = null, cost_center = null, client_region = null, provider = "openai", model = "gpt-4o-mini", cost_usd, input_tokens = 0, output_tokens = 0, tagged = 1, event_time }) {
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, team, environment, feature_id, customer_id, project_id, cost_center, client_region, cost_usd, input_tokens, output_tokens, tagged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [event_time || new Date().toISOString(), provider, model, team, environment, feature_id, customer_id, project_id, cost_center, client_region, cost_usd, input_tokens, output_tokens, tagged]
  );
}

test("rejects a request with no API key once at least one key already exists", async () => {
  await makeApiKey();
  const res = await request("/api/costs/summary");
  assert.equal(res.status, 401);
});

test("/by-team groups spend by team, buckets null team as 'Untagged', rounds to 4dp, orders by cost descending", async () => {
  const key_id = await makeApiKey();
  const teamA = `costs-team-a-${process.pid}`;
  const teamB = `costs-team-b-${process.pid}`;
  await seedEvent({ team: teamA, cost_usd: 1.00005 });
  await seedEvent({ team: teamA, cost_usd: 2.00005 });
  await seedEvent({ team: teamB, cost_usd: 0.5 });
  await seedEvent({ team: null, cost_usd: 10 });

  const res = await request("/api/costs/by-team", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);

  const byTeam = Object.fromEntries(res.json.map((r) => [r.team, r]));
  assert.equal(byTeam[teamA].total_cost, 3.0001);
  assert.equal(byTeam[teamA].event_count, 2);
  assert.equal(byTeam[teamB].total_cost, 0.5);
  assert.ok(byTeam["Untagged"], "a null team must be bucketed under the literal string 'Untagged', not omitted");
  assert.equal(byTeam["Untagged"].total_cost, 10);

  const costs = res.json.map((r) => r.total_cost);
  const sorted = [...costs].sort((a, b) => b - a);
  assert.deepEqual(costs, sorted, "rows must be ordered by total_cost descending");
});

test("/by-feature groups spend by feature_id, buckets null as 'Untagged'", async () => {
  const key_id = await makeApiKey();
  const featureA = `costs-feature-a-${process.pid}`;
  await seedEvent({ feature_id: featureA, cost_usd: 4 });
  await seedEvent({ feature_id: featureA, cost_usd: 1 });
  await seedEvent({ feature_id: null, cost_usd: 7 });

  const res = await request("/api/costs/by-feature", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);

  const byFeature = Object.fromEntries(res.json.map((r) => [r.feature_id, r]));
  assert.equal(byFeature[featureA].total_cost, 5);
  assert.equal(byFeature[featureA].event_count, 2);
  // "Untagged" is shared across every test in this file that seeds a null
  // feature_id (including /by-team's null-team events, which are also
  // null-feature_id) - so it only ever grows across the file, never
  // resets. Assert this test's own contribution landed, not an exact total.
  assert.ok(byFeature["Untagged"], "a null feature_id must be bucketed under 'Untagged'");
  assert.ok(byFeature["Untagged"].total_cost >= 7, "Untagged total must include this test's $7 contribution");
});

test("/by-customer groups spend by customer_id, buckets null as 'Untagged'", async () => {
  const key_id = await makeApiKey();
  const customerA = `costs-customer-a-${process.pid}`;
  await seedEvent({ customer_id: customerA, cost_usd: 2.5 });
  await seedEvent({ customer_id: null, cost_usd: 3 });

  const res = await request("/api/costs/by-customer", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);

  const byCustomer = Object.fromEntries(res.json.map((r) => [r.customer_id, r]));
  assert.equal(byCustomer[customerA].total_cost, 2.5);
  assert.ok(byCustomer["Untagged"], "a null customer_id must be bucketed under 'Untagged'");
  assert.ok(byCustomer["Untagged"].total_cost >= 3, "Untagged total must include this test's $3 contribution");
});

test("/by-project groups spend by project_id, buckets null as 'Untagged'", async () => {
  const key_id = await makeApiKey();
  const projectA = `costs-project-a-${process.pid}`;
  await seedEvent({ project_id: projectA, cost_usd: 6 });
  await seedEvent({ project_id: projectA, cost_usd: 1.5 });
  await seedEvent({ project_id: null, cost_usd: 9 });

  const res = await request("/api/costs/by-project", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);

  const byProject = Object.fromEntries(res.json.map((r) => [r.project_id, r]));
  assert.equal(byProject[projectA].total_cost, 7.5);
  assert.equal(byProject[projectA].event_count, 2);
  assert.ok(byProject["Untagged"], "a null project_id must be bucketed under 'Untagged'");
  assert.ok(byProject["Untagged"].total_cost >= 9, "Untagged total must include this test's $9 contribution");

  const costs = res.json.map((r) => r.total_cost);
  const sorted = [...costs].sort((a, b) => b - a);
  assert.deepEqual(costs, sorted, "rows must be ordered by total_cost descending");
});

test("/by-cost-center groups spend by cost_center, buckets null as 'Untagged'", async () => {
  const key_id = await makeApiKey();
  const ccA = `costs-cc-a-${process.pid}`;
  await seedEvent({ cost_center: ccA, cost_usd: 3.25 });
  await seedEvent({ cost_center: null, cost_usd: 4 });

  const res = await request("/api/costs/by-cost-center", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);

  const byCostCenter = Object.fromEntries(res.json.map((r) => [r.cost_center, r]));
  assert.equal(byCostCenter[ccA].total_cost, 3.25);
  assert.ok(byCostCenter["Untagged"], "a null cost_center must be bucketed under 'Untagged'");
  assert.ok(byCostCenter["Untagged"].total_cost >= 4, "Untagged total must include this test's $4 contribution");
});

test("/by-region groups spend by client_region, buckets null as 'Untagged'", async () => {
  const key_id = await makeApiKey();
  const regionA = `costs-region-a-${process.pid}`;
  await seedEvent({ client_region: regionA, cost_usd: 8 });
  await seedEvent({ client_region: regionA, cost_usd: 2 });
  await seedEvent({ client_region: null, cost_usd: 5 });

  const res = await request("/api/costs/by-region", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);

  const byRegion = Object.fromEntries(res.json.map((r) => [r.region, r]));
  assert.equal(byRegion[regionA].total_cost, 10);
  assert.equal(byRegion[regionA].event_count, 2);
  assert.ok(byRegion["Untagged"], "a null client_region must be bucketed under 'Untagged'");
  assert.ok(byRegion["Untagged"].total_cost >= 5, "Untagged total must include this test's $5 contribution");
});

test("/by-model groups by provider+model and sums both cost and token counts", async () => {
  const key_id = await makeApiKey();
  const model = `costs-model-${process.pid}`;
  await seedEvent({ provider: "openai", model, cost_usd: 1, input_tokens: 100, output_tokens: 50 });
  await seedEvent({ provider: "openai", model, cost_usd: 2, input_tokens: 200, output_tokens: 75 });
  await seedEvent({ provider: "anthropic", model, cost_usd: 5, input_tokens: 10, output_tokens: 5 });

  const res = await request("/api/costs/by-model", { headers: { "X-API-Key": key_id } });
  const openaiRow = res.json.find((r) => r.provider === "openai" && r.model === model);
  const anthropicRow = res.json.find((r) => r.provider === "anthropic" && r.model === model);

  assert.equal(openaiRow.total_cost, 3);
  assert.equal(openaiRow.event_count, 2);
  assert.equal(Number(openaiRow.input_tokens), 300);
  assert.equal(Number(openaiRow.output_tokens), 125);
  assert.equal(anthropicRow.total_cost, 5, "same model name under a different provider must be a separate row");
});

test("/over-time groups spend into calendar-day buckets, not by exact timestamp", async () => {
  const key_id = await makeApiKey();
  const model = `costs-time-model-${process.pid}`;
  await seedEvent({ model, cost_usd: 1, event_time: "2024-03-01T01:00:00.000Z" });
  await seedEvent({ model, cost_usd: 2, event_time: "2024-03-01T23:00:00.000Z" });
  await seedEvent({ model, cost_usd: 5, event_time: "2024-03-02T12:00:00.000Z" });

  const res = await request("/api/costs/over-time", { headers: { "X-API-Key": key_id } });
  const byDay = Object.fromEntries(res.json.map((r) => [String(r.day).slice(0, 10), r.total_cost]));
  assert.equal(byDay["2024-03-01"], 3, "same-day events at different times must be summed into one bucket");
  assert.equal(byDay["2024-03-02"], 5);
});

test("/untagged sums only events where tagged = 0, ignoring tagged spend entirely", async () => {
  const key_id = await makeApiKey();
  const before = await request("/api/costs/untagged", { headers: { "X-API-Key": key_id } });
  const baselineCost = before.json.total_untagged_cost;
  const baselineCount = before.json.event_count;

  await seedEvent({ team: "tagged-team", cost_usd: 100, tagged: 1 });
  await seedEvent({ team: null, cost_usd: 7, tagged: 0 });

  const res = await request("/api/costs/untagged", { headers: { "X-API-Key": key_id } });
  assert.equal(res.json.total_untagged_cost, baselineCost + 7, "tagged spend must not leak into the untagged total");
  assert.equal(res.json.event_count, baselineCount + 1);
});

test("/summary reports an overall total distinct from today's total, excluding older events from today_cost", async () => {
  const key_id = await makeApiKey();
  const before = await request("/api/costs/summary", { headers: { "X-API-Key": key_id } });
  const baselineTotal = before.json.total_cost;
  const baselineToday = before.json.today_cost;

  await seedEvent({ cost_usd: 50, event_time: "2020-06-15T12:00:00.000Z" });
  await seedEvent({ cost_usd: 3, event_time: new Date().toISOString() });

  const res = await request("/api/costs/summary", { headers: { "X-API-Key": key_id } });
  assert.equal(res.json.total_cost, baselineTotal + 53);
  assert.equal(res.json.today_cost, baselineToday + 3, "a 2020 event must not be counted in today_cost");
});

test("/forecast returns available:false with a reason when there isn't enough lookback data yet", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/costs/forecast?lookback_days=1&horizon_days=30", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
  assert.match(res.json.reason, /Need at least/);
});

test("/forecast returns available:true with a numeric projected_spend_usd once enough days of history exist", async () => {
  const key_id = await makeApiKey();
  const team = `forecast-team-${process.pid}`;
  for (let i = 0; i < 10; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    await seedEvent({ team, cost_usd: 10, event_time: d.toISOString() });
  }

  const res = await request("/api/costs/forecast?lookback_days=10&horizon_days=30", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.available, true);
  assert.equal(typeof res.json.projected_spend_usd, "number");
  assert.ok(res.json.projected_spend_usd > 0);
});
