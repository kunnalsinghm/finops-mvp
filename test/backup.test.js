// test/backup.test.js - backups that are consistent, verified and RESTORABLE.
//
// The headline test reproduces the bug this module was rewritten to fix: the old
// backup copied only the main file of a WAL-mode database, so a backup taken
// while the server was running was stale or contained no tables at all. The
// restore tests then walk the real disaster: back up, lose the database, restore,
// and boot the actual application on the result.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

// These tests exercise SQLite files directly, whatever backend CI selected.
const savedDriver = process.env.FINOPS_DB_DRIVER;
delete process.env.FINOPS_DB_DRIVER;
test.after(() => { if (savedDriver !== undefined) process.env.FINOPS_DB_DRIVER = savedDriver; });

const backup = require("../server/backup");
const migrator = require("../server/storage/migrator");
const { SCHEMA_SQL } = require("../server/storage/schema.sqlite");
const ROOT = path.join(__dirname, "..");

const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "finops-bk-")); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const quiet = { info() {}, warn() {} };

// A realistic database, kept OPEN (as a running server would) unless closed by the caller.
function makeLiveDb(dir, { rows = 50, migrate = true, name = "finops.db" } = {}) {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('fk_one','one','admin'), ('fk_two','two','developer')").run();
  db.prepare("INSERT INTO budgets (scope_type,scope_value,monthly_limit_usd) VALUES ('team','finance',100)").run();
  const ins = db.prepare("INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged) VALUES (?,?,?,?,?,?,?,0)");
  for (let i = 0; i < rows; i++) ins.run("2026-01-01T00:00:00Z", "openai", "gpt-4o", i % 2 ? "fk_one" : "client-declared", 10, 10, 0.25);
  if (migrate) migrator.runSqlite(db, { snapshot: false });
  return { file, db };
}
const countRows = (file, table = "usage_events") => {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return d.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; } finally { d.close(); }
};

// ---------------------------------------------------------------- consistency
test("REGRESSION: a backup taken while the server holds the database open contains ALL committed rows", (t) => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 500 }); // connection stays open, WAL not checkpointed
  assert.ok(fs.statSync(file + "-wal").size > 0, "precondition: recent writes are sitting in the -wal file");

  // Control: what the OLD implementation did. Recorded, not asserted - SQLite may checkpoint differently.
  const naive = path.join(dir, "naive-copy.db");
  fs.copyFileSync(file, naive);
  let naiveRows;
  try { naiveRows = countRows(naive); } catch (e) { naiveRows = `unreadable (${e.message})`; }
  t.diagnostic(`old approach (copyFileSync) recovered: ${naiveRows} of 500 rows`);

  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "backups") });
  assert.ok(out, "backup should succeed");
  assert.equal(countRows(out), 500, "every committed row must be in the backup");
  assert.equal(backup.inspectDatabase(out).ok, true);
  db.close();
});

test("a backup taken while another connection is actively writing is still self-consistent", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 10 });
  const ins = db.prepare("INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged) VALUES ('2026-01-02','openai','gpt-4o','fk_one',1,1,0.1,0)");
  for (let i = 0; i < 200; i++) {
    ins.run();
    if (i % 50 === 0) {
      const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "backups"), retention: 50 });
      assert.ok(out);
      const r = backup.inspectDatabase(out);
      assert.equal(r.ok, true, r.problems.join(";"));
      assert.ok(r.counts.usage_events >= 10 + i, "a snapshot taken at step i contains at least the rows committed before it");
    }
  }
  db.close();
});

test("runBackup keeps only the newest N verified backups", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir);
  const backupDir = path.join(dir, "backups");
  const made = [];
  for (let i = 0; i < 5; i++) { made.push(backup.runBackup({ dbPath: file, backupDir, retention: 3 })); }
  assert.equal(backup.listBackups({ backupDir }).length, 3);
  assert.equal(path.basename(made[4]), backup.listBackups({ backupDir })[0].name, "newest first");
  assert.equal(backup.latestBackup({ backupDir }), made[4]);
  db.close();
});

