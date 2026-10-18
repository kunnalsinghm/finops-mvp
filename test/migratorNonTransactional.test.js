// test/migratorNonTransactional.test.js - the migrator's `transaction: false`
// option, the single per-schema lock (polled, never blocked on) and the baseline
// hook.
//
// On Postgres a plain CREATE UNIQUE INDEX takes a lock that blocks every INSERT
// into the table for the whole build; CREATE INDEX CONCURRENTLY does not, but it
// cannot run inside a transaction, and the migrator wraps each migration in one.
// So a migration may declare `transaction: false`; it then must be written to be
// re-run safely, because a crash can leave it half-done and unrecorded.
//
// CREATE INDEX CONCURRENTLY also waits for every other open statement to finish.
// An instance blocked on the migration lock, or re-running the baseline script's
// ALTER TABLE / CREATE INDEX IF NOT EXISTS, is such a statement and is waiting for
// the very instance building the index: a deadlock Postgres resolves by killing
// one of them, i.e. a startup crash. So waiters poll, and the baseline runs only
// for a schema that is not versioned yet, inside the same lock.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const migrator = require("../server/storage/migrator");
const { SCHEMA_SQL } = require("../server/storage/schema.sqlite");
const realMigrations = require("../server/storage/migrations");
const { MigrationError, validateMigrations, runSqlite } = migrator;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
const pgOnly = { skip: isPostgres ? false : "Postgres only (FINOPS_DB_DRIVER=postgres)" };

const tmp = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "finops-eidmig-")); tmp.push(d); return d; };
test.after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

const mig = (version, name, sqliteFn, pgFn = async () => {}, extra = {}) => ({ version, name, ...extra, up: { sqlite: sqliteFn, postgres: pgFn } });

function baselineDb() {
  const file = path.join(tmpDir(), "app.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  return { file, db };
}
const insertSqlite = (db, user, event_id) => {
  if (event_id === undefined) {
    db.prepare("INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged) VALUES ('2026-01-01T00:00:00Z','openai','gpt-4o',?,1,1,0.5,0)").run(user);
  } else {
    db.prepare("INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged,event_id) VALUES ('2026-01-01T00:00:00Z','openai','gpt-4o',?,1,1,0.5,0,?)").run(user, event_id);
  }
};

// ------------------------------------------------------------ the migration
test("validateMigrations: `transaction` must be a boolean when present", () => {
  assert.doesNotThrow(() => validateMigrations([mig(2, "a", () => {}, async () => {}, { transaction: false })]));
  assert.doesNotThrow(() => validateMigrations([mig(2, "a", () => {}, async () => {}, { transaction: true })]));
  assert.throws(() => validateMigrations([mig(2, "a", () => {}, async () => {}, { transaction: "no" })]), /transaction/);
});


test("SQLite ignores transaction:false: a failing migration is still rolled back completely", () => {
  const { db } = baselineDb();
  const bad = mig(2, "half_done", (d) => { d.exec("CREATE TABLE h (n INTEGER)"); throw new Error("boom"); }, async () => {}, { transaction: false });
  assert.throws(() => runSqlite(db, { migrations: [bad], snapshot: false }), (e) => e instanceof MigrationError && /rolled back/.test(e.message));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'h'").get(), undefined);
  db.close();
});

// ------------------------------------------------------------------ Postgres
let Pool, URL, PG_SCHEMA_SQL;
if (isPostgres) {
  ({ Pool } = require("pg"));
  URL = process.env.FINOPS_POSTGRES_URL;
  ({ SCHEMA_SQL: PG_SCHEMA_SQL } = require("../server/storage/schema.postgres"));
}
async function pgScratch(tag, max = 4) {
  const schema = `test_eidmig_${tag}_${process.pid}`;
  const admin = new Pool({ connectionString: URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL, options: `-c search_path=${schema},public`, max });
  await pool.query(PG_SCHEMA_SQL);
  const drop = async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); };
  return { schema, pool, admin, drop };
}
const pgIndex = async (admin, schema, table, column) => (await admin.query(
  `SELECT i.indisunique, i.indisvalid, c2.relname AS index_name FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class c2 ON c2.oid = i.indexrelid
     JOIN pg_namespace ns ON ns.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
    WHERE ns.nspname = $1 AND c.relname = $2 AND a.attname = $3`, [schema, table, column])).rows;
