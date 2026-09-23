// test/tenantQuota.test.js - per-tenant resource quotas (max_api_keys,
// max_budgets, max_monthly_events). Requires Postgres - multi-tenancy has
// no SQLite equivalent, and single-tenant mode is intentionally untouched
// by this module (checked directly below, not through HTTP).

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

if (!isPostgres) {
  test("tenantQuota suite requires Postgres - skipped under SQLite", { skip: true }, () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_tenant_quota_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const keysRoute = require("../server/routes/keys");
  const budgetsRoute = require("../server/routes/budgets");
  const ingestRoute = require("../server/routes/ingest");
  const { checkApiKeyQuota, checkBudgetQuota, checkMonthlyEventQuota } = require("../server/tenantQuota");

  const createdSchemas = [];
  let server;

  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/keys", keysRoute);
    app.use("/api/budgets", budgetsRoute);
    app.use("/api/ingest", ingestRoute);
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
      console.warn(`[tenantQuota.test.js] cleanup failed: ${err.message}`);
    }
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
  });

  async function makeTenant(name, limits = {}) {
    const tenant = await tenancy.createTenant({ name, ...limits });
    createdSchemas.push(tenant.schema_name);
    return tenant;
  }

  function req(method, pathName, { headers = {}, body } = {}) {
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
  const get = (p, headers) => req("GET", p, { headers });
  const post = (p, body, headers) => req("POST", p, { headers, body });

  test("max_api_keys: the Nth+1 key creation is rejected with 429, the first N succeed", async () => {
    const tenant = await makeTenant(`Quota-Keys-${process.pid}`, { max_api_keys: 2 });
    // createTenant's own bootstrap doesn't create a key, so the tenant starts at 0 keys.
    const adminKey = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "admin", role: "admin" });

    // adminKey itself counts toward the quota (1 of 2 used already).
    const second = await post("/api/keys", { label: "second key" }, { "X-API-Key": adminKey.key_id });
    assert.equal(second.status, 201, "the 2nd key (within the limit of 2) should succeed");

    const third = await post("/api/keys", { label: "third key" }, { "X-API-Key": adminKey.key_id });
    assert.equal(third.status, 429, "the 3rd key (over the limit of 2) must be rejected");
    assert.match(third.body.error, /API key limit/);

    const keys = await get("/api/keys", { "X-API-Key": adminKey.key_id });
    assert.equal(keys.body.length, 2, "exactly 2 keys should exist - the rejected 3rd must not have been created");
  });

  test("max_budgets: the Nth+1 budget creation is rejected with 429, the first N succeed", async () => {
    const tenant = await makeTenant(`Quota-Budgets-${process.pid}`, { max_budgets: 1 });
    const adminKey = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "admin", role: "admin" });

    const first = await post("/api/budgets", { scope_type: "team", scope_value: "a", monthly_limit_usd: 10 }, { "X-API-Key": adminKey.key_id });
    assert.equal(first.status, 201);

    const second = await post("/api/budgets", { scope_type: "team", scope_value: "b", monthly_limit_usd: 10 }, { "X-API-Key": adminKey.key_id });
    assert.equal(second.status, 429, "the 2nd budget (over the limit of 1) must be rejected");
    assert.match(second.body.error, /budget limit/);

    const budgets = await get("/api/budgets", { "X-API-Key": adminKey.key_id });
    assert.equal(budgets.body.length, 1);
  });

  test("max_monthly_events: ingest is rejected with 429 once the monthly event count is reached", async () => {
    const tenant = await makeTenant(`Quota-Events-${process.pid}`, { max_monthly_events: 2 });
    const adminKey = await tenancy.createTenantApiKey({ tenant_id: tenant.id, label: "admin", role: "admin" });

    const eventBody = { provider: "openai", model: "gpt-4o-mini", team: "quota-team", environment: "production", input_tokens: 100, output_tokens: 50 };
    const first = await post("/api/ingest", eventBody, { "X-API-Key": adminKey.key_id });
    assert.equal(first.status, 201);
    const second = await post("/api/ingest", eventBody, { "X-API-Key": adminKey.key_id });
    assert.equal(second.status, 201);

    const third = await post("/api/ingest", eventBody, { "X-API-Key": adminKey.key_id });
    assert.equal(third.status, 429, "the 3rd event (over the limit of 2) must be rejected");
    assert.match(third.body.error, /monthly usage-event limit/);

    const dbTenant = await tenancy.getTenantDb(tenant.schema_name);
    const events = await dbTenant.all("SELECT * FROM usage_events");
    assert.equal(events.length, 2, "exactly 2 events should be recorded - the rejected 3rd must not have been inserted");
  });

  test("a tenant's quota is completely independent of another tenant's usage", async () => {
    const tenantA = await makeTenant(`Quota-IsoA-${process.pid}`, { max_budgets: 1 });
    const tenantB = await makeTenant(`Quota-IsoB-${process.pid}`, { max_budgets: 1 });
    const keyA = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "a", role: "admin" });
    const keyB = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "b", role: "admin" });

    const a1 = await post("/api/budgets", { scope_type: "team", scope_value: "a1", monthly_limit_usd: 10 }, { "X-API-Key": keyA.key_id });
    assert.equal(a1.status, 201, "tenant A's own budget count, not tenant B's, should gate tenant A");

    // Tenant B independently gets its own 1-budget allowance too - A being
    // "full" must not affect B, and vice versa.
    const b1 = await post("/api/budgets", { scope_type: "team", scope_value: "b1", monthly_limit_usd: 10 }, { "X-API-Key": keyB.key_id });
    assert.equal(b1.status, 201, "tenant B must get its own independent quota, unaffected by tenant A being full");

    const a2 = await post("/api/budgets", { scope_type: "team", scope_value: "a2", monthly_limit_usd: 10 }, { "X-API-Key": keyA.key_id });
    assert.equal(a2.status, 429, "tenant A is now over ITS OWN limit");
  });

  test("single-tenant mode (no req.tenantId): every quota check is a no-op allow", async () => {
    const fakeReq = { tenantId: undefined, tenantLimits: undefined };
    assert.deepEqual((await checkApiKeyQuota(fakeReq)).allowed, true);
    assert.deepEqual((await checkBudgetQuota(fakeReq)).allowed, true);
    assert.deepEqual((await checkMonthlyEventQuota(fakeReq)).allowed, true);
  });

  test("a tenant with no explicit limit override still gets the schema's default limits enforced", async () => {
    // makeTenant with no limits passed -> falls back to the DEFAULT columns
    // set in schema.controlPlane.js (20/50/200000) - confirms the defaults
    // actually apply, not just explicit per-tenant overrides.
    const tenant = await makeTenant(`Quota-Defaults-${process.pid}`);
    const status = await tenancy.getTenantStatus(tenant.id);
    assert.equal(status.max_api_keys, 20);
    assert.equal(status.max_budgets, 50);
    assert.equal(status.max_monthly_events, 200000);
  });
}
