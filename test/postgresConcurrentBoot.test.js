// test/postgresConcurrentBoot.test.js - several processes booting the
// Postgres storage layer at the SAME instant against an EMPTY schema.
//
// Postgres-only. Regression for a startup race: server/storage/postgres.js
// ran the baseline `CREATE TABLE IF NOT EXISTS ...` script with no lock, and
// `CREATE TABLE IF NOT EXISTS` is NOT safe against a concurrent identical
// statement - Postgres can raise
//   duplicate key value violates unique constraint "pg_type_typname_nsp_index"
// (or pg_class_relname_nsp_index / "relation ... already exists"). In
// production that is two replicas booting together against a fresh database;
// in the test suite it is several test files starting in the same parallel
// batch. It was invisible whenever the tables already existed, so it only
// showed up on a brand-new database on a machine running files in parallel.
//
// The children are real separate node processes, because the race is between
// separate database sessions - threads or promises in one process would share
// a pool and never collide.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("concurrent Postgres boot test skipped - requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  const { Pool } = require("pg");
  const ROOT = path.join(__dirname, "..");
  const CHILDREN = 8;
  const ROUNDS = 3;

  const CHILD_SCRIPT =
    'const s=require("./server/storage/postgres");' +
    's.get("select 1 as x").then(()=>process.exit(0))' +
    '.catch(e=>{console.error("CHILD_ERR "+e.message);process.exit(1)})';

  function runChild(schema) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, FINOPS_POSTGRES_SCHEMA: schema },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdout.on("data", () => {});
      child.on("close", (code) => resolve({ code, err }));
    });
  }

  test(`REGRESSION: ${CHILDREN} processes booting at once on an empty schema all initialize cleanly (x${ROUNDS} rounds)`, async () => {
    const admin = new Pool({ connectionString: process.env.FINOPS_POSTGRES_URL });
    const schemas = [];
    try {
      for (let round = 1; round <= ROUNDS; round++) {
        const schema = `conc_boot_${process.pid}_${round}`;
        schemas.push(schema);
        const results = await Promise.all(Array.from({ length: CHILDREN }, () => runChild(schema)));
        const failures = results.filter((r) => r.code !== 0);
        assert.equal(
          failures.length,
          0,
          `round ${round}: ${failures.length}/${CHILDREN} processes failed to initialize. First error: ${(failures[0] && failures[0].err.split("\n").find((l) => l.includes("CHILD_ERR"))) || ""}`
        );
        // And the schema really is complete, not half-built: the baseline
        // table every later query depends on exists exactly once.
        const { rows } = await admin.query(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'usage_events'",
          [schema]
        );
        assert.equal(rows[0].n, 1, `round ${round}: usage_events should exist exactly once`);
      }
    } finally {
      for (const s of schemas) {
        try { await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); } catch {}
      }
      await admin.end();
    }
  });
}