const relfilenode = async (admin, schema, table) => (await admin.query(
  "SELECT c.relfilenode::text AS f FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relname = $2", [schema, table])).rows[0].f;
// Rows as they existed BEFORE migration 14: the column is not there yet.
const pgInsertOld = (pool, user) => pool.query(
  "INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged) VALUES ('2026-01-01T00:00:00Z','openai','gpt-4o',$1,1,1,0.5,0)", [user]);
const pgInsert = (pool, user, event_id = null) => pool.query(
  "INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged,event_id) VALUES ('2026-01-01T00:00:00Z','openai','gpt-4o',$1,1,1,0.5,0,$2)", [user, event_id]);


test("Postgres: transaction:false runs outside a transaction (CREATE INDEX CONCURRENTLY works) and is recorded after it succeeds", pgOnly, async () => {
  const s = await pgScratch("notx");
  try {
    const m = mig(2, "concurrent_index", () => {}, async (db) => {
      await db.exec("CREATE TABLE ct (n INTEGER)");
      await db.exec("CREATE INDEX CONCURRENTLY ct_n ON ct (n)");
    }, { transaction: false });
    const r = await migrator.runPostgres(s.pool, { migrations: [m] });
    assert.deepEqual(r.applied.map((a) => a.version), [2]);
    assert.equal((await s.pool.query("SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = 2")).rows[0].n, 1);
  } finally { await s.drop(); }
});


test("Postgres: the default (transactional) path is unchanged - the same DDL fails and is rolled back", pgOnly, async () => {
  const s = await pgScratch("tx");
  try {
    const m = mig(2, "concurrent_index", () => {}, async (db) => {
      await db.exec("CREATE TABLE ct (n INTEGER)");
      await db.exec("CREATE INDEX CONCURRENTLY ct_n ON ct (n)");
    });
    await assert.rejects(() => migrator.runPostgres(s.pool, { migrations: [m] }), (e) => e instanceof MigrationError && /failed and was rolled back/.test(e.message));
    assert.equal((await s.pool.query("SELECT to_regclass('ct') AS t")).rows[0].t, null);
  } finally { await s.drop(); }
});


test("Postgres: a failing transaction:false migration is NOT recorded, says it may have left partial work, and succeeds when re-run", pgOnly, async () => {
  const s = await pgScratch("notxfail");
  try {
    let broken = true;
    const m = mig(2, "re_runnable", () => {}, async (db) => {
      await db.exec("CREATE TABLE IF NOT EXISTS half (n INTEGER)");
      if (broken) throw new Error("boom");
    }, { transaction: false });
    await assert.rejects(() => migrator.runPostgres(s.pool, { migrations: [m] }),
      (e) => e instanceof MigrationError && e.version === 2 && /not transactional/i.test(e.message) && /boom/.test(e.message) && !/rolled back/.test(e.message));
    assert.equal((await s.pool.query("SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = 2")).rows[0].n, 0, "not recorded");
    assert.notEqual((await s.pool.query("SELECT to_regclass('half') AS t")).rows[0].t, null, "partial work stays (that is why it must be re-runnable)");
    broken = false;
    assert.deepEqual((await migrator.runPostgres(s.pool, { migrations: [m] })).applied.map((a) => a.version), [2]);
  } finally { await s.drop(); }
});


test("Postgres: instances starting together while a CONCURRENTLY migration is pending do not deadlock, and it applies once", pgOnly, async () => {
  // CREATE INDEX CONCURRENTLY waits for every other open transaction to finish.
  // An instance blocked in pg_advisory_lock() is inside one, and it is waiting for
  // the very instance that is building the index: a deadlock Postgres resolves by
  // killing one of them, i.e. a rolling deploy that crashes an instance. Waiters
  // must poll pg_try_advisory_lock() so none sits in a transaction while waiting.
  const s = await pgScratch("race", 10);
  try {
    await s.pool.query("CREATE TABLE rt (n INTEGER)");
    let ran = 0;
    const m = mig(2, "slow_concurrent", () => {}, async (db) => {
      ran++;
      await db.exec("SELECT pg_sleep(0.6)"); // widen the window in which the others are waiting
      await db.exec("CREATE INDEX CONCURRENTLY IF NOT EXISTS rt_n ON rt (n)");
    }, { transaction: false });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => migrator.runPostgres(s.pool, { migrations: [m] })));
    assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => String(r.reason && r.reason.message)), [], "no instance may fail");
    assert.equal(ran, 1, "the migration ran exactly once");
    assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.applied.length === 1).length, 1);
  } finally { await s.drop(); }
});

