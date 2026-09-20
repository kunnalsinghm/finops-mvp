// test/multiTenantIsolation.test.js
//
// tenancy.test.js proves the CONTROL PLANE + auth resolution mechanism
// works, using its own throwaway demo routes. This file proves the REAL
// production routes - the ones an actual customer hits - are correctly
// tenant-scoped now that they've been converted to use req.db/
// req.controlPlaneDb instead of a single global database. Two tenants,
// real HTTP requests, real route files, real requireAuth middleware.
//
// Requires Postgres (FINOPS_DB_DRIVER=postgres) - multi-tenant mode has
// no SQLite equivalent, per tenancy.js's header comment.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

if (!isPostgres) {
  test("multi-tenant isolation suite requires Postgres - skipped under SQLite", { skip: true }, () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_control_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const { requireAuth } = require("../server/auth");
  const proxyRoute = require("../server/routes/proxy");
  const costsRoute = require("../server/routes/costs");
  const budgetsRoute = require("../server/routes/budgets");
  const keysRoute = require("../server/routes/keys");
  const cacheRoute = require("../server/routes/cache");
  const ingestRoute = require("../server/routes/ingest");

  let server;
  let tenantA, tenantB, keyA, keyB;

  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/proxy", proxyRoute);
    app.use("/api/ingest", ingestRoute);
    app.use("/api/costs", costsRoute);
    app.use("/api/budgets", budgetsRoute);
    app.use("/api/keys", keysRoute);
    app.use("/api/cache", cacheRoute);

    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });

    tenantA = await tenancy.createTenant({ name: `Tenant A ${process.pid}` });
    tenantB = await tenancy.createTenant({ name: `Tenant B ${process.pid}` });
    keyA = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "A key", role: "admin" });
    keyB = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "B key", role: "admin" });
  });

  test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { controlPlanePool } = tenancy.initControlPlane();
    try {
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${tenantA.schema_name} CASCADE`);
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${tenantB.schema_name} CASCADE`);
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`);
    } catch (err) {
      console.warn(`[multiTenantIsolation] cleanup failed: ${err.message}`);
    }
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
  });

  function request(method, pathName, { headers = {}, body } = {}) {
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
            try {
              json = JSON.parse(text);
            } catch {
              json = text;
            }
            resolve({ status: res.statusCode, body: json });
          });
        }
      );
      req.on("error", reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }
  const get = (p, opts) => request("GET", p, opts);
  const post = (p, opts) => request("POST", p, opts);

  test("ingested usage events never cross tenant boundaries in cost summaries", async () => {
    await post("/api/ingest", {
      headers: { "X-API-Key": keyA.key_id },
      body: { provider: "openai", model: "gpt-4o-mini", team: "growth", environment: "production", input_tokens: 1000, output_tokens: 500 },
    });
    await post("/api/ingest", {
      headers: { "X-API-Key": keyB.key_id },
      body: { provider: "anthropic", model: "claude-haiku", team: "growth", environment: "production", input_tokens: 1000, output_tokens: 500 },
    });

    const summaryA = await get("/api/costs/by-model", { headers: { "X-API-Key": keyA.key_id } });
    const summaryB = await get("/api/costs/by-model", { headers: { "X-API-Key": keyB.key_id } });

    assert.ok(summaryA.body.some((r) => r.provider === "openai"), "tenant A should see its own openai event");
    assert.ok(!summaryA.body.some((r) => r.provider === "anthropic"), "tenant A must NOT see tenant B's anthropic event");

    assert.ok(summaryB.body.some((r) => r.provider === "anthropic"), "tenant B should see its own anthropic event");
    assert.ok(!summaryB.body.some((r) => r.provider === "openai"), "tenant B must NOT see tenant A's openai event");
  });

  test("budgets are isolated per tenant", async () => {
    await post("/api/budgets", {
      headers: { "X-API-Key": keyA.key_id },
      body: { scope_type: "team", scope_value: "growth", monthly_limit_usd: 500 },
    });

    const budgetsA = await get("/api/budgets", { headers: { "X-API-Key": keyA.key_id } });
    const budgetsB = await get("/api/budgets", { headers: { "X-API-Key": keyB.key_id } });

    assert.equal(budgetsA.body.length, 1, "tenant A should see the budget it created");
    assert.equal(budgetsB.body.length, 0, "tenant B must NOT see tenant A's budget");
  });

  test("api keys are isolated per tenant (control-plane tenant_id scoping)", async () => {
    await post("/api/keys", {
      headers: { "X-API-Key": keyA.key_id },
      body: { label: "A second key", role: "viewer" },
    });

    const keysA = await get("/api/keys", { headers: { "X-API-Key": keyA.key_id } });
    const keysB = await get("/api/keys", { headers: { "X-API-Key": keyB.key_id } });

    assert.equal(keysA.body.length, 2, "tenant A should see both of its own keys (admin + viewer)");
    assert.equal(keysB.body.length, 1, "tenant B must NOT see tenant A's keys - only its own");
    assert.ok(keysB.body.every((k) => k.key_id === keyB.key_id));
  });

  test("a tenant cannot quarantine, approve, or revoke another tenant's key by guessing its id", async () => {
    const revokeAttempt = await post(`/api/keys/${keyB.key_id}/revoke`, { headers: { "X-API-Key": keyA.key_id } });
    assert.equal(revokeAttempt.status, 404, "tenant A targeting tenant B's key_id must be rejected as not-found, not silently succeed");

    const quarantineAttempt = await post(`/api/keys/${keyB.key_id}/quarantine`, { headers: { "X-API-Key": keyA.key_id }, body: {} });
    assert.equal(quarantineAttempt.status, 404);

    // Confirm tenant B's key genuinely still works after the attack attempt.
    const stillWorks = await get("/api/costs/by-model", { headers: { "X-API-Key": keyB.key_id } });
    assert.equal(stillWorks.status, 200, "tenant B's key must still be fully active - the cross-tenant attempts above must not have affected it");
  });

  test("exact-match cache never returns one tenant's cached response to another", async (t) => {
    const identicalBody = { model: "gpt-4o-mini", messages: [{ role: "user", content: "cross-tenant cache probe" }] };

    let callCount = 0;
    t.mock.method(global, "fetch", async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: `response #${callCount}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    });

    const respA1 = await post("/api/proxy/openai", {
      headers: { "X-API-Key": keyA.key_id, "X-Provider-Key": "sk-fake", "X-Enable-Cache": "true" },
      body: identicalBody,
    });
    // Tenant B makes the BYTE-IDENTICAL request. If the cache leaked across
    // tenants, this would return tenant A's cached response (call count
    // would stay at 1) instead of hitting the (mocked) provider again.
    const respB1 = await post("/api/proxy/openai", {
      headers: { "X-API-Key": keyB.key_id, "X-Provider-Key": "sk-fake", "X-Enable-Cache": "true" },
      body: identicalBody,
    });

    assert.equal(callCount, 2, "an identical request from a DIFFERENT tenant must not be served from the first tenant's cache");
    assert.notEqual(
      respA1.body.choices[0].message.content,
      respB1.body.choices[0].message.content,
      "tenant B must get its own provider response, not tenant A's cached one"
    );

    // Now tenant A repeats its OWN request - THIS should hit the cache.
    const respA2 = await post("/api/proxy/openai", {
      headers: { "X-API-Key": keyA.key_id, "X-Provider-Key": "sk-fake", "X-Enable-Cache": "true" },
      body: identicalBody,
    });
    assert.equal(callCount, 2, "tenant A's own repeated request should hit its own cache, not call the provider again");
    assert.equal(respA2.body.choices[0].message.content, respA1.body.choices[0].message.content);
  });
}
