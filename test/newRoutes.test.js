// test/newRoutes.test.js
//
// Lightweight route-wiring tests for agents/tags/region-allowlist/
// tool-calls/gpu-usage/query - confirming each route is actually mounted,
// enforces auth correctly, and calls through to its underlying module.
// The underlying business logic (agentAttribution.js, smartTagging.js,
// dataResidency.js, toolCallGovernance.js, gpuUsage.js, nlQuery.js) already
// has its own dedicated, thorough test file - this file is deliberately
// NOT re-testing that logic, only that the HTTP layer wires up correctly.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-newRoutes-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_newRoutes_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const agentsRoute = require("../server/routes/agents");
const tagsRoute = require("../server/routes/tags");
const regionAllowlistRoute = require("../server/routes/regionAllowlist");
const toolCallsRoute = require("../server/routes/toolCalls");
const gpuUsageRoute = require("../server/routes/gpuUsage");
const queryRoute = require("../server/routes/query");

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/agents", agentsRoute);
  app.use("/api/tags", tagsRoute);
  app.use("/api/region-allowlist", regionAllowlistRoute);
  app.use("/api/tool-calls", toolCallsRoute);
  app.use("/api/gpu-usage", gpuUsageRoute);
  app.use("/api/query", queryRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  // Close the bootstrap-mode window (see README "Bootstrap mode") BEFORE
  // any "requires auth" test runs - with zero keys/users, every request
  // is served as admin, same convention every other test file in this
  // codebase follows ("...once at least one key already exists").
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, 'bootstrap-closer', 'viewer', 'active')", [
    `fk_bootstrap_closer_${process.pid}`,
  ]);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[newRoutes.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

function request(pathName, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: pathName,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let keyCounter = 0;
async function makeApiKey(role = "admin") {
  keyCounter++;
  const key_id = `fk_test_newroutes_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

// --- agents ---

test("GET /api/agents requires auth", async () => {
  const res = await request("/api/agents");
  assert.equal(res.status, 401);
});

test("GET /api/agents returns an array (empty when no agent-tagged events exist yet)", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/agents", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
});

test("GET /api/agents/:agentId returns a per-agent summary shape", async () => {
  const key_id = await makeApiKey();
  const res = await request(`/api/agents/route-test-agent-${process.pid}`, { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.ok("cost_per_task_usd" in res.json);
});

// --- tags ---

test("GET /api/tags/inferences requires auth", async () => {
  const res = await request("/api/tags/inferences");
  assert.equal(res.status, 401);
});

test("POST /api/tags/:id/correct requires 'write' permission - a viewer is rejected", async () => {
  const key_id = await makeApiKey("viewer");
  const res = await request("/api/tags/1/correct", { method: "POST", headers: { "X-API-Key": key_id }, body: { team: "x" } });
  assert.equal(res.status, 403);
});

test("POST /api/tags/:id/correct returns 404 for a usage_event_id with no inference on record", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/tags/999999999/correct", { method: "POST", headers: { "X-API-Key": key_id }, body: { team: "x" } });
  assert.equal(res.status, 404);
});

// --- region allow-list ---

test("POST /api/region-allowlist requires manage_keys permission - a developer is rejected", async () => {
  const key_id = await makeApiKey("developer");
  const res = await request("/api/region-allowlist", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team", scope_value: "x", region: "eu-west" },
  });
  assert.equal(res.status, 403);
});

test("POST /api/region-allowlist creates an entry, GET lists it", async () => {
  const key_id = await makeApiKey();
  const team = `route-region-team-${process.pid}`;
  const createRes = await request("/api/region-allowlist", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team", scope_value: team, region: "eu-west" },
  });
  assert.equal(createRes.status, 201);

  const listRes = await request(`/api/region-allowlist?scope_type=team&scope_value=${team}`, { headers: { "X-API-Key": key_id } });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.length, 1);
});

test("DELETE /api/region-allowlist/:id returns 404 for a non-existent id", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/region-allowlist/999999999", { method: "DELETE", headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 404);
});

// --- tool calls ---

test("POST /api/tool-calls requires tool_name", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/tool-calls", { method: "POST", headers: { "X-API-Key": key_id }, body: {} });
  assert.equal(res.status, 400);
});

test("POST /api/tool-calls logs a call and GET /api/tool-calls?flagged=true surfaces it when risky", async () => {
  const key_id = await makeApiKey();
  const agent = `route-toolcall-agent-${process.pid}`;
  const postRes = await request("/api/tool-calls", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { agent_id: agent, tool_name: "bash", target: "rm -rf /" },
  });
  assert.equal(postRes.status, 201);
  assert.equal(postRes.json.flagged, true);

  const listRes = await request(`/api/tool-calls?flagged=true&agent_id=${agent}`, { headers: { "X-API-Key": key_id } });
  assert.equal(listRes.status, 200);
  assert.ok(listRes.json.length >= 1);
});

// --- gpu usage ---

test("POST /api/gpu-usage/ingest validates required fields", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/gpu-usage/ingest", { method: "POST", headers: { "X-API-Key": key_id }, body: {} });
  assert.equal(res.status, 400);
});

test("POST /api/gpu-usage/ingest then GET /api/gpu-usage/blended reflects it", async () => {
  const key_id = await makeApiKey();
  const team = `route-gpu-team-${process.pid}`;
  const postRes = await request("/api/gpu-usage/ingest", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { cluster_name: "route-test-cluster", cost_usd: 12, team },
  });
  assert.equal(postRes.status, 201);

  const blendedRes = await request("/api/gpu-usage/blended", { headers: { "X-API-Key": key_id } });
  assert.equal(blendedRes.status, 200);
  const row = blendedRes.json.find((r) => r.team === team);
  assert.equal(row.gpu_cost_usd, 12);
});

// --- nl query ---

test("GET /api/query without a q parameter returns 400", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/query", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 400);
});

test("GET /api/query?q=... returns an understood answer for a recognized shape", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/query?q=" + encodeURIComponent("what was our total spend today"), {
    headers: { "X-API-Key": key_id },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.understood, true);
});
