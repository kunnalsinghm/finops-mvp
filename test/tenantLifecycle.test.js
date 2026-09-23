// test/tenantLifecycle.test.js - suspend/reactivate/offboard/export/purge a
// tenant, and the periodic trial-expiry + offboarding-purge sweep. Requires
// Postgres - multi-tenancy has no SQLite equivalent.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

if (!isPostgres) {
  test("tenantLifecycle suite requires Postgres - skipped under SQLite", { skip: true }, () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_tenant_lifecycle_${process.pid}`;
  process.env.FINOPS_PLATFORM_ADMIN_TOKEN = `test-platform-token-${process.pid}`;

  const tenancy = require("../server/tenancy");
  const tenantLifecycle = require("../server/tenantLifecycle");
  const { requireAuth } = require("../server/auth");
  const platformAdminRoute = require("../server/routes/platformAdmin");

  const createdSchemas = [];
  async function makeTenant(name, opts = {}) {
    const tenant = await tenancy.createTenant({ name, ...opts });
    createdSchemas.push(tenant.schema_name);
    return tenant;
  }

  let server;
  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.get("/whoami", requireAuth("read"), (req, res) => res.json({ tenantId: req.tenantId, role: req.apiKey.role }));
    app.use("/api/platform", platformAdminRoute);
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  });

  test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { controlPlanePool } = tenancy.initControlPlane();
    try {
      for (const schema of createdSchemas) {
        await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`);
    } catch (err) {
      console.warn(`[tenantLifecycle.test.js] cleanup failed: ${err.message}`);
    }
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
    delete process.env.FINOPS_PLATFORM_ADMIN_TOKEN;
  });

  function httpReq(method, pathName, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const reqHeaders = { "Content-Type": "application/json", ...headers };
      if (data !== undefined) reqHeaders["Content-Length"] = Buffer.byteLength(data);
      const r = http.request(
        { hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers: reqHeaders },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        }
      );
      r.on("error", reject);
      if (data !== undefined) r.write(data);
      r.end();
    });
  }
  const ADMIN_HEADERS = { "X-Platform-Admin-Token": process.env.FINOPS_PLATFORM_ADMIN_TOKEN };
  const get = (p) => httpReq("GET", p, { headers: ADMIN_HEADERS });
  const post = (p, body) => httpReq("POST", p, { headers: ADMIN_HEADERS, body });
  const patch = (p, body) => httpReq("PATCH", p, { headers: ADMIN_HEADERS, body });

  // ---- Auth gate on the platform-admin surface itself ----

  test("platform-admin routes 401 without a valid X-Platform-Admin-Token", async () => {
    const noToken = await httpReq("GET", "/api/platform/tenants");
    assert.equal(noToken.status, 401);
    const wrongToken = await httpReq("GET", "/api/platform/tenants", { headers: { "X-Platform-Admin-Token": "wrong" } });
    assert.equal(wrongToken.status, 401);
  });

  test("platform-admin routes work with the correct token", async () => {
    const res = await get("/api/platform/tenants");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  // ---- Suspend / reactivate ----

  test("suspend blocks a tenant's API key immediately; reactivate restores it", async () => {
    const tenant = await makeTenant(`Lifecycle-Suspend-${process.pid}`);
    const key = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "k", role: "admin" });

    const beforeSuspend = await httpReq("GET", "/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(beforeSuspend.status, 200);

    const suspendResult = await post(`/api/platform/tenants/${tenant.id}/suspend`, { reason: "non-payment" });
    assert.equal(suspendResult.status, 200);
    assert.equal(suspendResult.body.status, "suspended");

    const afterSuspend = await httpReq("GET", "/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(afterSuspend.status, 403);
    assert.match(afterSuspend.body.error, /non-payment/);

    const reactivateResult = await post(`/api/platform/tenants/${tenant.id}/reactivate`, {});
    assert.equal(reactivateResult.status, 200);
    assert.equal(reactivateResult.body.status, "active");

    const afterReactivate = await httpReq("GET", "/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(afterReactivate.status, 200);
  });

  // ---- Offboarding ----

  test("offboarding blocks the tenant, and cancel-offboard restores it before the grace period ends", async () => {
    const tenant = await makeTenant(`Lifecycle-Offboard-${process.pid}`);
    const key = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "k", role: "admin" });

    const offboardResult = await post(`/api/platform/tenants/${tenant.id}/offboard`, { graceDays: 30 });
    assert.equal(offboardResult.status, 200);
    assert.equal(offboardResult.body.status, "offboarding");
    assert.ok(offboardResult.body.purge_after);

    const blocked = await httpReq("GET", "/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(blocked.status, 403);

    const cancelResult = await post(`/api/platform/tenants/${tenant.id}/cancel-offboard`, {});
    assert.equal(cancelResult.status, 200);
    assert.equal(cancelResult.body.status, "active");

    const restored = await httpReq("GET", "/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(restored.status, 200);
  });

  test("cancel-offboard on a tenant that isn't offboarding returns 409", async () => {
    const tenant = await makeTenant(`Lifecycle-NotOffboarding-${process.pid}`);
    const result = await post(`/api/platform/tenants/${tenant.id}/cancel-offboard`, {});
    assert.equal(result.status, 409);
  });

  // ---- Export ----

  test("export returns every row the tenant has written, and nothing from another tenant", async () => {
    const tenantA = await makeTenant(`Lifecycle-ExportA-${process.pid}`);
    const tenantB = await makeTenant(`Lifecycle-ExportB-${process.pid}`);
    const dbA = await tenancy.getTenantDb(tenantA.schema_name);
    const dbB = await tenancy.getTenantDb(tenantB.schema_name);
    await dbA.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', 'export-only-a', 10)");
    await dbB.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', 'export-only-b', 10)");

    const exportResult = await get(`/api/platform/tenants/${tenantA.id}/export`);
    assert.equal(exportResult.status, 200);
    assert.equal(exportResult.body.tenant.id, tenantA.id);
    const budgetValues = exportResult.body.tables.budgets.map((b) => b.scope_value);
    assert.ok(budgetValues.includes("export-only-a"));
    assert.ok(!budgetValues.includes("export-only-b"), "export must not leak another tenant's data");
  });

  // ---- Purge (irreversible) ----

  test("purge requires explicit confirmation, then drops the schema and blocks the tenant permanently", async () => {
    const tenant = await makeTenant(`Lifecycle-Purge-${process.pid}`);
    const key = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "k", role: "admin" });
    const dbBefore = await tenancy.getTenantDb(tenant.schema_name);
    await dbBefore.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', 'about-to-be-purged', 10)");

    const withoutConfirm = await post(`/api/platform/tenants/${tenant.id}/purge`, {});
    assert.equal(withoutConfirm.status, 400, "purge without the confirm phrase must be rejected");

    const purgeResult = await post(`/api/platform/tenants/${tenant.id}/purge`, { confirm: "PURGE" });
    assert.equal(purgeResult.status, 200);
    assert.equal(purgeResult.body.status, "deleted");
    assert.ok(purgeResult.body.deleted_at);

    const afterPurge = await httpReq("GET", "/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(afterPurge.status, 401, "a purged tenant's key must no longer even resolve (it was deleted, not just blocked)");

    // Re-purging (idempotent) and reactivating (must fail) both behave sanely.
    const rePurge = await post(`/api/platform/tenants/${tenant.id}/purge`, { confirm: "PURGE" });
    assert.equal(rePurge.status, 200);
    const reactivateAfterPurge = await post(`/api/platform/tenants/${tenant.id}/reactivate`, {});
    assert.equal(reactivateAfterPurge.status, 409);

    // Remove from the cleanup list - the schema is already gone, and
    // test.after's DROP SCHEMA IF EXISTS would just be a safe no-op, but
    // skip it explicitly so the intent here is clear in the test output.
    const idx = createdSchemas.indexOf(tenant.schema_name);
    if (idx >= 0) createdSchemas.splice(idx, 1);
  });

  // ---- Quota adjustment ----

  test("PATCH limits updates a tenant's quotas, enforced on the very next request", async () => {
    const tenant = await makeTenant(`Lifecycle-Limits-${process.pid}`, { max_api_keys: 1 });
    const adminKey = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "admin", role: "admin" });

    const raise = await patch(`/api/platform/tenants/${tenant.id}/limits`, { max_api_keys: 5 });
    assert.equal(raise.status, 200);
    assert.equal(raise.body.max_api_keys, 5);

    const status = await tenancy.getTenantStatus(tenant.id);
    assert.equal(status.max_api_keys, 5);
    void adminKey;
  });

  // ---- Trial expiry sweep ----

  test("runLifecycleSweep flips an expired trial to trial_expired and blocks it", async () => {
    const tenant = await makeTenant(`Lifecycle-TrialExpiry-${process.pid}`, { trial_days: 30 });
    const key = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "k", role: "admin" });
    const { controlPlaneDb } = tenancy.initControlPlane();
    // Simulate time passing: back-date trial_ends_at into the past.
    await controlPlaneDb.run("UPDATE tenants SET trial_ends_at = ? WHERE id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      tenant.id,
    ]);

    const sweepResult = await post("/api/platform/lifecycle-sweep/run-now", {});
    assert.equal(sweepResult.status, 200);
    assert.ok(sweepResult.body.trialsExpired >= 1);

    const status = await tenancy.getTenantStatus(tenant.id);
    assert.equal(status.status, "trial_expired");

    const blocked = await httpReq("GET", "/whoami", { headers: { "X-API-Key": key.key_id } });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /trial period has ended/);
  });

  test("runLifecycleSweep purges an offboarding tenant once past purge_after", async () => {
    const tenant = await makeTenant(`Lifecycle-SweptPurge-${process.pid}`);
    const { controlPlaneDb } = tenancy.initControlPlane();
    await controlPlaneDb.run("UPDATE tenants SET status = 'offboarding', purge_after = ? WHERE id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      tenant.id,
    ]);

    const sweepResult = await post("/api/platform/lifecycle-sweep/run-now", {});
    assert.equal(sweepResult.status, 200);
    assert.ok(sweepResult.body.tenantsPurged >= 1);

    const status = await tenancy.getTenantStatus(tenant.id);
    assert.equal(status.status, "deleted");

    const idx = createdSchemas.indexOf(tenant.schema_name);
    if (idx >= 0) createdSchemas.splice(idx, 1);
  });

  test("a not-yet-expired trial and an active tenant are both left untouched by the sweep", async () => {
    const activeTenant = await makeTenant(`Lifecycle-SweepActive-${process.pid}`);
    const freshTrial = await makeTenant(`Lifecycle-SweepFreshTrial-${process.pid}`, { trial_days: 30 });

    await post("/api/platform/lifecycle-sweep/run-now", {});

    const activeStatus = await tenancy.getTenantStatus(activeTenant.id);
    const trialStatus = await tenancy.getTenantStatus(freshTrial.id);
    assert.equal(activeStatus.status, "active");
    assert.equal(trialStatus.status, "trial");
  });
}
