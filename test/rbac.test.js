// test/rbac.test.js - A9: the 'auditor' and 'agent' roles.
//
// Two layers of coverage, matching this repo's existing split between
// "unit test the module" and "lightweight route-wiring test" (see
// modelAllowlist.test.js vs. newRoutes.test.js):
//   1. Permission-matrix unit tests directly against auth.js's
//      hasPermission/ROLE_PERMISSIONS - the source of truth every route's
//      requireAuth(...) call is ultimately checked against.
//   2. Route-wiring tests booting a real Express instance (same pattern as
//      newRoutes.test.js) proving an auditor key can reach the specific
//      audit-relevant GET routes and is 403'd everywhere else, and an
//      agent key can reach ingest/proxy-shaped write routes and is 403'd
//      on admin/dashboard routes.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-rbac-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_rbac_${process.pid}`;
}

const { hasPermission, ROLE_PERMISSIONS, API_KEY_ROLES, DASHBOARD_ROLES } = require("../server/auth");

// ---- 1. Permission-matrix unit tests ----

test("API_KEY_ROLES includes all six spec roles", () => {
  for (const role of ["admin", "budget-manager", "developer", "viewer", "auditor", "agent"]) {
    assert.ok(API_KEY_ROLES.includes(role), `expected API_KEY_ROLES to include '${role}'`);
  }
  assert.equal(API_KEY_ROLES.length, 6);
});

test("DASHBOARD_ROLES excludes 'agent' - a machine credential can't be a dashboard account", () => {
  assert.ok(!DASHBOARD_ROLES.includes("agent"));
  for (const role of ["admin", "budget-manager", "developer", "viewer", "auditor"]) {
    assert.ok(DASHBOARD_ROLES.includes(role));
  }
  assert.equal(DASHBOARD_ROLES.length, 5);
});

test("auditor holds ONLY audit_read - not read, write, manage_keys, or manage_budgets", () => {
  assert.deepEqual(ROLE_PERMISSIONS.auditor, ["audit_read"]);
  assert.equal(hasPermission("auditor", "audit_read"), true);
  assert.equal(hasPermission("auditor", "read"), false);
  assert.equal(hasPermission("auditor", "write"), false);
  assert.equal(hasPermission("auditor", "manage_keys"), false);
  assert.equal(hasPermission("auditor", "manage_budgets"), false);
});

test("agent holds ONLY write - not read, manage_keys, or manage_budgets", () => {
  assert.deepEqual(ROLE_PERMISSIONS.agent, ["write"]);
  assert.equal(hasPermission("agent", "write"), true);
  assert.equal(hasPermission("agent", "read"), false);
  assert.equal(hasPermission("agent", "manage_keys"), false);
  assert.equal(hasPermission("agent", "manage_budgets"), false);
});

test("admin still holds every permission, including the new audit_read", () => {
  for (const p of ["read", "write", "manage_keys", "manage_budgets", "approve_quarantine", "audit_read"]) {
    assert.equal(hasPermission("admin", p), true, `admin should hold '${p}'`);
  }
});

test("hasPermission with an array argument is any-of: auditor matches ['read','audit_read']", () => {
  assert.equal(hasPermission("auditor", ["read", "audit_read"]), true);
  assert.equal(hasPermission("viewer", ["read", "audit_read"]), true);
  assert.equal(hasPermission("agent", ["read", "audit_read"]), false);
});

test("existing roles are unchanged by this pass (budget-manager, developer, viewer)", () => {
  assert.deepEqual(ROLE_PERMISSIONS["budget-manager"], ["read", "manage_budgets"]);
  assert.deepEqual(ROLE_PERMISSIONS.developer, ["read", "write"]);
  assert.deepEqual(ROLE_PERMISSIONS.viewer, ["read"]);
});

