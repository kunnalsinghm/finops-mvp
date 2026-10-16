// test/tenancyConcurrentBoot.test.js - several processes initializing the
// MULTI-TENANT schemas at the SAME instant.
//
// Postgres-only. Sibling of postgresConcurrentBoot.test.js, for the two
// places server/tenancy.js creates schemas:
//   1. the control-plane schema (initControlPlane) - every replica of a
//      multi-tenant deployment runs this on first boot;
//   2. a tenant's own schema (getTenantDb -> getTenantPool) - two replicas
//      can both serve the first request for a brand-new tenant at once.
// Both used an unlocked `CREATE SCHEMA IF NOT EXISTS` + `CREATE TABLE IF NOT
// EXISTS` script, which Postgres does not make safe against a concurrent
// identical statement (pg_type_typname_nsp_index / pg_namespace_nspname_index
// / "already exists").
//
// The children are real separate node processes: the race is between
// separate database sessions, and threads in one process share a pool.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("concurrent multi-tenant boot test skipped - requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  const { Pool } = require("pg");
  const ROOT = path.join(__dirname, "..");
  const CHILDREN = 8;
  const ROUNDS = 3;

  const CONTROL_PLANE_CHILD =
    'const t=require("./server/tenancy");' +
    't.initControlPlane().controlPlaneReady' +
    '.then(()=>t.closeAll()).then(()=>process.exit(0))' +
    '.catch(e=>{console.error("CHILD_ERR "+e.message);process.exit(1)})';

  const TENANT_CHILD =
    'const t=require("./server/tenancy");' +
    't.getTenantDb(process.env.CHILD_TENANT_SCHEMA)' +
    '.then(()=>t.closeAll()).then(()=>process.exit(0))' +
    '.catch(e=>{console.error("CHILD_ERR "+e.message);process.exit(1)})';

  function runChild(script, extraEnv) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script], {
        cwd: ROOT,
        env: { ...process.env, FINOPS_MULTI_TENANT: "true", ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdout.on("data", () => {});
      child.on("close", (code) => resolve({ code, err }));
    });
  }

  function firstError(results) {
    const bad = results.find((r) => r.code !== 0);
    return (bad && bad.err.split("\n").find((l) => l.includes("CHILD_ERR"))) || "";
  }

  async function tableCount(admin, schema, table) {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
      [schema, table]
    );
    return rows[0].n;
  }

  test(`REGRESSION: ${CHILDREN} processes initializing the control plane at once on an empty schema all succeed (x${ROUNDS} rounds)`, async () => {
    const admin = new Pool({ connectionString: process.env.FINOPS_POSTGRES_URL });
    const schemas = [];
    try {
      for (let round = 1; round <= ROUNDS; round++) {
        const schema = `conc_cp_${process.pid}_${round}`;
        schemas.push(schema);
        const results = await Promise.all(
          Array.from({ length: CHILDREN }, () => runChild(CONTROL_PLANE_CHILD, { FINOPS_CONTROL_PLANE_SCHEMA: schema }))
        );
        const failures = results.filter((r) => r.code !== 0);
        assert.equal(failures.length, 0, `round ${round}: ${failures.length}/${CHILDREN} failed. First error: ${firstError(results)}`);
        assert.equal(await tableCount(admin, schema, "tenants"), 1, `round ${round}: tenants should exist exactly once`);
        assert.equal(await tableCount(admin, schema, "users"), 1, `round ${round}: users should exist exactly once`);
      }
    } finally {
      for (const s of schemas) {
        try { await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); } catch {}
      }
      await admin.end();
    }
  });

  test(`REGRESSION: ${CHILDREN} processes creating the SAME tenant schema at once all succeed (x${ROUNDS} rounds)`, async () => {
    const admin = new Pool({ connectionString: process.env.FINOPS_POSTGRES_URL });
    const schemas = [];
    try {
      for (let round = 1; round <= ROUNDS; round++) {
        const schema = `tenant_conc_${process.pid}_${round}`;
        schemas.push(schema);
        const results = await Promise.all(
          Array.from({ length: CHILDREN }, () =>
            runChild(TENANT_CHILD, {
              CHILD_TENANT_SCHEMA: schema,
              FINOPS_CONTROL_PLANE_SCHEMA: `conc_cp_unused_${process.pid}`,
            })
          )
        );
        const failures = results.filter((r) => r.code !== 0);
        assert.equal(failures.length, 0, `round ${round}: ${failures.length}/${CHILDREN} failed. First error: ${firstError(results)}`);
        assert.equal(await tableCount(admin, schema, "usage_events"), 1, `round ${round}: usage_events should exist exactly once`);
      }
    } finally {
      for (const s of schemas) {
        try { await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); } catch {}
      }
      await admin.end();
    }
  });
}
