// test/tenants.test.js - the signup endpoint (routes/tenants.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

if (!isPostgres) {
  test("signup endpoint requires multi-tenant mode (Postgres) - returns 404 under single-tenant SQLite", async () => {
    delete require.cache[require.resolve("../server/tenancy")];
    delete require.cache[require.resolve("../server/routes/tenants")];
    const tenantsRoute = require("../server/routes/tenants");
    const app = express();
    app.use(express.json());
    app.use("/api/tenants", tenantsRoute);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ name: "Should not work" });
      const req = http.request(
        { hostname: "127.0.0.1", port: server.address().port, path: "/api/tenants", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    server.close();
    assert.equal(result.status, 404);
  });
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_tenants_route_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const tenantsRoute = require("../server/routes/tenants");
  const costsRoute = require("../server/routes/costs");
  const authRoute = require("../server/routes/auth");

  let server;

  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/tenants", tenantsRoute);
    app.use("/api/costs", costsRoute);
    app.use("/api/auth", authRoute);
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  });

  test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { controlPlanePool } = tenancy.initControlPlane();
    try {
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`);
    } catch (err) {
      console.warn(`[tenants.test.js] cleanup failed: ${err.message}`);
    }
    // Also drop any tenant schemas this file's tests created.
    for (const schema of createdSchemas) {
      try {
        await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } catch {
        /* best-effort cleanup */
      }
    }
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
  });

  const createdSchemas = [];

  function post(pathName, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: pathName,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }
  function get(pathName, headers = {}) {
    return new Promise((resolve, reject) => {
      http
        .request({ hostname: "127.0.0.1", port: server.address().port, path: pathName, method: "GET", headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        })
        .on("error", reject)
        .end();
    });
  }

  test("signup creates a tenant and returns a working admin key", async () => {
    const result = await post("/api/tenants", { name: "Acme Corp", admin_label: "Founder key" });
    assert.equal(result.status, 201);
    assert.match(result.body.api_key, /^fk_/);
    assert.equal(result.body.tenant.name, "Acme Corp");
    assert.equal(result.body.role, "admin");

    const tenantRow = await tenancy.initControlPlane().controlPlaneDb.get("SELECT schema_name FROM tenants WHERE id = ?", [
      result.body.tenant.id,
    ]);
    createdSchemas.push(tenantRow.schema_name);

    // The key must be immediately usable against a real route.
    const check = await get("/api/costs/summary", { "X-API-Key": result.body.api_key });
    assert.equal(check.status, 200);
  });

  test("signup rejects a missing name", async () => {
    const result = await post("/api/tenants", {});
    assert.equal(result.status, 400);
  });

  test("signup rejects an empty/whitespace-only name", async () => {
    const result = await post("/api/tenants", { name: "   " });
    assert.equal(result.status, 400);
  });

  test("two signups produce two independent tenants with independent keys", async () => {
    const a = await post("/api/tenants", { name: "Tenant X" });
    const b = await post("/api/tenants", { name: "Tenant Y" });
    assert.notEqual(a.body.tenant.id, b.body.tenant.id);
    assert.notEqual(a.body.api_key, b.body.api_key);

    const rowA = await tenancy.initControlPlane().controlPlaneDb.get("SELECT schema_name FROM tenants WHERE id = ?", [a.body.tenant.id]);
    const rowB = await tenancy.initControlPlane().controlPlaneDb.get("SELECT schema_name FROM tenants WHERE id = ?", [b.body.tenant.id]);
    createdSchemas.push(rowA.schema_name, rowB.schema_name);
  });

  test("signup with admin_username + admin_password provisions a working dashboard login", async () => {
    const result = await post("/api/tenants", { name: "Dashboard Co", admin_username: "founder", admin_password: "super secret pw" });
    assert.equal(result.status, 201);
    assert.equal(result.body.dashboard_login.username, "founder");

    const tenantRow = await tenancy.initControlPlane().controlPlaneDb.get("SELECT schema_name FROM tenants WHERE id = ?", [result.body.tenant.id]);
    createdSchemas.push(tenantRow.schema_name);

    const login = await post("/api/auth/login", { tenant_id: result.body.tenant.id, username: "founder", password: "super secret pw" });
    assert.equal(login.status, 200);
    assert.equal(login.body.role, "admin");
    assert.ok(login.body.token);

    // The session must actually work against a real protected route.
    const check = await get("/api/costs/summary", { "X-Session-Token": login.body.token });
    assert.equal(check.status, 200);
  });

  test("signup rejects admin_username without admin_password (and vice versa)", async () => {
    const onlyUsername = await post("/api/tenants", { name: "Half Co A", admin_username: "someone" });
    assert.equal(onlyUsername.status, 400);
    const onlyPassword = await post("/api/tenants", { name: "Half Co B", admin_password: "irrelevant123" });
    assert.equal(onlyPassword.status, 400);
  });

  test("signup with trial_days provisions a trial tenant with trial_ends_at set", async () => {
    const result = await post("/api/tenants", { name: "Trial Co", trial_days: 14 });
    assert.equal(result.status, 201);
    assert.equal(result.body.tenant.status, "trial");
    assert.ok(result.body.tenant.trial_ends_at);

    const tenantRow = await tenancy.initControlPlane().controlPlaneDb.get("SELECT schema_name FROM tenants WHERE id = ?", [result.body.tenant.id]);
    createdSchemas.push(tenantRow.schema_name);

    // A trial tenant's key must work like any active tenant's key right now.
    const check = await get("/api/costs/summary", { "X-API-Key": result.body.api_key });
    assert.equal(check.status, 200);
  });
}