// ----- one lock for the baseline AND the migrations (no baseline re-run, no deadlock)
//
// The baseline script used to be re-run, under its own blocking lock, by every
// process that booted. Statements in it (CREATE INDEX IF NOT EXISTS, ALTER TABLE
// ... IF NOT EXISTS) need table locks that conflict with a running CREATE INDEX
// CONCURRENTLY, so a process booting during an index build queued behind it - and
// the build was waiting for that process's open statement: a deadlock that
// crashed startup. Now the baseline runs only for a schema that has no
// schema_migrations table yet, inside the same lock as the migrations.
async function pgEmpty(tag, max = 4) {
  const schema = `test_eidbase_${tag}_${process.pid}`;
  const admin = new Pool({ connectionString: URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  const pool = new Pool({ connectionString: URL, options: `-c search_path=${schema},public`, max });
  const drop = async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); };
  return { schema, pool, admin, drop };
}
const BASELINE_SQL = "CREATE TABLE IF NOT EXISTS ct (n INTEGER); ALTER TABLE ct ADD COLUMN IF NOT EXISTS m INTEGER;";


test("Postgres: the baseline runs once for an unversioned schema, is recorded, and is never re-run", pgOnly, async () => {
  const s = await pgEmpty("once");
  try {
    let ran = 0;
    const baseline = async (client) => { ran++; await client.query(`CREATE SCHEMA IF NOT EXISTS ${s.schema}`); await client.query(BASELINE_SQL); };
    const first = await migrator.runPostgres(s.pool, { schema: s.schema, baseline, migrations: [] });
    assert.equal(ran, 1);
    assert.deepEqual(first.applied, []);
    assert.equal((await s.admin.query(`SELECT COUNT(*)::int AS n FROM ${s.schema}.schema_migrations WHERE version = 1`)).rows[0].n, 1);
    await migrator.runPostgres(s.pool, { schema: s.schema, baseline, migrations: [] });
    await migrator.runPostgres(s.pool, { schema: s.schema, baseline, migrations: [] });
    assert.equal(ran, 1, "a versioned schema must not have its baseline script run again");
  } finally { await s.drop(); }
});


test("Postgres: a schema that already has tables but no schema_migrations is adopted: baseline runs once, data kept", pgOnly, async () => {
  const s = await pgEmpty("legacy");
  try {
    await s.admin.query(`CREATE SCHEMA ${s.schema}`);
    await s.pool.query("CREATE TABLE ct (n INTEGER)");
    await s.pool.query("INSERT INTO ct VALUES (7)");
    let ran = 0;
    const baseline = async (client) => { ran++; await client.query(BASELINE_SQL); };
    await migrator.runPostgres(s.pool, { schema: s.schema, baseline, migrations: [] });
    await migrator.runPostgres(s.pool, { schema: s.schema, baseline, migrations: [] });
    assert.equal(ran, 1);
    assert.equal((await s.pool.query("SELECT n FROM ct")).rows[0].n, 7);
  } finally { await s.drop(); }
});


test("Postgres: instances booting together during a CONCURRENTLY index build neither deadlock nor re-run the baseline", pgOnly, async () => {
  const s = await pgEmpty("boot", 12);
  try {
    let baselineRuns = 0;
    let migrationRuns = 0;
    const baseline = async (client) => { baselineRuns++; await client.query(`CREATE SCHEMA IF NOT EXISTS ${s.schema}`); await client.query(BASELINE_SQL); };
    const m = mig(2, "slow_concurrent", () => {}, async (db) => {
      migrationRuns++;
      await db.exec("SELECT pg_sleep(0.6)");
      await db.exec("CREATE INDEX CONCURRENTLY IF NOT EXISTS ct_n ON ct (n)");
    }, { transaction: false });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      migrator.runPostgres(s.pool, { schema: s.schema, baseline, migrations: [m] })));
    assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => String(r.reason && r.reason.message)), [], "no instance may fail");
    assert.equal(baselineRuns, 1, "the baseline ran once, not once per instance");
    assert.equal(migrationRuns, 1);
    assert.equal((await s.admin.query(`SELECT COUNT(*)::int AS n FROM ${s.schema}.schema_migrations WHERE version = 2`)).rows[0].n, 1);
  } finally { await s.drop(); }
});
