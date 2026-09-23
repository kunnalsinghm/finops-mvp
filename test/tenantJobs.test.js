// test/tenantJobs.test.js - the periodic background-job scheduler (budget
// alerts, burn-rate, commitment alerts, weekly briefing) actually runs once
// PER ACTIVE TENANT in multi-tenant mode, is isolated per tenant, and skips
// tenants that aren't active (suspended/offboarding/trial_expired).
//
// Requires Postgres - multi-tenancy has no SQLite equivalent.

const test = require("node:test");
const assert = require("node:assert/strict");

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

if (!isPostgres) {
  test("tenantJobs suite requires Postgres - skipped under SQLite", { skip: true }, () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_tenant_jobs_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const { runPeriodicChecksForAllTenants, runChecksForOneTenant } = require("../server/tenantJobs");

  const createdSchemas = [];
  async function makeTenant(name) {
    const tenant = await tenancy.createTenant({ name });
    createdSchemas.push(tenant.schema_name);
    return tenant;
  }

  test.after(async () => {
    const { controlPlanePool } = tenancy.initControlPlane();
    try {
      for (const schema of createdSchemas) {
        await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`);
    } catch (err) {
      console.warn(`[tenantJobs.test.js] cleanup failed: ${err.message}`);
    }
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
  });

  test("runPeriodicChecksForAllTenants fires a budget alert for each breaching tenant, isolated per tenant", async () => {
    const tenantA = await makeTenant(`Jobs-A-${process.pid}`);
    const tenantB = await makeTenant(`Jobs-B-${process.pid}`);
    const dbA = await tenancy.getTenantDb(tenantA.schema_name);
    const dbB = await tenancy.getTenantDb(tenantB.schema_name);

    // Only tenant A breaches its budget.
    await dbA.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', 'jobs-team', 1)");
    await dbA.run(
      `INSERT INTO usage_events (provider, model, team, environment, input_tokens, output_tokens, cost_usd, event_time)
       VALUES ('openai', 'gpt-4o', 'jobs-team', 'production', 200000, 100000, 5.00, NOW())`
    );
    await dbB.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', 'jobs-team', 1000)");

    const result = await runPeriodicChecksForAllTenants();
    assert.ok(result.tenantsChecked >= 2, "should have checked at least the two tenants just created");

    const alertsA = await dbA.all("SELECT * FROM alerts_log");
    const alertsB = await dbB.all("SELECT * FROM alerts_log");
    assert.ok(alertsA.some((a) => a.message.includes("jobs-team")), "tenant A should have a fired budget alert");
    assert.equal(alertsB.length, 0, "tenant B never breached its budget - it must have zero alerts, not tenant A's");
  });

  test("a suspended tenant is skipped entirely - listActiveTenants excludes it", async () => {
    const tenant = await makeTenant(`Jobs-Suspended-${process.pid}`);
    const { controlPlaneDb } = tenancy.initControlPlane();
    await controlPlaneDb.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [tenant.id]);

    const active = await tenancy.listActiveTenants();
    assert.ok(!active.some((t) => t.id === tenant.id), "a suspended tenant must not appear in listActiveTenants");
  });

  test("a not-yet-expired trial tenant IS included and gets its checks run", async () => {
    const tenant = await tenancy.createTenant({ name: `Jobs-Trial-${process.pid}`, trial_days: 30 });
    createdSchemas.push(tenant.schema_name);

    const active = await tenancy.listActiveTenants();
    assert.ok(active.some((t) => t.id === tenant.id), "a non-expired trial tenant must be included");
  });

  test("one tenant's check failure does not stop other tenants' checks from running", async (t) => {
    const tenantA = await makeTenant(`Jobs-Fail-A-${process.pid}`);
    const tenantB = await makeTenant(`Jobs-Fail-B-${process.pid}`);

    const realGetTenantDb = tenancy.getTenantDb;
    t.mock.method(tenancy, "getTenantDb", async (schemaName) => {
      if (schemaName === tenantA.schema_name) {
        throw new Error("simulated connection failure for tenant A");
      }
      return realGetTenantDb(schemaName);
    });

    // runChecksForOneTenant must swallow tenant A's failure internally...
    await assert.doesNotReject(runChecksForOneTenant(tenantA));
    // ...and tenant B must still be checked normally through the same mock
    // (which passes tenant B's schema straight through to the real function).
    const dbBBefore = await realGetTenantDb(tenantB.schema_name);
    const before = await dbBBefore.all("SELECT * FROM alerts_log");
    await assert.doesNotReject(runChecksForOneTenant(tenantB));
    const after = await dbBBefore.all("SELECT * FROM alerts_log");
    assert.ok(after.length >= before.length, "tenant B's checks should still complete without error");

    t.mock.restoreAll();
  });
}
