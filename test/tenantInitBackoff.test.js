// test/tenantInitBackoff.test.js - a failed tenant (or control-plane) schema
// init is retried, but not on EVERY request.
//
// H1a stopped caching a failed init so a fixed migration or a transient error
// no longer needs a restart. Side effect: while a migration keeps failing,
// every request for that tenant re-ran it (advisory lock, BEGIN, the failing
// DDL, ROLLBACK, a new connection pool). A broken tenant under traffic then
// hammers the database. A short backoff keeps the retry but bounds the cost:
// within FINOPS_TENANT_INIT_RETRY_MS the same error is returned without
// touching the database; after it, the next request retries.
//
// Postgres only.

const test = require("node:test");
const assert = require("node:assert/strict");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("init backoff tests skipped - requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  const CP_SCHEMA = `cp_h1c_${process.pid}`;
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = CP_SCHEMA;

  const { Pool } = require("pg");
  const tenancy = require("../server/tenancy");
  const tenantList = require("../server/storage/migrations/tenant");
  const cpList = require("../server/storage/migrations/controlPlane");

  const tenantReal = [...tenantList];
  const cpReal = [...cpList];
  const cpBase = cpReal.length ? cpReal[cpReal.length - 1].version : 1;
  const tenantBase = tenantReal.length ? tenantReal[tenantReal.length - 1].version : 1;
  const fx = (version, name, up) => ({ version, name, up: { postgres: up } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const created = new Set();
  const schemaName = (tag) => {
    const s = `tenant_h1c_${tag}_${process.pid}`.toLowerCase();
    created.add(s);
    return s;
  };

  // A migration that fails while `state.fail` is true and counts every attempt.
  function flaky(version, label) {
    const state = { fail: true, attempts: 0 };
    const m = fx(version, label, async () => {
      state.attempts++;
      if (state.fail) throw new Error(`${label} is broken`);
    });
    return { state, m };
  }

  test.afterEach(async () => {
    delete process.env.FINOPS_TENANT_INIT_RETRY_MS;
    tenantList.splice(0, tenantList.length, ...tenantReal);
    cpList.splice(0, cpList.length, ...cpReal);
    await tenancy.closeAll();
  });

  test.after(async () => {
    await tenancy.closeAll();
    const admin = new Pool({ connectionString: process.env.FINOPS_POSTGRES_URL });
    try {
      for (const s of [...created, CP_SCHEMA]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    } finally { await admin.end(); }
  });

  test("tenant: requests inside the retry window get the same error without re-running the migration", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "60000";
    const { state, m } = flaky(tenantBase + 1, "tenantflaky");
    tenantList.push(m);
    const schema = schemaName("window");
    const messages = [];
    for (let i = 0; i < 6; i++) {
      await assert.rejects(() => tenancy.getTenantDb(schema), (e) => { messages.push(e.message); return true; });
    }
    assert.equal(state.attempts, 1, "the failing migration must run once, not once per request");
    assert.equal(new Set(messages).size, 1, "every request in the window sees the same error");
    assert.match(messages[0], /Tenant schema initialization failed for .*tenantflaky is broken/s);
  });

  test("tenant: after the window the next request retries, and succeeds once the cause is fixed", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "200";
    const { state, m } = flaky(tenantBase + 1, "tenantrecover");
    tenantList.push(m);
    const schema = schemaName("recover");
    await assert.rejects(() => tenancy.getTenantDb(schema));
    await assert.rejects(() => tenancy.getTenantDb(schema));
    assert.equal(state.attempts, 1);
    state.fail = false;
    await sleep(300);
    await tenancy.getTenantDb(schema);
    assert.equal(state.attempts, 2, "retried exactly once after the window");
    await tenancy.getTenantDb(schema); // healthy now: cached, no further attempts
    assert.equal(state.attempts, 2);
  });

  test("tenant: FINOPS_TENANT_INIT_RETRY_MS=0 retries on every request", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "0";
    const { state, m } = flaky(tenantBase + 1, "tenantzero");
    tenantList.push(m);
    const schema = schemaName("zero");
    for (let i = 0; i < 3; i++) await assert.rejects(() => tenancy.getTenantDb(schema));
    assert.equal(state.attempts, 3);
  });

  test("tenant: an invalid setting falls back to the default window", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "soon";
    const { state, m } = flaky(tenantBase + 1, "tenantinvalid");
    tenantList.push(m);
    const schema = schemaName("invalid");
    for (let i = 0; i < 3; i++) await assert.rejects(() => tenancy.getTenantDb(schema));
    assert.equal(state.attempts, 1);
  });

  test("tenant: { force: true } bypasses the window (for operator tooling)", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "60000";
    const { state, m } = flaky(tenantBase + 1, "tenantforce");
    tenantList.push(m);
    const schema = schemaName("force");
    await assert.rejects(() => tenancy.getTenantDb(schema));
    state.fail = false;
    await assert.rejects(() => tenancy.getTenantDb(schema), /tenantforce is broken/, "still inside the window");
    await tenancy.getTenantDb(schema, { force: true });
    assert.equal(state.attempts, 2);
  });

  test("tenant: one tenant's failure does not put another tenant in backoff", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "60000";
    const bad = schemaName("isobad");
    const good = schemaName("isogood");
    let failFor = bad;
    tenantList.push(fx(tenantBase + 1, "isolation", async (db) => {
      const { schema } = await db.get("SELECT current_schema() AS schema");
      if (schema === failFor) throw new Error("only the bad one");
    }));
    await assert.rejects(() => tenancy.getTenantDb(bad));
    await tenancy.getTenantDb(good);
  });

  test("tenant: closeTenantPool forgets a remembered failure", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "60000";
    const { state, m } = flaky(tenantBase + 1, "tenantclose");
    tenantList.push(m);
    const schema = schemaName("close");
    await assert.rejects(() => tenancy.getTenantDb(schema));
    await tenancy.closeTenantPool(schema);
    await assert.rejects(() => tenancy.getTenantDb(schema));
    assert.equal(state.attempts, 2, "closing the tenant (e.g. on purge) must clear the window");
  });

  test("control plane: requests inside the window do not re-run the migration; after it, retry", async () => {
    process.env.FINOPS_TENANT_INIT_RETRY_MS = "200";
    const { state, m } = flaky(cpBase + 1, "cpflaky");
    cpList.push(m);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => tenancy.initControlPlane().controlPlaneReady, /Control-plane schema initialization failed.*cpflaky is broken/s);
    }
    assert.equal(state.attempts, 1, "control-plane init must not be retried on every request");
    state.fail = false;
    await sleep(300);
    await tenancy.initControlPlane().controlPlaneReady;
    assert.equal(state.attempts, 2);
  });
}
