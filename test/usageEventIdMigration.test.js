// test/usageEventIdMigration.test.js - migration 14 (usage_events.event_id).
//
// Single-tenant migration 14 (the tenant copy is covered in usageEventIdTenant.test.js).
// What matters beyond "the column exists": on a database that already holds data the
// upgrade must keep every row, must not rewrite the table, and on Postgres must build
// the unique index CONCURRENTLY (a plain CREATE UNIQUE INDEX would block every INSERT,
// i.e. metering, for the whole build) and repair a stale INVALID index left by a failed
// concurrent build. The migrator side (`transaction: false`, the polled lock, the
// baseline hook) is covered in migratorNonTransactional.test.js.

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

const idx14 = realMigrations.findIndex((m) => m.version === 14);
const through13 = () => realMigrations.slice(0, idx14);
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


test("migration 14 exists, is registered last-so-far, and declares transaction:false", () => {
  assert.ok(idx14 >= 0, "migration 14 is registered");
  const m = realMigrations[idx14];
  assert.equal(m.name, "usage_event_id");
  assert.equal(m.transaction, false, "Postgres needs CREATE INDEX CONCURRENTLY, which cannot run inside a transaction");
  assert.doesNotThrow(() => validateMigrations(realMigrations));
});


test("SQLite: a fresh database gets event_id (nullable) and a unique index; re-running is a no-op", () => {
  const { db } = baselineDb();
  const first = runSqlite(db, { snapshot: false });
  assert.ok(first.applied.some((a) => a.version === 14));
  const col = db.prepare("PRAGMA table_info(usage_events)").all().find((c) => c.name === "event_id");
  assert.ok(col);
  assert.equal(String(col.type).toUpperCase(), "TEXT");
  assert.equal(col.notnull, 0);
  const uniq = db.prepare("PRAGMA index_list(usage_events)").all().filter((i) => i.unique === 1 && db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join() === "event_id");
  assert.equal(uniq.length, 1);
  assert.deepEqual(runSqlite(db, { snapshot: false }).applied, []);
  db.close();
});


test("SQLite: upgrading a database that already has data keeps every row, leaves old rows NULL, and enforces uniqueness for new ids", () => {
  const { db } = baselineDb();
  runSqlite(db, { migrations: through13(), snapshot: false });
  insertSqlite(db, "old-1");
  insertSqlite(db, "old-2");
  const result = runSqlite(db, { snapshot: false });
  assert.deepEqual(result.applied.map((a) => a.version), [14]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_events").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_events WHERE event_id IS NULL").get().n, 2);
  insertSqlite(db, "new-null-a");
  insertSqlite(db, "new-null-b"); // many NULLs are allowed by a unique index
  insertSqlite(db, "new-1", "11111111-1111-4111-8111-111111111111");
  assert.throws(() => insertSqlite(db, "new-2", "11111111-1111-4111-8111-111111111111"), /UNIQUE/i);
  db.close();
});

// ---------------------------------------------- migrator: transaction:false

test("Postgres: a fresh schema gets event_id and a VALID unique index; re-running is a no-op", pgOnly, async () => {
  const s = await pgScratch("fresh");
  try {
    const first = await migrator.runPostgres(s.pool);
    assert.ok(first.applied.some((a) => a.version === 14));
    const idx = await pgIndex(s.admin, s.schema, "usage_events", "event_id");
    assert.equal(idx.length, 1);
    assert.equal(idx[0].indisunique, true);
    assert.equal(idx[0].indisvalid, true);
    assert.deepEqual((await migrator.runPostgres(s.pool)).applied, []);
  } finally { await s.drop(); }
});


test("Postgres: upgrading a database with data keeps every row and does NOT rewrite the table", pgOnly, async () => {
  const s = await pgScratch("upgrade");
  try {
    await migrator.runPostgres(s.pool, { migrations: through13() });
    for (let i = 0; i < 25; i++) await pgInsertOld(s.pool, `old-${i}`);
    const before = await relfilenode(s.admin, s.schema, "usage_events");
    const result = await migrator.runPostgres(s.pool);
    assert.deepEqual(result.applied.map((a) => a.version), [14]);
    assert.equal(await relfilenode(s.admin, s.schema, "usage_events"), before, "ADD COLUMN (nullable, no default) and CREATE INDEX must not rewrite the table");
    assert.equal(Number((await s.pool.query("SELECT COUNT(*) AS n FROM usage_events WHERE event_id IS NULL")).rows[0].n), 25);
    await pgInsert(s.pool, "n1", "22222222-2222-4222-8222-222222222222");
    await assert.rejects(() => pgInsert(s.pool, "n2", "22222222-2222-4222-8222-222222222222"), /duplicate key|unique/i);
    await pgInsert(s.pool, "n3"); // NULLs never collide
    await pgInsert(s.pool, "n4");
  } finally { await s.drop(); }
});


test("Postgres: a stale INVALID index left by a failed concurrent build is replaced on re-run", pgOnly, async () => {
  const s = await pgScratch("stale");
  try {
    await migrator.runPostgres(s.pool);
    await s.pool.query("DROP INDEX idx_usage_events_event_id");
    await pgInsert(s.pool, "d1", "33333333-3333-4333-8333-333333333333");
    await pgInsert(s.pool, "d2", "33333333-3333-4333-8333-333333333333");
    await assert.rejects(() => s.pool.query("CREATE UNIQUE INDEX CONCURRENTLY idx_usage_events_event_id ON usage_events (event_id)"), /duplicate key|unique/i);
    const invalid = await pgIndex(s.admin, s.schema, "usage_events", "event_id");
    assert.equal(invalid.length, 1, "precondition: the failed build left an index behind");
    assert.equal(invalid[0].indisvalid, false, "precondition: and it is INVALID");

    await s.pool.query("DELETE FROM usage_events WHERE user_id = 'd2'");
    await s.pool.query("DELETE FROM schema_migrations WHERE version = 14"); // as if the crash happened before it was recorded
    const again = await migrator.runPostgres(s.pool);
    assert.deepEqual(again.applied.map((a) => a.version), [14]);
    const idx = await pgIndex(s.admin, s.schema, "usage_events", "event_id");
    assert.equal(idx.length, 1);
    assert.equal(idx[0].indisvalid, true, "IF NOT EXISTS alone would have kept the invalid index forever");
    assert.equal(idx[0].indisunique, true);
  } finally { await s.drop(); }
});
