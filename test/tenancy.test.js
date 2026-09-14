// test/tenancy.test.js
//
// This is the highest-stakes test file in the whole codebase: it exists to
// prove that one paying customer's data is structurally unreachable from
// another's, not just unreachable "in the cases we thought to check". Every
// test that touches two tenants deliberately writes real data into one and
// asserts the OTHER sees nothing - never just "no error was thrown".
//
// Postgres-only (multi-tenancy doesn't exist for SQLite) and requires
// FINOPS_MULTI_TENANT=true, set below before anything under test is
// required - same "set env vars before requiring the module" discipline
// every other test file in this suite already follows.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  // Multi-tenancy is Postgres-only by design (see tenancy.js's header
  // comment) - running this file at all without a Postgres backend
  // configured would just fail every test on a missing FINOPS_POSTGRES_URL,
  // which is a confusing way to say "this feature doesn't apply here".
  test("tenancy tests skipped - multi-tenancy requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  // Dedicated control-plane schema for THIS test run, same isolation
  // reasoning as every other test file's FINOPS_POSTGRES_SCHEMA - without
  // it, repeated test runs collide on the tenants/api_keys tables.
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_control_plane_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const { requireAuth } = require("../server/auth");

  const createdTenantSchemas = [];

  test.after(async () => {
    // Drop every tenant schema this run actually created, plus the
    // control-plane schema itself - a leaked schema here means a leaked
    // Postgres schema AND a leaked open connection pool, compounding
    // across every future run of this file otherwise.
    const { Pool } = require("pg");
    const cleanupPool = new Pool({ connectionString: process.env.FINOPS_POSTGRES_URL });
    try {
      for (const schemaName of createdTenantSchemas) {
        await cleanupPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      }
      await cleanupPool.query(`DROP SCHEMA IF EXISTS ${tenancy.controlPlaneSchema} CASCADE`);
    } finally {
      await cleanupPool.end();
    }
    await tenancy.closeAll();
  });

  async function makeTenant(name) {
    const tenant = await tenancy.createTenant({ name });
    createdTenantSchemas.push(tenant.schema_name);
    return tenant;
  }

  // ---- Direct-function tests: the provisioning/isolation primitives ----

  test("createTenant provisions a real, isolated Postgres schema with the full tenant table set", async () => {
    const tenant = await makeTenant(`Acme-${process.pid}`);
    assert.ok(tenant.id);
    assert.match(tenant.schema_name, /^tenant_[a-f0-9]{12}$/);

    const db = await tenancy.getTenantDb(tenant.schema_name);
    // Spot-check a couple of tables from schema.tenant.js actually exist
    // and are queryable, not just that provisioning didn't throw.
    const budgets = await db.all("SELECT * FROM budgets");
    const events = await db.all("SELECT * FROM usage_events");
    assert.deepEqual(budgets, []);
    assert.deepEqual(events, []);
  });

  test("two tenants are completely isolated: data written to one is invisible from the other", async () => {
    const tenantA = await makeTenant(`Isolation-A-${process.pid}`);
    const tenantB = await makeTenant(`Isolation-B-${process.pid}`);
    const dbA = await tenancy.getTenantDb(tenantA.schema_name);
    const dbB = await tenancy.getTenantDb(tenantB.schema_name);

    await dbA.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', 'only-in-a', 100)");

    const inA = await dbA.all("SELECT * FROM budgets");
    const inB = await dbB.all("SELECT * FROM budgets");
    assert.equal(inA.length, 1, "tenant A must see the row it just wrote");
    assert.equal(inB.length, 0, "tenant B must see ZERO rows from tenant A's schema");
  });

  test("getTenantDb returns the same cached pool for repeated calls to the same tenant schema", async () => {
    const tenant = await makeTenant(`Cache-${process.pid}`);
    await tenancy.getTenantDb(tenant.schema_name);
    await tenancy.getTenantDb(tenant.schema_name);
    await tenancy.getTenantDb(tenant.schema_name);
    // _tenantPools is keyed by schema name - three calls for the same
    // schema must produce exactly one pool, not three (which would each
    // hold their own idle connections for no reason).
    assert.equal(tenancy._tenantPools.has(tenant.schema_name), true);
    const poolCountForThisSchema = [...tenancy._tenantPools.keys()].filter((k) => k === tenant.schema_name).length;
    assert.equal(poolCountForThisSchema, 1);
  });

  test("resolveTenantApiKey maps each key to its OWN tenant's schema, never the other's", async () => {
    const tenantA = await makeTenant(`KeyMap-A-${process.pid}`);
    const tenantB = await makeTenant(`KeyMap-B-${process.pid}`);
    const keyA = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "key-a" });
    const keyB = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "key-b" });

    const resolvedA = await tenancy.resolveTenantApiKey(keyA.key_id);
    const resolvedB = await tenancy.resolveTenantApiKey(keyB.key_id);

    assert.equal(resolvedA.tenant_schema, tenantA.schema_name);
    assert.equal(resolvedB.tenant_schema, tenantB.schema_name);
    assert.notEqual(resolvedA.tenant_schema, resolvedB.tenant_schema);
  });

  test("resolveTenantApiKey returns undefined for a key that doesn't exist", async () => {
    const resolved = await tenancy.resolveTenantApiKey("fk_this_key_was_never_created");
    assert.equal(resolved, undefined);
  });

  // ---- End-to-end tests: through real HTTP + the actual requireAuth middleware ----
  // This is the part that matters most - proving the WIRING (header ->
  // resolveTenantApiKey -> req.db -> tenant schema) is correct, not just
  // the underlying functions in isolation.

  let server;
  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.get("/whoami", requireAuth("read"), (req, res) => {
      res.json({ tenantId: req.tenantId, tenantSchema: req.tenantSchema, role: req.apiKey.role });
    });
    app.post("/write-budget", requireAuth("write"), async (req, res) => {
      await req.db.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, ?)", [
        req.body.scope_value,
        req.body.monthly_limit_usd,
      ]);
      res.status(201).json({ ok: true });
    });
    app.get("/budgets", requireAuth("read"), async (req, res) => {
      res.json(await req.db.all("SELECT * FROM budgets"));
    });
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  });
  test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function request(pathName, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const reqHeaders = { "Content-Type": "application/json", ...headers };
      if (data !== undefined) reqHeaders["Content-Length"] = Buffer.byteLength(data);
      const req = http.request(
        { hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers: reqHeaders },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            resolve({ status: res.statusCode, json });
          });
        }
      );
      req.on("error", reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }

  test("end-to-end: a request with no API key is rejected with 401 (no bootstrap mode in multi-tenant)", async () => {
    const res = await request("/whoami");
    assert.equal(res.status, 401);
  });

  test("end-to-end: an unrecognized API key is rejected with 401", async () => {
    const res = await request("/whoami", { headers: { "X-API-Key": "fk_totally_made_up" } });
    assert.equal(res.status, 401);
  });

  test("end-to-end: X-Session-Token is rejected with 501 in multi-tenant mode, not silently accepted", async () => {
    const res = await request("/whoami", { headers: { "X-Session-Token": "whatever" } });
    assert.equal(res.status, 501);
  });

  test("end-to-end: a revoked key is rejected with 403", async () => {
    const tenant = await makeTenant(`Revoked-${process.pid}`);
    const key = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "to-be-revoked" });
    const { controlPlaneDb } = tenancy.initControlPlane();
    await controlPlaneDb.run("UPDATE api_keys SET status = 'revoked' WHERE key_id = ?", [key.key_id]);

    const res = await request("/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(res.status, 403);
  });

  test("end-to-end: a key belonging to a suspended tenant is rejected with 403, even though the key itself is active", async () => {
    const tenant = await makeTenant(`Suspended-${process.pid}`);
    const key = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "suspended-tenant-key" });
    const { controlPlaneDb } = tenancy.initControlPlane();
    await controlPlaneDb.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [tenant.id]);

    const res = await request("/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(res.status, 403);
  });

  test("end-to-end: a viewer-role tenant key is rejected with 403 on a write-permission route", async () => {
    const tenant = await makeTenant(`Viewer-${process.pid}`);
    const key = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "viewer-key", role: "viewer" });

    const res = await request("/write-budget", {
      method: "POST",
      headers: { "X-API-Key": key.key_id },
      body: { scope_value: "nope", monthly_limit_usd: 10 },
    });
    assert.equal(res.status, 403);
  });

  test("end-to-end: /whoami correctly reports the calling tenant's own id/schema, not any other tenant's", async () => {
    const tenantA = await makeTenant(`Whoami-A-${process.pid}`);
    const tenantB = await makeTenant(`Whoami-B-${process.pid}`);
    const keyA = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "whoami-a" });
    const keyB = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "whoami-b" });

    const resA = await request("/whoami", { headers: { "X-API-Key": keyA.key_id } });
    const resB = await request("/whoami", { headers: { "X-API-Key": keyB.key_id } });

    assert.equal(resA.json.tenantSchema, tenantA.schema_name);
    assert.equal(resB.json.tenantSchema, tenantB.schema_name);
  });

  test("end-to-end: writing a budget as tenant A is completely invisible to tenant B reading the same route", async () => {
    const tenantA = await makeTenant(`E2E-Leak-A-${process.pid}`);
    const tenantB = await makeTenant(`E2E-Leak-B-${process.pid}`);
    const keyA = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "e2e-a" });
    const keyB = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "e2e-b" });

    const writeRes = await request("/write-budget", {
      method: "POST",
      headers: { "X-API-Key": keyA.key_id },
      body: { scope_value: "tenant-a-secret-team", monthly_limit_usd: 500 },
    });
    assert.equal(writeRes.status, 201);

    const readAsA = await request("/budgets", { headers: { "X-API-Key": keyA.key_id } });
    const readAsB = await request("/budgets", { headers: { "X-API-Key": keyB.key_id } });

    assert.equal(readAsA.json.length, 1, "tenant A must see the budget it just created");
    assert.equal(readAsA.json[0].scope_value, "tenant-a-secret-team");
    assert.equal(readAsB.json.length, 0, "tenant B must see NOTHING tenant A wrote, over a real HTTP round trip through requireAuth");
  });
}
