// test/platformOverview.test.js - GET /api/platform/overview, the operator's
// read-only cross-tenant health/usage view, driven through the REAL router.
//
// Postgres-only (multi-tenancy doesn't exist on SQLite). It is the only code
// that reads across tenant schemas, so the tests are about exactly that:
//   * numbers are right and each tenant's figures come from ITS OWN schema;
//   * only this calendar month counts (sargable [start, end) range);
//   * a purged tenant is reported, and its schema is NOT resurrected by asking;
//   * one broken tenant does not fail the report;
//   * it is read-only and returns aggregates only (no schema names or keys);
//   * it sits behind the platform-admin token like every other route there.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("platform overview tests skipped - multi-tenancy requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_overview_${process.pid}`;
  const ADMIN_TOKEN = `overview-test-token-${process.pid}`;
  process.env.FINOPS_PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;

  const tenancy = require("../server/tenancy");
  const tenantLifecycle = require("../server/tenantLifecycle");
  const { createTenantUser } = require("../server/tenantUsers");
  const { currentMonthBounds } = require("../server/storage/dialectSql");

  const bounds = currentMonthBounds();
  const createdSchemas = [];
  let cp;
  let A, B, C, D, E;

  async function addEvent(tenant, eventTime, cost) {
    const tdb = await tenancy.getTenantDb(tenant.schema_name);
    await tdb.run("INSERT INTO usage_events (event_time, provider, model, cost_usd) VALUES (?, ?, ?, ?)", [eventTime, "openai", "gpt-4o", cost]);
  }

  test.before(async () => {
    cp = tenancy.initControlPlane().controlPlaneDb;
    A = await tenancy.createTenant({ name: `OvA-${process.pid}`, max_monthly_events: 3 });
    B = await tenancy.createTenant({ name: `OvB-${process.pid}`, trial_days: 3 });
    C = await tenancy.createTenant({ name: `OvC-${process.pid}` });
    D = await tenancy.createTenant({ name: `OvD-${process.pid}` });
    E = await tenancy.createTenant({ name: `OvE-${process.pid}` });
    createdSchemas.push(A.schema_name, B.schema_name, C.schema_name, D.schema_name, E.schema_name);

    // A: three events this month (sum 4.0), plus two that must NOT count -
    // one in an earlier month, one exactly at the (exclusive) end bound.
    await addEvent(A, bounds.start, 1.5);
    await addEvent(A, bounds.start, 2.25);
    await addEvent(A, bounds.start, 0.25);
    await addEvent(A, "2000-01-15T00:00:00.000Z", 100);
    await addEvent(A, bounds.end, 50);
    // B: one event this month.
    await addEvent(B, bounds.start, 10.5);
    // C: no events, then suspended.
    await tenantLifecycle.suspendTenant(C.id, "overview test");
    // D: has data, then purged (schema dropped).
    await addEvent(D, bounds.start, 7);
    await tenantLifecycle.purgeTenant(D.id);
    // E: schema exists but its usage table is broken.
    await cp.exec(`DROP TABLE ${E.schema_name}.usage_events`);

    await tenancy.createTenantApiKey({ tenant_id: A.id, label: "k1", role: "developer" });
    await createTenantUser({ tenant_id: A.id, username: "u1", password: "correct-horse-1", role: "viewer", db: cp });
    await createTenantUser({ tenant_id: A.id, username: "u2", password: "correct-horse-1", role: "viewer", db: cp });
  });

  test.after(async () => {
    const { controlPlanePool } = tenancy.initControlPlane();
    for (const schema of createdSchemas) {
      try { await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch {}
    }
    try { await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`); } catch {}
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
    delete process.env.FINOPS_PLATFORM_ADMIN_TOKEN;
  });

  async function freshServer(t) {
    delete require.cache[require.resolve("../server/routes/platformAdmin")];
    const route = require("../server/routes/platformAdmin");
    const app = express();
    app.use(express.json());
    app.use("/api/platform", route);
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return function get(pathName, token = ADMIN_TOKEN) {
      return new Promise((resolve, reject) => {
        const headers = token ? { "X-Platform-Admin-Token": token } : {};
        http.get({ hostname: "127.0.0.1", port: server.address().port, path: pathName, headers }, (r) => {
          let text = "";
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve({ status: r.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
        }).on("error", reject);
      });
    };
  }

  const byName = (json, tenant) => json.tenants.find((x) => x.id === tenant.id);

  test("per-tenant figures come from that tenant's own schema and only count this calendar month", async (t) => {
    const get = await freshServer(t);
    const res = await get("/api/platform/overview");
    assert.equal(res.status, 200, res.text);
    const a = byName(res.json, A);
    const b = byName(res.json, B);
    assert.equal(a.usage.events_this_month, 3, "earlier-month and end-bound events must not count");
    assert.equal(a.usage.cost_usd_this_month, 4);
    assert.equal(b.usage.events_this_month, 1, "B's figures are B's, not A's");
    assert.equal(b.usage.cost_usd_this_month, 10.5);
    assert.equal(a.usage.last_event_at, bounds.end, "last activity is the latest event of any month");
    assert.equal(a.api_keys, 1);
    assert.equal(a.users, 2);
    assert.equal(b.api_keys, 0);
    assert.deepEqual(res.json.month, bounds);
    assert.equal(res.json.totals.events_this_month, 4, "totals sum only tenants whose usage could be read");
    assert.equal(res.json.totals.cost_usd_this_month, 14.5);
    const order = res.json.tenants.map((x) => x.id);
    assert.ok(order.indexOf(B.id) < order.indexOf(A.id), "highest spend first");
  });

  test("health flags: quota_exceeded, trial_ending_soon, no_events_this_month (live tenants only)", async (t) => {
    const get = await freshServer(t);
    const { json } = await get("/api/platform/overview");
    assert.ok(byName(json, A).flags.includes("quota_exceeded"), "3 events against a limit of 3");
    assert.ok(byName(json, B).flags.includes("trial_ending_soon"));
    assert.ok(!byName(json, B).flags.includes("quota_exceeded"));
    const c = byName(json, C);
    assert.equal(c.status, "suspended");
    assert.equal(c.suspended_reason, "overview test");
    assert.ok(!c.flags.includes("no_events_this_month"), "a suspended tenant being quiet is not news");
    assert.deepEqual(c.usage, { events_this_month: 0, cost_usd_this_month: 0, last_event_at: null });
  });

  test("a purged tenant is reported without usage, and asking does NOT resurrect its schema", async (t) => {
    const get = await freshServer(t);
    const { json } = await get("/api/platform/overview");
    const d = byName(json, D);
    assert.equal(d.status, "deleted");
    assert.equal(d.usage, null);
    assert.equal(d.usage_unavailable, "schema_missing");
    const { rows } = await cp.pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [D.schema_name]);
    assert.equal(rows.length, 0, "the report must not recreate a purged tenant's schema");
  });

  test("one broken tenant does not fail the report", async (t) => {
    const get = await freshServer(t);
    const res = await get("/api/platform/overview");
    assert.equal(res.status, 200);
    const e = byName(res.json, E);
    assert.equal(e.usage, null);
    assert.equal(e.usage_unavailable, "error");
    assert.equal(byName(res.json, A).usage.events_this_month, 3, "other tenants are unaffected");
  });

  test("it is read-only and returns aggregates only", async (t) => {
    const get = await freshServer(t);
    const before = JSON.stringify(await cp.all("SELECT * FROM tenants ORDER BY id"));
    const keysBefore = JSON.stringify(await cp.all("SELECT * FROM api_keys ORDER BY id"));
    const res = await get("/api/platform/overview");
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(await cp.all("SELECT * FROM tenants ORDER BY id")), before, "no tenant row may change");
    assert.equal(JSON.stringify(await cp.all("SELECT * FROM api_keys ORDER BY id")), keysBefore);
    for (const schema of createdSchemas) assert.ok(!res.text.includes(schema), "schema names must not be exposed");
    const key = (await cp.get("SELECT key_id FROM api_keys WHERE tenant_id = ?", [A.id])).key_id;
    assert.ok(!res.text.includes(key), "key ids must not be exposed");
    assert.ok(!/username|password|salt|token_hash/.test(res.text), "no user or credential fields");
  });

  test("status filter, limit and truncation", async (t) => {
    const get = await freshServer(t);
    const suspended = await get("/api/platform/overview?status=suspended");
    assert.deepEqual(suspended.json.tenants.map((x) => x.id), [C.id]);
    assert.equal(suspended.json.totals.tenants_matching, 1);
    assert.equal(suspended.json.totals.truncated, false);
    const two = await get("/api/platform/overview?limit=2");
    assert.equal(two.json.tenants.length, 2);
    assert.equal(two.json.totals.truncated, true);
    assert.ok(two.json.totals.tenants_matching >= 5);
    assert.ok(two.json.totals.tenants_by_status.suspended >= 1, "status counts cover ALL tenants, not just the page");
  });

  test("bad input is a 400, never a 500", async (t) => {
    const get = await freshServer(t);
    for (const q of ["limit=0", "limit=-1", "limit=abc", "limit=1.5", "limit=501", "limit=1&limit=2", "status=nope", "status=a&status=b"]) {
      const res = await get(`/api/platform/overview?${q}`);
      assert.equal(res.status, 400, `${q} -> ${res.status} ${res.text}`);
    }
  });

  test("auth: missing or wrong token is 401, no configured token is a 404", async (t) => {
    const get = await freshServer(t);
    assert.equal((await get("/api/platform/overview", null)).status, 401);
    assert.equal((await get("/api/platform/overview", "wrong")).status, 401);
    delete process.env.FINOPS_PLATFORM_ADMIN_TOKEN;
    try {
      assert.equal((await get("/api/platform/overview")).status, 404);
    } finally {
      process.env.FINOPS_PLATFORM_ADMIN_TOKEN = ADMIN_TOKEN;
    }
  });
}