test("runBackup with no database yet is a clean no-op, not an error", () => {
  const dir = tmpDir();
  assert.equal(backup.runBackup({ dbPath: path.join(dir, "nope.db"), backupDir: path.join(dir, "b") }), null);
});

test("a backup that FAILS verification is discarded, reported as a failure, and older backups are NOT pruned", () => {
  const dir = tmpDir();
  const backupDir = path.join(dir, "backups");
  fs.mkdirSync(backupDir);
  for (const n of ["finops-2020-01-01T00-00-00-000Z.db", "finops-2020-01-02T00-00-00-000Z.db", "finops-2020-01-03T00-00-00-000Z.db"]) fs.writeFileSync(path.join(backupDir, n), "older good backup");
  // A perfectly valid SQLite file that is not a Guard database -> the snapshot succeeds, verification must not.
  const notGuard = path.join(dir, "other.db");
  const o = new DatabaseSync(notGuard); o.exec("CREATE TABLE unrelated (x INTEGER); INSERT INTO unrelated VALUES (1);"); o.close();
  const before = fs.readdirSync(backupDir).length;
  const out = backup.runBackup({ dbPath: notGuard, backupDir, retention: 1 });
  assert.equal(out, null);
  assert.equal(fs.readdirSync(backupDir).length, before, "the bad backup was deleted and NO good backup was pruned to make room");
});

// ------------------------------------------------------------- inspect/verify
test("inspectDatabase flags garbage, a truncated file, a non-Guard database, a missing file, and an unmerged -wal", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 200 });
  const good = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();
  assert.equal(backup.inspectDatabase(good).ok, true);

  const garbage = path.join(dir, "garbage.db"); fs.writeFileSync(garbage, "this is not a database at all");
  const g = backup.inspectDatabase(garbage);
  assert.equal(g.ok, false); assert.match(g.problems.join(), /cannot be read as a SQLite database/);

  const trunc = path.join(dir, "trunc.db"); fs.writeFileSync(trunc, fs.readFileSync(good).subarray(0, 6000));
  assert.equal(backup.inspectDatabase(trunc).ok, false);

  const other = path.join(dir, "other.db");
  const o = new DatabaseSync(other); o.exec("CREATE TABLE unrelated (x INTEGER)"); o.close();
  assert.match(backup.inspectDatabase(other).problems.join(), /required table 'usage_events' is missing/);

  assert.match(backup.inspectDatabase(path.join(dir, "missing.db")).problems.join(), /does not exist/);

  const withWal = path.join(dir, "withwal.db"); fs.copyFileSync(good, withWal); fs.writeFileSync(withWal + "-wal", "x".repeat(100));
  assert.match(backup.inspectDatabase(withWal).problems.join(), /unmerged -wal/);
});

test("verifyBackup: a current backup is restorable, reports row counts, and the backup file is never modified", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 40 });
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();
  const h = sha(out);
  const r = backup.verifyBackup(out);
  assert.equal(r.ok, true, r.problems.join(";"));
  assert.equal(r.before.counts.usage_events, 40);
  assert.equal(r.after.schemaVersion, r.before.schemaVersion);
  assert.equal(sha(out), h, "verification works on a throwaway copy");
});

test("verifyBackup: an OLD-schema backup (pre-migrations) is proven upgradable by the CURRENT code, with no rows lost", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 30, migrate: false }); // exactly what an old release backed up
  const out = path.join(dir, "old-backup.db");
  backup.snapshotDatabase(file, out);
  db.close();
  const r = backup.verifyBackup(out);
  assert.equal(r.ok, true, r.problems.join(";"));
  assert.equal(r.before.schemaVersion, 1);
  assert.equal(r.after.schemaVersion, migrator.loadDefaultMigrations().at(-1).version);
  assert.equal(r.after.counts.usage_events, 30);
});

test("verifyBackup: a corrupt backup is reported NOT restorable", () => {
  const dir = tmpDir();
  const bad = path.join(dir, "bad.db"); fs.writeFileSync(bad, Buffer.alloc(8192, 7));
  const r = backup.verifyBackup(bad);
  assert.equal(r.ok, false);
  assert.ok(r.problems.length > 0);
});