// ---- 2. Route-wiring tests ----

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const keysRoute = require("../server/routes/keys");
const authRoute = require("../server/routes/auth");
const auditRoute = require("../server/routes/audit");
const alertsRoute = require("../server/routes/alerts");
const reconcileRoute = require("../server/routes/reconcile");
const billingRoute = require("../server/routes/billing");
const toolCallsRoute = require("../server/routes/toolCalls");
const ingestRoute = require("../server/routes/ingest");
const costsRoute = require("../server/routes/costs");

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/keys", keysRoute);
  app.use("/api/auth", authRoute);
  app.use("/api/audit", auditRoute);
  app.use("/api/alerts", alertsRoute);
  app.use("/api/reconcile", reconcileRoute);
  app.use("/api/billing", billingRoute);
  app.use("/api/tool-calls", toolCallsRoute);
  app.use("/api/ingest", ingestRoute);
  app.use("/api/costs", costsRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  // Close the bootstrap-mode window before any "requires auth" test runs -
  // same convention as newRoutes.test.js.
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, 'bootstrap-closer', 'viewer', 'active')", [
    `fk_bootstrap_closer_rbac_${process.pid}`,
  ]);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[rbac.test.js] Failed to drop test schema: ${err.message}`);
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
async function makeApiKey(role) {
  keyCounter++;
  const key_id = `fk_test_rbac_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `rbac test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

// --- auditor: can reach audit-scoped reads ---

test("auditor CAN read GET /api/audit", async () => {
  const key_id = await makeApiKey("auditor");
  const res = await request("/api/audit", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
});

test("auditor CAN read GET /api/alerts and GET /api/alerts/status", async () => {
  const key_id = await makeApiKey("auditor");
  const res1 = await request("/api/alerts", { headers: { "X-API-Key": key_id } });
  assert.equal(res1.status, 200);
  const res2 = await request("/api/alerts/status", { headers: { "X-API-Key": key_id } });
  assert.equal(res2.status, 200);
});

test("auditor CAN read GET /api/reconcile/report", async () => {
  const key_id = await makeApiKey("auditor");
  const res = await request("/api/reconcile/report", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
});

test("auditor CAN read GET /api/billing/status", async () => {
  const key_id = await makeApiKey("auditor");
  const res = await request("/api/billing/status", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
});

test("auditor CAN read GET /api/tool-calls", async () => {
  const key_id = await makeApiKey("auditor");
  const res = await request("/api/tool-calls", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
});

// --- auditor: gets 403 on writes, and on non-audit-scoped reads ---

test("auditor gets 403 on a write route (POST /api/keys)", async () => {
  const key_id = await makeApiKey("auditor");
  const res = await request("/api/keys", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { label: "should not be created" },
  });
  assert.equal(res.status, 403);
});

test("auditor gets 403 on general dashboard reads it does not hold 'read' for (GET /api/costs/summary)", async () => {
  const key_id = await makeApiKey("auditor");
  const res = await request("/api/costs/summary", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 403);
});

test("auditor gets 403 on GET /api/keys (key management is not audit evidence)", async () => {
  const key_id = await makeApiKey("auditor");
  const res = await request("/api/keys", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 403);
});

// --- agent: can call the ingest/proxy/tool-call-logging path ---

test("agent CAN call POST /api/ingest", async () => {
  const key_id = await makeApiKey("agent");
  const res = await request("/api/ingest", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { provider: "openai", model: "gpt-4o-mini", input_tokens: 10, output_tokens: 5 },
  });
  assert.equal(res.status, 201);
});

test("agent CAN call POST /api/tool-calls", async () => {
  const key_id = await makeApiKey("agent");
  const res = await request("/api/tool-calls", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { tool_name: "read_file", target: "/tmp/example.txt" },
  });
  assert.equal(res.status, 201);
});

test("agent CAN call POST /api/tool-calls/check (A7 pre-flight)", async () => {
  const key_id = await makeApiKey("agent");
  const res = await request("/api/tool-calls/check", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { tool_name: "read_file", target: "/tmp/example.txt" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.allowed, true);
});

test("auditor CAN view GET /api/tool-calls/approvals (A7 approval queue), but gets 403 deciding one", async () => {
  const key_id = await makeApiKey("auditor");
  const listRes = await request("/api/tool-calls/approvals", { headers: { "X-API-Key": key_id } });
  assert.equal(listRes.status, 200);

  const decideRes = await request("/api/tool-calls/approvals/1/approve", {
    method: "POST",
    headers: { "X-API-Key": key_id },
  });
  assert.equal(decideRes.status, 403);
});

// --- agent: gets 403 on admin/dashboard routes ---

test("agent gets 403 on GET /api/keys (no dashboard read access)", async () => {
  const key_id = await makeApiKey("agent");
  const res = await request("/api/keys", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 403);
});

test("agent gets 403 on POST /api/keys (no manage_keys)", async () => {
  const key_id = await makeApiKey("agent");
  const res = await request("/api/keys", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { label: "should not be created" },
  });
  assert.equal(res.status, 403);
});

test("agent gets 403 on GET /api/costs/summary (no general read access)", async () => {
  const key_id = await makeApiKey("agent");
  const res = await request("/api/costs/summary", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 403);
});

// --- dashboard-account creation rejects 'agent' ---

test("POST /api/auth/register rejects role='agent' for a dashboard account", async () => {
  const adminKey = await makeApiKey("admin");
  const res = await request("/api/auth/register", {
    method: "POST",
    headers: { "X-API-Key": adminKey },
    body: { username: `agent-account-${process.pid}`, password: "password123", role: "agent" },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /invalid role/i);
});

test("POST /api/auth/register accepts role='auditor' for a dashboard account", async () => {
  const adminKey = await makeApiKey("admin");
  const res = await request("/api/auth/register", {
    method: "POST",
    headers: { "X-API-Key": adminKey },
    body: { username: `auditor-account-${process.pid}`, password: "password123", role: "auditor" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.role, "auditor");
});

// --- API-key creation accepts both new roles ---

test("POST /api/keys accepts role='auditor' and role='agent'", async () => {
  const adminKey = await makeApiKey("admin");
  const auditorRes = await request("/api/keys", {
    method: "POST",
    headers: { "X-API-Key": adminKey },
    body: { label: "auditor key", role: "auditor" },
  });
  assert.equal(auditorRes.status, 201);
  assert.equal(auditorRes.json.role, "auditor");

  const agentRes = await request("/api/keys", {
    method: "POST",
    headers: { "X-API-Key": adminKey },
    body: { label: "agent key", role: "agent" },
  });
  assert.equal(agentRes.status, 201);
  assert.equal(agentRes.json.role, "agent");
});

test("POST /api/keys still rejects an unknown role", async () => {
  const adminKey = await makeApiKey("admin");
  const res = await request("/api/keys", {
    method: "POST",
    headers: { "X-API-Key": adminKey },
    body: { label: "bogus role key", role: "superuser" },
  });
  assert.equal(res.status, 400);
});
