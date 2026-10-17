// test/tenantMigrations.test.js - the per-tenant and control-plane schemas are
// versioned by the same migrator as the single-tenant schema (H1a).
//
// Before this, server/tenancy.js ran a "CREATE TABLE IF NOT EXISTS ... ALTER
// TABLE ADD COLUMN IF NOT EXISTS" script when a tenant pool was first opened.
// That is not recorded, not ordered, not checksummed, and it cannot do a data
// backfill or a rename. Worse, a failed init was cached forever, so one
// failure left that tenant answering 500 until the process restarted.
//
// Postgres only (multi-tenant mode is Postgres only). The real lists are empty
// at baseline, so the tests register fixture migrations on the same arrays
// the server reads, which drives the REAL code path (tenancy -> schemaRunner
// -> migrator), and remove them afterwards.

const test = require("node:test");
const assert = require("node:assert/strict");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("tenant migration tests skipped - requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  const CP_SCHEMA = `cp_h1a_${process.pid}`;
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = CP_SCHEMA;

  const { Pool } = require("pg");
  const tenancy = require("../server/tenancy");
  const migrator = require("../server/storage/migrator");
  const { migrateSchema } = require("../server/storage/schemaRunner");
  const tenantList = require("../server/storage/migrations/tenant");
  const cpList = require("../server/storage/migrations/controlPlane");
  const { TENANT_SCHEMA_SQL } = require("../server/storage/schema.tenant");
  const { SCHEMA_SQL } = require("../server/storage/schema.postgres");

  const URL = process.env.FINOPS_POSTGRES_URL;
  const fx = (version, name, up) => ({ version, name, up: { postgres: up } });
  const marker = (version, table = "h1a_marker") =>
    fx(version, table, async (db) => {
      await db.exec(`CREATE TABLE IF NOT EXISTS ${table} (n INTEGER)`);
      await db.run(`INSERT INTO ${table} (n) VALUES (?)`, [version]);
    });

  const created = new Set();
  const name = (tag) => {
    const s = `tenant_h1a_${tag}_${process.pid}`.toLowerCase();
    created.add(s);
    return s;
  };

  async function withAdmin(fn) {
    const admin = new Pool({ connectionString: URL });
    try { return await fn(admin); } finally { await admin.end(); }
  }
  const versionsOf = (admin, schema) =>
    admin.query(`SELECT version, applied_at FROM ${schema}.schema_migrations ORDER BY version`).then((r) => r.rows);
  const count = (admin, schema, table) =>
    admin.query(`SELECT count(*)::int AS n FROM ${schema}.${table}`).then((r) => r.rows[0].n);

  // Pre-versioning tenant: exactly what the old code left behind.
  async function legacyTenant(admin, schema) {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}, public`);
    await admin.query(TENANT_SCHEMA_SQL);
    await admin.query("RESET search_path");
  }

  test.afterEach(() => {
    tenantList.length = 0;
    cpList.length = 0;
  });

  test.after(async () => {
    await tenancy.closeAll();
    await withAdmin(async (admin) => {
      for (const s of [...created, CP_SCHEMA]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    });
  });

  test("fresh tenant: baseline row, then each registered migration exactly once", async () => {
    const schema = name("fresh");
    tenantList.push(marker(2));
    await tenancy.getTenantDb(schema);
    await withAdmin(async (admin) => {
      assert.deepEqual((await versionsOf(admin, schema)).map((r) => r.version), [1, 2]);
      assert.equal(await count(admin, schema, "h1a_marker"), 1);
    });
  });

  test("a tenant created before versioning is adopted: data kept, new migration applied once, reopening is a no-op", async () => {
    const schema = name("legacy");
    await withAdmin(async (admin) => {
      await legacyTenant(admin, schema);
      await admin.query(
        `INSERT INTO ${schema}.usage_events (event_time, provider, model, cost_usd) VALUES ('2026-01-01T00:00:00Z','openai','gpt-4o',1.5)`
      );
      assert.equal((await admin.query("SELECT to_regclass($1) AS t", [`${schema}.schema_migrations`])).rows[0].t, null, "precondition: no version table");
    });
    tenantList.push(marker(2));
    await tenancy.getTenantDb(schema);
    let first;
    await withAdmin(async (admin) => {
      first = await versionsOf(admin, schema);
      assert.deepEqual(first.map((r) => r.version), [1, 2]);
      assert.equal(await count(admin, schema, "usage_events"), 1, "existing data must survive adoption");
      assert.equal(await count(admin, schema, "h1a_marker"), 1);
    });
    await tenancy.closeTenantPool(schema);
    await tenancy.getTenantDb(schema);
    await withAdmin(async (admin) => {
      assert.deepEqual(await versionsOf(admin, schema), first, "reopen must not re-apply or re-record anything");
      assert.equal(await count(admin, schema, "h1a_marker"), 1);
    });
  });

  test("with the real (empty) list an old tenant just gets its baseline row", async () => {
    const schema = name("emptylist");
    await withAdmin((admin) => legacyTenant(admin, schema));
    await tenancy.getTenantDb(schema);
    await withAdmin(async (admin) => {
      assert.deepEqual((await versionsOf(admin, schema)).map((r) => r.version), [1]);
    });
  });

  test("an edited applied migration is refused for that schema only", async () => {
    const a = name("tamperA");
    const b = name("tamperB");
    const original = fx(2, "tamper", async (db) => { await db.exec("CREATE TABLE IF NOT EXISTS h1a_t (n INTEGER)"); });
    const edited = fx(2, "tamper", async (db) => { await db.exec("CREATE TABLE IF NOT EXISTS h1a_t (n INTEGER, extra TEXT)"); });

    tenantList.push(original);
    await tenancy.getTenantDb(a);
    await tenancy.closeTenantPool(a);

    tenantList.length = 0;
    tenantList.push(edited);
    await assert.rejects(() => tenancy.getTenantDb(a), /Tenant schema initialization failed for .*modified after it was applied/s);
    await tenancy.getTenantDb(b); // a tenant that never applied it is unaffected
    await withAdmin(async (admin) => assert.deepEqual((await versionsOf(admin, b)).map((r) => r.version), [1, 2]));

    tenantList.length = 0;
    tenantList.push(original); // revert the edit: A opens again, so the failure was not cached
    await tenancy.getTenantDb(a);
  });

  test("a failing migration rolls back, leaves other tenants alone, is not cached, and the next request retries", async () => {
    const good = name("failgood");
    const bad = name("failbad");
    tenantList.push(marker(2));
    const goodDb = await tenancy.getTenantDb(good);
    await withAdmin((admin) => legacyTenant(admin, bad));

    tenantList.push(fx(3, "boom", async (db) => {
      await db.exec("CREATE TABLE h1a_half (n INTEGER)");
      throw new Error("boom");
    }));
    const attempt = tenancy.getTenantDb(bad);
    const failedEntry = tenancy._tenantPools.get(bad);
    await assert.rejects(() => attempt, /Tenant schema initialization failed for .*Migration 3 \(boom\) failed and was rolled back/s);
    assert.equal(tenancy._tenantPools.has(bad), false, "a failed init must not stay cached");
    assert.equal(failedEntry.pool.ended, true, "the failed attempt's connections must be released, not leaked");
    await withAdmin(async (admin) => {
      assert.deepEqual((await versionsOf(admin, bad)).map((r) => r.version), [1, 2], "v2 committed, v3 recorded nowhere");
      assert.equal((await admin.query("SELECT to_regclass($1) AS t", [`${bad}.h1a_half`])).rows[0].t, null, "partial DDL rolled back");
    });
    assert.equal((await goodDb.get("SELECT count(*)::int AS n FROM h1a_marker")).n, 1, "the healthy tenant keeps working");

    tenantList.pop(); // the bug is fixed and deployed
    await tenancy.getTenantDb(bad);
    await withAdmin(async (admin) => assert.deepEqual((await versionsOf(admin, bad)).map((r) => r.version), [1, 2]));
  });

  test("concurrent runners: each migration runs exactly once per schema", async () => {
    const schemas = [name("conc1"), name("conc2")];
    await withAdmin(async (admin) => { for (const s of schemas) await legacyTenant(admin, s); });
    const list = [fx(2, "counter", async (db) => {
      await db.exec("CREATE TABLE IF NOT EXISTS h1a_counter (n INTEGER)");
      await db.run("INSERT INTO h1a_counter (n) VALUES (1)");
    })];
    const pools = [];
    try {
      const jobs = [];
      for (const s of schemas) {
        for (let i = 0; i < 8; i++) {
          const pool = new Pool({ connectionString: URL, options: `-c search_path=${s},public`, max: 2 });
          pools.push(pool);
          jobs.push(migrateSchema(pool, "tenant", { migrations: list }));
        }
      }
      await Promise.all(jobs);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
    await withAdmin(async (admin) => {
      for (const s of schemas) {
        assert.equal(await count(admin, s, "h1a_counter"), 1, `${s}: counter must have exactly one row`);
        assert.deepEqual((await versionsOf(admin, s)).map((r) => r.version), [1, 2]);
      }
    });
  });

  test("control plane is versioned the same way, and a failed init is retried, not cached", async () => {
    cpList.push(marker(2, "h1a_cp_marker"));
    const first = tenancy.initControlPlane();
    await first.controlPlaneReady;
    await withAdmin(async (admin) => {
      assert.deepEqual((await versionsOf(admin, CP_SCHEMA)).map((r) => r.version), [1, 2]);
      assert.equal(await count(admin, CP_SCHEMA, "h1a_cp_marker"), 1);
    });
    await tenancy.closeAll();

    cpList.push(fx(3, "cp_boom", async () => { throw new Error("cp boom"); }));
    await assert.rejects(() => tenancy.initControlPlane().controlPlaneReady, /Control-plane schema initialization failed.*Migration 3 \(cp_boom\) failed/s);

    cpList.pop();
    await tenancy.initControlPlane().controlPlaneReady;
    await withAdmin(async (admin) => assert.deepEqual((await versionsOf(admin, CP_SCHEMA)).map((r) => r.version), [1, 2]));
  });

  test("postgres-only migrations validate on their own; both-dialect lists still need both", () => {
    assert.doesNotThrow(() => migrator.validateMigrations([fx(2, "ok", async () => {})], { dialects: ["postgres"] }));
    assert.throws(() => migrator.validateMigrations([fx(2, "ok", async () => {})]), /both up.sqlite and up.postgres/);
    assert.throws(() => migrator.validateMigrations([{ version: 2, name: "x", up: {} }], { dialects: ["postgres"] }), /up.postgres/);
  });

  // ---- parity: the tenant schema must track single-tenant on shared tables ----
  //
  // schema.tenant.js is a hand-maintained copy of the single-tenant schema
  // minus the tables the control plane owns. Nothing enforced that, so a new
  // single-tenant migration could silently never reach tenants. Compare real
  // schemas built the real way. Tables that legitimately exist on one side
  // only are listed here with the reason; adding to this list is a decision.
  const CONTROL_PLANE_OWNED = new Set(["api_keys", "users", "invites"]);

  async function shape(admin, schema) {
    const cols = (await admin.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, column_name`, [schema])).rows;
    const idx = (await admin.query(
      "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname", [schema])).rows;
    const norm = (s) => String(s ?? "").split(`${schema}.`).join("");
    return {
      cols: cols.filter((c) => c.table_name !== "schema_migrations" && !CONTROL_PLANE_OWNED.has(c.table_name))
        .map((c) => `${c.table_name}.${c.column_name} ${c.data_type} null=${c.is_nullable} default=${norm(c.column_default)}`),
      idx: idx.filter((i) => i.tablename !== "schema_migrations" && !CONTROL_PLANE_OWNED.has(i.tablename))
        .map((i) => `${i.tablename} ${i.indexname} ${norm(i.indexdef)}`),
      tables: [...new Set(cols.map((c) => c.table_name))],
    };
  }

  test("PARITY: a fresh tenant schema matches a fresh single-tenant schema on every shared table", async () => {
    const single = name("paritysingle");
    const tenant = name("paritytenant");
    await withAdmin(async (admin) => {
      await admin.query(`CREATE SCHEMA ${single}`);
      const sp = new Pool({ connectionString: URL, options: `-c search_path=${single},public`, max: 2 });
      try {
        await sp.query(SCHEMA_SQL);
        await migrator.runPostgres(sp);
      } finally { await sp.end(); }
      await admin.query(`CREATE SCHEMA ${tenant}`);
      const tp = new Pool({ connectionString: URL, options: `-c search_path=${tenant},public`, max: 2 });
      try {
        await tp.query(TENANT_SCHEMA_SQL);
        await migrateSchema(tp, "tenant");
      } finally { await tp.end(); }

      const a = await shape(admin, single);
      const b = await shape(admin, tenant);
      const only = (x, y) => x.filter((v) => !y.includes(v));
      assert.deepEqual(only(a.cols, b.cols), [], "columns only in single-tenant: a migration did not reach tenants");
      assert.deepEqual(only(b.cols, a.cols), [], "columns only in tenant");
      assert.deepEqual(only(a.idx, b.idx), [], "indexes only in single-tenant");
      assert.deepEqual(only(b.idx, a.idx), [], "indexes only in tenant");
      const missing = a.tables.filter((t) => !b.tables.includes(t) && t !== "schema_migrations" && !CONTROL_PLANE_OWNED.has(t));
      assert.deepEqual(missing, [], "tables only in single-tenant");
    });
  });
}