// -------------------------------------------------------------------- restore
function bootRealApp(dbFile) {
  // Start the REAL storage layer (migrations and all) on a file, in its own process.
  const script = `
    const s = require(${JSON.stringify(path.join(ROOT, "server", "storage"))});
    (async () => { await s.ready;
      const q = async (sql) => (await s.get(sql)).n;
      console.log("RESULT:" + JSON.stringify({
        events: await q("SELECT COUNT(*) AS n FROM usage_events"),
        keys: await q("SELECT COUNT(*) AS n FROM api_keys"),
        version: await q("SELECT MAX(version) AS n FROM schema_migrations"),
        backfilled: await q("SELECT COUNT(*) AS n FROM usage_events WHERE key_id = 'fk_one'"),
      })); process.exit(0); })().catch((e) => { console.error(e.message); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, FINOPS_DB_DRIVER: "", FINOPS_DB_PATH: dbFile, FINOPS_SKIP_PREMIGRATION_BACKUP: "true" },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.split("RESULT:")[1]);
}

test("DISASTER RECOVERY: back up a live database, lose it, restore it, and the real application boots on it with every row", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 120 });
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "backups") });
  db.close();

  // the disaster
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(file + ext, { force: true });
  assert.equal(fs.existsSync(file), false);

  const r = backup.restoreBackup({ backupPath: out, targetPath: file });
  assert.equal(r.movedAside.length, 0, "nothing to move aside - the database was gone");
  assert.deepEqual(bootRealApp(file), { events: 120, keys: 2, version: migrator.loadDefaultMigrations().at(-1).version, backfilled: 60 });
});

test("restoring an OLD-schema backup, then starting the app, migrates it forward with data intact", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 40, migrate: false });
  const out = path.join(dir, "backups", "finops-2026-01-01T00-00-00-000Z.db");
  fs.mkdirSync(path.dirname(out));
  backup.snapshotDatabase(file, out);
  db.close();
  const target = path.join(dir, "restored.db");
  const r = backup.restoreBackup({ backupPath: out, targetPath: target });
  assert.equal(r.backupSchemaVersion, 1);
  assert.match(r.note, /migrated to v\d+ automatically/);
  const app = bootRealApp(target);
  assert.equal(app.events, 40);
  assert.equal(app.version, migrator.loadDefaultMigrations().at(-1).version);
  assert.equal(app.backfilled, 20, "the key_id backfill ran on the restored old data");
});

test("restore refuses to overwrite an existing database without force, and leaves it untouched", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir);
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();
  const target = path.join(dir, "existing.db"); fs.writeFileSync(target, "precious existing data");
  const h = sha(target);
  assert.throws(() => backup.restoreBackup({ backupPath: out, targetPath: target }), /already exists/);
  assert.equal(sha(target), h);
});

test("restore --force moves the old database AND its stale -wal/-shm aside (never replays them onto the restored file)", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 25 });
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();
  const target = path.join(dir, "live.db");
  fs.writeFileSync(target, "OLD DATABASE BYTES"); fs.writeFileSync(target + "-wal", "STALE WAL"); fs.writeFileSync(target + "-shm", "STALE SHM");

  const r = backup.restoreBackup({ backupPath: out, targetPath: target, force: true });
  assert.equal(r.movedAside.length, 3);
  for (const m of r.movedAside) assert.ok(fs.existsSync(m), `${m} was kept, not deleted`);
  assert.equal(fs.readFileSync(r.movedAside.find((m) => m.endsWith(".db.replaced-" + m.split(".replaced-")[1])) || r.movedAside[0], "utf8").length > 0, true);
  assert.equal(fs.existsSync(target + "-wal"), false, "no stale WAL beside the restored file");
  assert.equal(fs.existsSync(target + "-shm"), false);
  assert.equal(countRows(target), 25);
  assert.equal(backup.inspectDatabase(target).ok, true);
});

test("restore of a corrupt backup is refused BEFORE touching the existing database", () => {
  const dir = tmpDir();
  const bad = path.join(dir, "bad.db"); fs.writeFileSync(bad, Buffer.alloc(9000, 1));
  const target = path.join(dir, "live.db"); fs.writeFileSync(target, "live data");
  const h = sha(target);
  assert.throws(() => backup.restoreBackup({ backupPath: bad, targetPath: target, force: true }), /failed verification/);
  assert.equal(sha(target), h);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["bad.db", "live.db"], "no staging files or moved-aside copies left behind");
});

test("if the final swap fails, the restore is rolled back: the original database is back in place and nothing is left over", (t) => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir);
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();
  const target = path.join(dir, "live.db"); fs.writeFileSync(target, "live data that must survive");
  fs.writeFileSync(target + "-wal", "wal that must also come back");
  const h = sha(target);

  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(from).includes(".restoring-")) { const e = new Error("simulated: file is locked"); e.code = "EBUSY"; throw e; } // only the staged -> target swap fails
    return realRename(from, to);
  });
  assert.throws(() => backup.restoreBackup({ backupPath: out, targetPath: target, force: true }), /rolled back.*Is the server still running/s);
  t.mock.restoreAll();

  assert.equal(sha(target), h, "original database restored byte-for-byte");
  assert.equal(fs.readFileSync(target + "-wal", "utf8"), "wal that must also come back");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".restoring-") || f.includes(".replaced-")), [], "no staging or moved-aside leftovers");
});

test("if the rollback ALSO fails, the error names exactly where the previous database files are, and they still exist", (t) => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir);
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();
  const target = path.join(dir, "live.db"); fs.writeFileSync(target, "irreplaceable");

  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === target) { const e = new Error("simulated: everything into target is blocked"); e.code = "EBUSY"; throw e; } // swap AND rollback both fail
    return realRename(from, to);
  });
  let message = "";
  try { backup.restoreBackup({ backupPath: out, targetPath: target, force: true }); } catch (e) { message = e.message; }
  t.mock.restoreAll();

  assert.match(message, /automatic rollback could not fully complete/);
  const kept = fs.readdirSync(dir).filter((f) => f.includes(".replaced-"));
  assert.equal(kept.length, 1, "the previous database was moved aside, not lost");
  assert.ok(message.includes(path.join(dir, kept[0])), "the message tells the operator exactly where it is");
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), "irreplaceable");
});

test("restore refuses a backup that has an unmerged -wal beside it (copying only the main file would lose data)", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir);
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();
  fs.writeFileSync(out + "-wal", "y".repeat(64));
  assert.throws(() => backup.restoreBackup({ backupPath: out, targetPath: path.join(dir, "t.db") }), /unmerged -wal/);
});

// ------------------------------------------------------------------------ CLI
function cli(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8", env: { ...process.env, FINOPS_DB_DRIVER: "", ...env } });
}

test("CLI: `backup:verify` exits 0 for a restorable backup and 1 for a corrupt one; `restore` restores it", () => {
  const dir = tmpDir();
  const { file, db } = makeLiveDb(dir, { rows: 15 });
  const out = backup.runBackup({ dbPath: file, backupDir: path.join(dir, "b") });
  db.close();

  const ok = cli("verify-backup.js", [out]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /OK - restorable/);
  assert.match(ok.stdout, /usage_events=15/);

  const badFile = path.join(dir, "bad.db"); fs.writeFileSync(badFile, "nope");
  const bad = cli("verify-backup.js", [badFile]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /NOT RESTORABLE/);

  const target = path.join(dir, "cli-restored.db");
  const rs = cli("restore.js", [out, "--target", target]);
  assert.equal(rs.status, 0, rs.stderr);
  assert.match(rs.stdout, /Restored/);
  assert.equal(countRows(target), 15);

  const again = cli("restore.js", [out, "--target", target]);
  assert.equal(again.status, 1, "second restore without --force must refuse");
  assert.match(again.stderr, /already exists/);
  assert.equal(cli("restore.js", [out, "--target", target, "--force"]).status, 0);
});
