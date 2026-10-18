// test/migrateTenants.test.js - migrate every tenant up front, report per
// tenant, and make a failure on tenant N resumable instead of a mystery (H1b).
//
// Schemas are migrated lazily when a tenant is first opened (H1a). That is
// safe but invisible: nothing says which tenants are behind, and a tenant that
// fails is only discovered when its customer hits an error. This adds
//   - control-plane columns recording each tenant's schema version and last
//     migration error, kept current by the lazy path too, and
//   - migrateAllTenants() / `npm run migrate-tenants`: one tenant at a time,
//     carry on past a failure, report every result, exit non-zero if any failed,
//     idempotent so a re-run only does the remaining work, and --dry-run.
//
// Postgres only. Fixture migrations are registered on the same arrays the
// server reads (see tenantMigrations.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("fleet migration tests skipped - requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  const CP_SCHEMA = `cp_h1b_${process.pid}`;
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = CP_SCHEMA;
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_TENANT_INIT_RETRY_MS = "60000"; // the fleet runner must bypass this window

  const path = require("node:path");
  const os = require("node:os");
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const { Pool } = require("pg");
  const tenancy = require("../server/tenancy");
  const { migrateAllTenants } = require("../server/tenantMigrate");
  const tenantList = require("../server/storage/migrations/tenant");
  const cpList = require("../server/storage/migrations/controlPlane");

  const URL = process.env.FINOPS_POSTGRES_URL;
  const ROOT = path.join(__dirname, "..");
  const CLI_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "finops-migtenants-"));
  const tenantReal = [...tenantList];
  const cpReal = [...cpList];
  const T0 = [1, ...tenantReal.map((m) => m.version)]; // a tenant with only the real migrations applied
  const tTop = T0[T0.length - 1];
  const tBase = tTop;
  const cpBase = cpReal.length ? cpReal[cpReal.length - 1].version : 1;
  const fx = (version, name, up) => ({ version, name, up: { postgres: up } });

  let admin;
  const q = (sql, params) => admin.query(sql, params).then((r) => r.rows);
  const cpTenant = (id) => q(`SELECT * FROM ${CP_SCHEMA}.tenants WHERE id = $1`, [id]).then((r) => r[0]);
  const versionsOf = (schema) => q(`SELECT version FROM ${schema}.schema_migrations ORDER BY version`).then((r) => r.map((x) => x.version));
  const schemaExists = (schema) => q("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema]).then((r) => r.length === 1);

  // Start every test from an empty control plane and no tenant schemas.
  async function reset() {
    await tenancy.closeAll();
    const exists = await q("SELECT to_regclass($1) AS t", [`${CP_SCHEMA}.tenants`]);
    if (exists[0].t) {
      for (const t of await q(`SELECT schema_name FROM ${CP_SCHEMA}.tenants`)) {
        await q(`DROP SCHEMA IF EXISTS ${t.schema_name} CASCADE`);
      }
      await q(`DELETE FROM ${CP_SCHEMA}.tenants`);
    }
  }

  async function makeTenants(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await tenancy.createTenant({ name: `h1b tenant ${i}` }));
    await tenancy.closeAll(); // pools closed so the fleet runner starts cold, like the CLI
    return out;
  }

  test.before(() => { admin = new Pool({ connectionString: URL }); });
  test.beforeEach(reset);
  test.afterEach(() => {
    tenantList.splice(0, tenantList.length, ...tenantReal);
    cpList.splice(0, cpList.length, ...cpReal);
  });
  test.after(async () => {
    await tenancy.closeAll();
    await q(`SELECT schema_name FROM ${CP_SCHEMA}.tenants`).then(async (rows) => {
      for (const t of rows) await q(`DROP SCHEMA IF EXISTS ${t.schema_name} CASCADE`);
    }).catch(() => {});
    await q(`DROP SCHEMA IF EXISTS ${CP_SCHEMA} CASCADE`);
    await admin.end();
    fs.rmSync(CLI_CWD, { recursive: true, force: true });
  });

  const byId = (report) => Object.fromEntries(report.results.map((r) => [r.tenant_id, r]));

  test("control plane migration records schema version and last migration error on tenants", async () => {
    await tenancy.initControlPlane().controlPlaneReady;
    const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tenants'", [CP_SCHEMA])).map((r) => r.column_name);
    for (const c of ["schema_version", "schema_migration_error", "schema_migration_error_at"]) assert.ok(cols.includes(c), `missing column ${c}`);
    const versions = (await q(`SELECT version FROM ${CP_SCHEMA}.schema_migrations ORDER BY version`)).map((r) => r.version);
    assert.ok(versions.includes(2), "control-plane migration 2 applied");
  });

  test("the lazy path keeps the record current: version on success, error on failure, cleared on recovery", async () => {
    const [t] = await makeTenants(1);
    assert.equal((await cpTenant(t.id)).schema_version, tTop, "a new tenant records the version it was created at");

    let broken = true;
    tenantList.push(fx(tBase + 1, "lazyrecord", async () => { if (broken) throw new Error("lazy boom"); }));
    await assert.rejects(() => tenancy.getTenantDb(t.schema_name), /lazy boom/);
    let row = await cpTenant(t.id);
    assert.equal(row.schema_version, tTop, "last good version is kept");
    assert.match(row.schema_migration_error, /lazy boom/);
    assert.ok(row.schema_migration_error_at);

    broken = false;
    await tenancy.getTenantDb(t.schema_name, { force: true });
    row = await cpTenant(t.id);
    assert.equal(row.schema_version, tBase + 1);
    assert.equal(row.schema_migration_error, null);
    assert.equal(row.schema_migration_error_at, null);
  });

  test("migrates every tenant, records each, and closes every pool", async () => {
    const ts = await makeTenants(4);
    tenantList.push(fx(tBase + 1, "fleet_ok", async (db) => { await db.exec("CREATE TABLE IF NOT EXISTS h1b_marker (n INTEGER)"); }));
    const report = await migrateAllTenants();
    assert.deepEqual(report.summary, { total: 4, migrated: 4, current: 0, failed: 0, pending: 0, blocked: 0 });
    const r = byId(report);
    for (const t of ts) {
      assert.equal(r[t.id].outcome, "migrated");
      assert.equal(r[t.id].from, tTop);
      assert.equal(r[t.id].to, tBase + 1);
      assert.deepEqual(r[t.id].applied, [tBase + 1]);
      assert.deepEqual(await versionsOf(t.schema_name), [...T0, tBase + 1]);
      const row = await cpTenant(t.id);
      assert.equal(row.schema_version, tBase + 1);
      assert.equal(row.schema_migration_error, null);
    }
    assert.equal(tenancy._tenantPools.size, 0, "one tenant at a time: no pool is left open");
  });

  test("a second run is a no-op: everything is current, nothing re-applied", async () => {
    await makeTenants(3);
    tenantList.push(fx(tBase + 1, "fleet_idem", async (db) => { await db.run("CREATE TABLE IF NOT EXISTS h1b_idem (n INTEGER)"); await db.run("INSERT INTO h1b_idem VALUES (1)"); }));
    await migrateAllTenants();
    const again = await migrateAllTenants();
    assert.deepEqual(again.summary, { total: 3, migrated: 0, current: 3, failed: 0, pending: 0, blocked: 0 });
    for (const r of again.results) assert.deepEqual(r.applied, []);
  });

  test("a failure on one tenant does not stop the others, is reported and recorded, and a re-run resumes only that tenant", async () => {
    const ts = await makeTenants(5);
    const victim = ts[2];
    let failFor = victim.schema_name;
    tenantList.push(fx(tBase + 1, "fleet_mid", async (db) => {
      const { schema } = await db.get("SELECT current_schema() AS schema");
      if (schema === failFor) throw new Error("tenant 3 is broken");
    }));

    const first = await migrateAllTenants();
    assert.deepEqual(first.summary, { total: 5, migrated: 4, current: 0, failed: 1, pending: 0, blocked: 0 });
    const r = byId(first);
    assert.equal(r[victim.id].outcome, "failed");
    assert.match(r[victim.id].error, /tenant 3 is broken/);
    for (const t of ts.filter((x) => x.id !== victim.id)) {
      assert.equal(r[t.id].outcome, "migrated", "tenants after the failure are still migrated");
      assert.deepEqual(await versionsOf(t.schema_name), [...T0, tBase + 1]);
    }
    const bad = await cpTenant(victim.id);
    assert.equal(bad.schema_version, tTop, "last good version kept");
    assert.match(bad.schema_migration_error, /tenant 3 is broken/);
    assert.ok(bad.schema_migration_error_at);
    assert.deepEqual(await versionsOf(victim.schema_name), T0, "failed migration rolled back");
    assert.equal(tenancy._tenantPools.size, 0);

    failFor = null; // fixed and redeployed; the 60s retry window must not get in the way
    const second = await migrateAllTenants();
    assert.deepEqual(second.summary, { total: 5, migrated: 1, current: 4, failed: 0, pending: 0, blocked: 0 });
    assert.equal(byId(second)[victim.id].outcome, "migrated");
    assert.deepEqual(byId(second)[victim.id].applied, [tBase + 1]);
    const healed = await cpTenant(victim.id);
    assert.equal(healed.schema_version, tBase + 1);
    assert.equal(healed.schema_migration_error, null);
  });

  test("a failure remembered from an ordinary request does not block the fleet runner (force)", async () => {
    // The 60s retry window protects the database from per-request retries. An
    // operator who has just fixed the cause and runs the command must not be
    // answered from that window.
    const [t] = await makeTenants(1);
    let broken = true;
    tenantList.push(fx(tBase + 1, "fleet_force", async () => { if (broken) throw new Error("request-time failure"); }));
    await assert.rejects(() => tenancy.getTenantDb(t.schema_name), /request-time failure/);
    await assert.rejects(() => tenancy.getTenantDb(t.schema_name), /request-time failure/, "precondition: the window is active");
    broken = false;
    const report = await migrateAllTenants();
    assert.equal(byId(report)[t.id].outcome, "migrated");
    assert.equal(report.summary.failed, 0);
  });

  test("--dry-run reports what is pending and applies nothing, including for the control plane", async () => {
    const ts = await makeTenants(2);
    tenantList.push(fx(tBase + 1, "fleet_dry", async (db) => { await db.exec("CREATE TABLE IF NOT EXISTS h1b_dry (n INTEGER)"); }));
    cpList.push(fx(cpBase + 1, "cp_dry", async () => { throw new Error("must not run in a dry run"); }));
    const report = await migrateAllTenants({ dryRun: true });
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.summary, { total: 2, migrated: 0, current: 0, failed: 0, pending: 2, blocked: 0 });
    assert.deepEqual(report.controlPlane.pending, [cpBase + 1]);
    for (const t of ts) {
      const r = byId(report)[t.id];
      assert.equal(r.outcome, "pending");
      assert.deepEqual(r.pending, [tBase + 1]);
      assert.deepEqual(await versionsOf(t.schema_name), T0, "nothing applied");
      assert.equal((await cpTenant(t.id)).schema_version, tTop, "nothing recorded");
    }
    const cpVersions = (await q(`SELECT version FROM ${CP_SCHEMA}.schema_migrations ORDER BY version`)).map((x) => x.version);
    assert.ok(!cpVersions.includes(cpBase + 1), "the control plane was not migrated either");
  });

  test("--dry-run reports a tampered applied migration as blocked instead of throwing", async () => {
    const [t] = await makeTenants(1);
    tenantList.push(fx(tBase + 1, "fleet_tamper", async (db) => { await db.exec("CREATE TABLE IF NOT EXISTS h1b_t (n INTEGER)"); }));
    await migrateAllTenants();
    tenantList.length = 0;
    tenantList.push(fx(tBase + 1, "fleet_tamper", async (db) => { await db.exec("CREATE TABLE IF NOT EXISTS h1b_t (n INTEGER, extra TEXT)"); }));
    const report = await migrateAllTenants({ dryRun: true });
    assert.equal(report.summary.blocked, 1);
    assert.match(byId(report)[t.id].error, /modified after it was applied/);
  });

  test("a tenant whose schema is missing is reported as failed and is NOT recreated", async () => {
    const [a, b] = await makeTenants(2);
    await q(`DROP SCHEMA ${a.schema_name} CASCADE`);
    const report = await migrateAllTenants();
    assert.equal(byId(report)[a.id].outcome, "failed");
    assert.match(byId(report)[a.id].error, /does not exist/);
    assert.equal(await schemaExists(a.schema_name), false, "must not resurrect an empty schema");
    assert.equal(byId(report)[b.id].outcome, "current");
    assert.match((await cpTenant(a.id)).schema_migration_error, /does not exist/);
    const dry = await migrateAllTenants({ dryRun: true });
    assert.equal(byId(dry)[a.id].outcome, "failed");
  });

  test("deleted (purged) tenants are skipped", async () => {
    const [a, b] = await makeTenants(2);
    await q(`UPDATE ${CP_SCHEMA}.tenants SET status = 'deleted' WHERE id = $1`, [a.id]);
    tenantList.push(fx(tBase + 1, "fleet_skip", async () => {}));
    const report = await migrateAllTenants();
    assert.deepEqual(report.results.map((r) => r.tenant_id), [b.id]);
    assert.deepEqual(await versionsOf(a.schema_name), T0, "the deleted tenant's schema is untouched");
  });

  test("tenantId limits the run to one tenant; an unknown id is an error", async () => {
    const [a, b] = await makeTenants(2);
    tenantList.push(fx(tBase + 1, "fleet_one", async () => {}));
    const report = await migrateAllTenants({ tenantId: b.id });
    assert.deepEqual(report.results.map((r) => r.tenant_id), [b.id]);
    assert.deepEqual(await versionsOf(a.schema_name), T0);
    await assert.rejects(() => migrateAllTenants({ tenantId: 987654 }), /No tenant with id 987654/);
  });

  test("if the control plane cannot be migrated, nothing else is touched", async () => {
    const [t] = await makeTenants(1);
    cpList.push(fx(cpBase + 1, "cp_fail", async () => { throw new Error("cp is broken"); }));
    tenantList.push(fx(tBase + 1, "fleet_never", async () => {}));
    await assert.rejects(() => migrateAllTenants(), /Control-plane schema initialization failed.*cp is broken/s);
    assert.deepEqual(await versionsOf(t.schema_name), T0);
  });

  // ---- the command ----------------------------------------------------------

  function cli(args = [], env = {}) {
    const e = { ...process.env, FINOPS_POSTGRES_URL: URL, FINOPS_CONTROL_PLANE_SCHEMA: CP_SCHEMA, FINOPS_MULTI_TENANT: "true", ...env };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
    // Run from an empty directory so a developer's own .env (the script reads
    // one, like the server) cannot change what these tests see.
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "migrate-tenants.js"), ...args], { cwd: CLI_CWD, env: e, encoding: "utf8", timeout: 60000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
  }

  test("CLI: success exits 0 and prints one line per tenant and a summary", async () => {
    const ts = await makeTenants(2);
    const r = cli();
    assert.equal(r.code, 0, r.out);
    for (const t of ts) assert.match(r.out, new RegExp(`tenant ${t.id} \\(${t.schema_name}\\)`));
    assert.match(r.out, /Summary:.*2 tenants/);
    assert.match(r.out, /0 failed/);
  });

  test("CLI: a failing tenant exits 1, names the tenant and the reason, and says how to resume", async () => {
    const [a, b] = await makeTenants(2);
    await q(`DROP SCHEMA ${a.schema_name} CASCADE`);
    const r = cli();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`FAILED.*tenant ${a.id} \\(${a.schema_name}\\)|tenant ${a.id} \\(${a.schema_name}\\).*FAILED`));
    assert.match(r.out, /does not exist/);
    assert.match(r.out, /1 failed/);
    assert.match(r.out, /re-run/i);
    assert.match(r.out, new RegExp(`tenant ${b.id}`), "the healthy tenant is still reported");
  });

  test("CLI: --dry-run exits 0 and says it changed nothing; --json is machine-readable", async () => {
    await makeTenants(1);
    const dry = cli(["--dry-run"]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.stdout.split("\n")[0], /dry run/i, "the first line announces it before anything happens");
    assert.match(dry.out, /nothing changed/i);
    const j = cli(["--dry-run", "--json"]);
    assert.equal(j.code, 0, j.out);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.summary.total, 1);
  });

  test("CLI: usage errors exit 2 without touching anything", async () => {
    await makeTenants(1);
    assert.equal(cli(["--bogus"]).code, 2);
    assert.equal(cli(["--tenant"]).code, 2);
    assert.equal(cli(["--tenant", "abc"]).code, 2);
    const unknown = cli(["--tenant", "987654"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.out, /No tenant with id 987654/);
    const noUrl = cli([], { FINOPS_POSTGRES_URL: undefined });
    assert.equal(noUrl.code, 2);
    assert.match(noUrl.out, /FINOPS_POSTGRES_URL/);
  });
}
