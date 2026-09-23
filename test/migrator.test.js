// test/migrator.test.js - the schema migration system.
//
// Every guarantee promised in server/storage/migrator.js has a test here, run
// against REAL database files (SQLite) and a real server (Postgres, in CI):
// atomic rollback, exactly-once under concurrent startup, tamper detection,
// refusing a newer schema, upgrading a database created before migrations
// existed, and the pre-migration safety snapshot actually being restorable.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const migrator = require("../server/storage/migrator");
const { SCHEMA_SQL } = require("../server/storage/schema.sqlite");
const realMigrations = require("../server/storage/migrations");
const { MigrationError, checksum, planMigrations, validateMigrations, runSqlite } = migrator;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
const tmp = [];
function tmpDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "finops-mig-")); tmp.push(d); return d; }
test.after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

// A minimal well-formed migration for tests.
const mig = (version, name, sqliteFn, pgFn = async () => {}) => ({ version, name, up: { sqlite: sqliteFn, postgres: pgFn } });
const addCol = (v, name, table, col) => mig(v, name, (db) => db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`));
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const versions = (db) => db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
function baselineDb(dir, name = "app.db") {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL); // the frozen v1 baseline == a database from before migrations existed
  return { file, db };
}

// ---------------------------------------------------------------- pure logic
test("validateMigrations rejects bad versions, names, missing dialects and non-increasing order", () => {
  const ok = mig(2, "a_b", () => {});
  assert.doesNotThrow(() => validateMigrations([ok, mig(3, "c", () => {})]));
  assert.throws(() => validateMigrations([mig(1, "baseline_clash", () => {})]), MigrationError);
  assert.throws(() => validateMigrations([mig(2.5, "frac", () => {})]), MigrationError);
  assert.throws(() => validateMigrations([mig(2, "Bad-Name", () => {})]), /invalid name/);
  assert.throws(() => validateMigrations([{ version: 2, name: "x", up: { sqlite() {} } }]), /both up.sqlite and up.postgres/);
  assert.throws(() => validateMigrations([mig(3, "a", () => {}), mig(3, "b", () => {})]), /strictly increasing/);
  assert.throws(() => validateMigrations([mig(4, "a", () => {}), mig(3, "b", () => {})]), /strictly increasing/);
});

test("the shipped migrations are themselves valid", () => {
  assert.doesNotThrow(() => validateMigrations(realMigrations));
  assert.ok(realMigrations.length >= 2);
});

test("checksum is stable across Windows/Linux line endings but changes when the migration is edited", () => {
  const lf = { version: 2, name: "x", up: { sqlite: eval("(function (db) {\n  db.exec('a');\n})"), postgres: async () => {} } };
  const crlfSrc = "(function (db) {\r\n  db.exec('a');\r\n})";
  const crlf = { ...lf, up: { ...lf.up, sqlite: eval(crlfSrc) } };
  assert.equal(checksum(lf), checksum(crlf), "an autocrlf checkout must not look like a tampered migration");
  const edited = { ...lf, up: { ...lf.up, sqlite: eval("(function (db) {\n  db.exec('b');\n})") } };
  assert.notEqual(checksum(lf), checksum(edited));
});

test("planMigrations: pending runs in order; the baseline row is ignored", () => {
  const ms = [mig(2, "a", () => {}), mig(3, "b", () => {}), mig(4, "c", () => {})];
  const applied = [{ version: 1, name: "baseline", checksum: "baseline" }, { version: 2, name: "a", checksum: checksum(ms[0]) }];
  assert.deepEqual(planMigrations(ms, applied).pending.map((m) => m.version), [3, 4]);
});

test("planMigrations refuses an applied migration whose source was edited", () => {
  const ms = [mig(2, "a", () => {})];
  const applied = [{ version: 2, name: "a", checksum: "0".repeat(64) }];
  assert.throws(() => planMigrations(ms, applied), /modified after it was applied/);
});

test("planMigrations refuses a database that is NEWER than this build, unless explicitly allowed", () => {
  const ms = [mig(2, "a", () => {})];
  const applied = [{ version: 2, name: "a", checksum: checksum(ms[0]) }, { version: 9, name: "future", checksum: "x" }];
  assert.throws(() => planMigrations(ms, applied), /older build against a newer database/);
  assert.doesNotThrow(() => planMigrations(ms, applied, { allowNewer: true }));
});

test("planMigrations refuses a history with a gap (a later migration applied, an earlier one not)", () => {
  const ms = [mig(2, "a", () => {}), mig(3, "b", () => {})];
  assert.throws(() => planMigrations(ms, [{ version: 3, name: "b", checksum: checksum(ms[1]) }]), /applied in order/);
});

// -------------------------------------------------------------------- SQLite
test("SQLite: a fresh database gets every migration once, recorded with checksums; a second run is a no-op", () => {
  const { db } = baselineDb(tmpDir());
  const first = runSqlite(db, { snapshot: false });
  assert.deepEqual(first.applied.map((a) => a.version), realMigrations.map((m) => m.version));
  assert.deepEqual(versions(db), [1, ...realMigrations.map((m) => m.version)]);
  for (const row of db.prepare("SELECT * FROM schema_migrations WHERE version > 1").all()) {
    assert.match(row.checksum, /^[0-9a-f]{64}$/);
    assert.ok(row.applied_at);
  }
  assert.ok(cols(db, "api_keys").includes("allow_background"));
  assert.ok(cols(db, "usage_events").includes("key_id"));
  const again = runSqlite(db, { snapshot: false });
  assert.deepEqual(again.applied, []);
  db.close();
});

test("SQLite: upgrading a pre-migration database keeps its data, backfills key_id, and takes a restorable snapshot first", () => {
  const dir = tmpDir();
  const { file, db } = baselineDb(dir);
  db.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('fk_real','r','developer')").run();
  const ins = db.prepare("INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged) VALUES (?,?,?,?,?,?,?,0)");
  ins.run("2026-01-01T00:00:00Z", "openai", "gpt-4o", "fk_real", 1, 1, 0.5);
  ins.run("2026-01-01T00:00:00Z", "openai", "gpt-4o", "client-declared", 1, 1, 0.5);

  const result = runSqlite(db, { dbPath: file });
  assert.ok(result.snapshot, "a database with data must be snapshotted before it is migrated");
  assert.equal(path.dirname(result.snapshot), path.join(dir, "backups"));

  assert.deepEqual(db.prepare("SELECT user_id, key_id FROM usage_events ORDER BY id").all().map((r) => ({ ...r })), [
    { user_id: "fk_real", key_id: "fk_real" },
    { user_id: "client-declared", key_id: null },
  ]);

  // The snapshot is the PRE-migration state: complete data, integrity ok, still at v1, no new columns.
  const snap = new DatabaseSync(result.snapshot, { readOnly: true });
  assert.equal(snap.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(snap.prepare("SELECT COUNT(*) n FROM usage_events").get().n, 2);
  assert.equal(snap.prepare("SELECT COUNT(*) n FROM api_keys").get().n, 1);
  assert.deepEqual(versions(snap), [1]);
  assert.ok(!cols(snap, "usage_events").includes("key_id"));
  snap.close();
  db.close();
});

test("SQLite: a database upgraded by the OLD ad-hoc mechanism (columns present, no schema_migrations) is adopted, not broken, and NOT re-backfilled", () => {
  const { db } = baselineDb(tmpDir());
  db.exec("ALTER TABLE api_keys ADD COLUMN allow_background INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE usage_events ADD COLUMN key_id TEXT");
  db.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('fk_real','r','developer')").run();
  db.prepare("INSERT INTO usage_events (event_time,provider,model,user_id,key_id,input_tokens,output_tokens,cost_usd,tagged) VALUES ('2026-01-01','openai','gpt-4o','fk_real','sentinel',1,1,0.1,0)").run();
  assert.doesNotThrow(() => runSqlite(db, { snapshot: false }));
  assert.deepEqual(versions(db), [1, 2, 3, 4, 5]);
  assert.equal(db.prepare("SELECT key_id FROM usage_events").get().key_id, "sentinel", "the one-time backfill must not run again");
  db.close();
});

test("SQLite: a migration that fails halfway is rolled back completely and not recorded; earlier ones stay applied", () => {
  const { db } = baselineDb(tmpDir());
  const good = addCol(2, "good_one", "budgets", "note_a");
  const bad = mig(3, "half_done", (d) => {
    d.exec("ALTER TABLE budgets ADD COLUMN note_b TEXT"); // succeeds...
    throw new Error("boom");                              // ...then the migration dies
  });
  assert.throws(() => runSqlite(db, { migrations: [good, bad], snapshot: false }), (e) => e instanceof MigrationError && e.version === 3 && /rolled back/.test(e.message));
  assert.ok(cols(db, "budgets").includes("note_a"), "the earlier migration committed on its own");
  assert.ok(!cols(db, "budgets").includes("note_b"), "the failed migration's DDL was undone");
  assert.deepEqual(versions(db), [1, 2], "the failed migration is not recorded");
  // and it can be retried once fixed
  const fixed = addCol(3, "half_done", "budgets", "note_b");
  assert.doesNotThrow(() => runSqlite(db, { migrations: [good, fixed], snapshot: false }));
  assert.deepEqual(versions(db), [1, 2, 3]);
  db.close();
});

test("SQLite: editing an already-applied migration is refused at startup", () => {
  const { db } = baselineDb(tmpDir());
  runSqlite(db, { migrations: [addCol(2, "one", "budgets", "note_a")], snapshot: false });
  const tampered = mig(2, "one", (d) => d.exec("ALTER TABLE budgets ADD COLUMN something_else TEXT"));
  assert.throws(() => runSqlite(db, { migrations: [tampered], snapshot: false }), /modified after it was applied/);
  db.close();
});

test("SQLite: refuses to run an older build against a newer database, and FINOPS_ALLOW_NEWER_SCHEMA-style opt-in works", () => {
  const { db } = baselineDb(tmpDir());
  runSqlite(db, { snapshot: false });
  db.prepare("INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (99,'from_the_future','x','2026-01-01')").run();
  assert.throws(() => runSqlite(db, { snapshot: false }), /older build against a newer database/);
  assert.doesNotThrow(() => runSqlite(db, { snapshot: false, allowNewer: true }));
  db.close();
});

test("SQLite: no snapshot for an empty database, none when nothing is pending, and none when disabled", () => {
  const dir = tmpDir();
  const { file, db } = baselineDb(dir);
  const first = runSqlite(db, { dbPath: file });          // empty DB: nothing worth protecting
  assert.equal(first.snapshot, null);
  db.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('k','l','developer')").run();
  const second = runSqlite(db, { dbPath: file });         // has data now, but nothing pending
  assert.equal(second.snapshot, null);
  assert.equal(fs.existsSync(path.join(dir, "backups")), false);
  const { file: f2, db: d2 } = baselineDb(dir, "two.db");
  d2.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('k','l','developer')").run();
  assert.equal(runSqlite(d2, { dbPath: f2, snapshot: false }).snapshot, null);  // explicitly disabled
  db.close(); d2.close();
});

test("SQLite: if the safety snapshot can't be written, the migration is REFUSED and the database is left untouched", () => {
  const dir = tmpDir();
  const { file, db } = baselineDb(dir);
  db.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('k','l','developer')").run();
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "x"); // backupDir points at a FILE, so mkdir/VACUUM INTO must fail
  assert.throws(() => runSqlite(db, { dbPath: file, backupDir: blocker }), (e) => e instanceof MigrationError && /safety snapshot/.test(e.message));
  assert.ok(!cols(db, "api_keys").includes("allow_background"), "nothing was migrated");
  assert.deepEqual(versions(db), [1]);
  db.close();
});

test("SQLite: only the newest few pre-migration snapshots are kept", () => {
  const dir = tmpDir();
  const { file, db } = baselineDb(dir);
  db.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('k','l','developer')").run();
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let v = 2; v <= 9; v++) {
    runSqlite(db, { dbPath: file, migrations: [...Array.from({ length: v - 2 }, (_, i) => addCol(i + 2, `m${i + 2}`, "budgets", `c${i + 2}`)), addCol(v, `m${v}`, "budgets", `c${v}`)], now: () => new Date((t += 60000)) });
  }
  assert.equal(fs.readdirSync(path.join(dir, "backups")).filter((f) => f.startsWith("pre-migration-")).length, 5);
  db.close();
});

function runChild(file, startAt) {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const migrator = require(${JSON.stringify(path.join(__dirname, "..", "server", "storage", "migrator"))});
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA busy_timeout = 10000");
    const migrations = [{ version: 2, name: "count_me", up: {
      sqlite(d) {
        d.exec("CREATE TABLE IF NOT EXISTS counter (n INTEGER)");   // takes the write lock...
        const until = Date.now() + 400; while (Date.now() < until) {} // ...and holds it, widening the race window so the
        d.run("INSERT INTO counter VALUES (1)");                     // other process really is waiting on it (a few-ms
      },                                                             // migration would let them run back-to-back and prove nothing)
      async postgres() {} } }];
    while (Date.now() < ${startAt}) {}            // line both processes up at the same instant
    // Both processes plan (each sees the migration as pending) and only THEN race to apply it.
    // Without this, startup writes serialize them before planning and the window never opens.
    const hooks = { afterPlan() { while (Date.now() < ${startAt + 1500}) {} } };
    const r = migrator.runSqlite(db, { migrations, snapshot: false, hooks });
    console.log("APPLIED:" + r.applied.length);`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("SQLite: two processes starting at the same instant apply each migration exactly once", async () => {
  const { file, db } = baselineDb(tmpDir());
  db.close();
  const startAt = Date.now() + 700;
  const [a, b] = await Promise.all([runChild(file, startAt), runChild(file, startAt)]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const appliedCounts = [a, b].map((r) => Number(r.out.match(/APPLIED:(\d+)/)[1])).sort();
  assert.deepEqual(appliedCounts, [0, 1], "exactly one process applied it; the other saw it already done");
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT COUNT(*) n FROM counter").get().n, 1, "the migration body ran once, not twice");
  check.close();
});

// ------------------------------------------------------------------ Postgres
const pg = isPostgres ? require("pg") : null;
async function pgPool(schema) {
  const admin = new pg.Pool({ connectionString: process.env.FINOPS_POSTGRES_URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: process.env.FINOPS_POSTGRES_URL, options: `-c search_path=${schema},public`, max: 4 });
  await pool.query(require("../server/storage/schema.postgres").SCHEMA_SQL); // frozen v1 baseline
  return pool;
}
async function pgDrop(pool, schema) { try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); } }
const pgHasCol = async (pool, t, c) => (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name=$1 AND column_name=$2", [t, c])).rowCount > 0;
const pgVersions = async (pool) => (await pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
const pgOnly = { skip: isPostgres ? false : "Postgres backend only (runs in CI's test-postgres job)" };

test("Postgres: fresh baseline gets every migration once; a second run is a no-op", pgOnly, async () => {
  const schema = `test_migr_fresh_${process.pid}`;
  const pool = await pgPool(schema);
  try {
    const first = await migrator.runPostgres(pool);
    assert.deepEqual(first.applied.map((a) => a.version), realMigrations.map((m) => m.version));
    assert.deepEqual(await pgVersions(pool), [1, ...realMigrations.map((m) => m.version)]);
    assert.ok(await pgHasCol(pool, "api_keys", "allow_background"));
    assert.ok(await pgHasCol(pool, "usage_events", "key_id"));
    assert.deepEqual((await migrator.runPostgres(pool)).applied, []);
  } finally { await pgDrop(pool, schema); }
});

test("Postgres: upgrading a pre-migration database keeps data and backfills key_id", pgOnly, async () => {
  const schema = `test_migr_legacy_${process.pid}`;
  const pool = await pgPool(schema);
  try {
    await pool.query("INSERT INTO api_keys (key_id,label,role) VALUES ('fk_real','r','developer')");
    for (const u of ["fk_real", "client-declared"])
      await pool.query("INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged) VALUES ('2026-01-01','openai','gpt-4o',$1,1,1,0.5,0)", [u]);
    await migrator.runPostgres(pool);
    const rows = (await pool.query("SELECT user_id, key_id FROM usage_events ORDER BY id")).rows;
    assert.deepEqual(rows, [{ user_id: "fk_real", key_id: "fk_real" }, { user_id: "client-declared", key_id: null }]);
  } finally { await pgDrop(pool, schema); }
});

test("Postgres: a database already upgraded by the old ad-hoc mechanism is adopted and NOT re-backfilled", pgOnly, async () => {
  const schema = `test_migr_adopt_${process.pid}`;
  const pool = await pgPool(schema);
  try {
    await pool.query("ALTER TABLE api_keys ADD COLUMN allow_background INTEGER NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE usage_events ADD COLUMN key_id TEXT");
    await pool.query("INSERT INTO api_keys (key_id,label,role) VALUES ('fk_real','r','developer')");
    await pool.query("INSERT INTO usage_events (event_time,provider,model,user_id,key_id,input_tokens,output_tokens,cost_usd,tagged) VALUES ('2026-01-01','openai','gpt-4o','fk_real','sentinel',1,1,0.1,0)");
    await migrator.runPostgres(pool);
    assert.deepEqual(await pgVersions(pool), [1, 2, 3, 4, 5]);
    assert.equal((await pool.query("SELECT key_id FROM usage_events")).rows[0].key_id, "sentinel");
  } finally { await pgDrop(pool, schema); }
});

test("Postgres: a failing migration rolls back its DDL and is not recorded", pgOnly, async () => {
  const schema = `test_migr_fail_${process.pid}`;
  const pool = await pgPool(schema);
  try {
    const bad = mig(2, "half_done", () => {}, async (db) => {
      await db.exec("ALTER TABLE budgets ADD COLUMN note_b TEXT");
      throw new Error("boom");
    });
    await assert.rejects(() => migrator.runPostgres(pool, { migrations: [bad] }), (e) => e instanceof MigrationError && /rolled back/.test(e.message));
    assert.equal(await pgHasCol(pool, "budgets", "note_b"), false, "Postgres DDL is transactional - the column must be gone");
    assert.deepEqual(await pgVersions(pool), [1]);
  } finally { await pgDrop(pool, schema); }
});

test("Postgres: two instances migrating at the same time apply each migration exactly once (advisory lock)", pgOnly, async () => {
  const schema = `test_migr_race_${process.pid}`;
  const pool = await pgPool(schema);
  try {
    await pool.query("CREATE TABLE counter (n INTEGER)");
    const counting = mig(2, "count_me", () => {}, async (db) => {
      await db.exec("SELECT pg_sleep(0.3)");           // widen the race window
      await db.exec("INSERT INTO counter VALUES (1)");
    });
    const [a, b] = await Promise.all([
      migrator.runPostgres(pool, { migrations: [counting] }),
      migrator.runPostgres(pool, { migrations: [counting] }),
    ]);
    assert.deepEqual([a.applied.length, b.applied.length].sort(), [0, 1]);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM counter")).rows[0].n, 1);
  } finally { await pgDrop(pool, schema); }
});
