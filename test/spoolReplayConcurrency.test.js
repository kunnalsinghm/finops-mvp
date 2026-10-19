// test/spoolReplayConcurrency.test.js - replaying the spool must never lose an
// event, including one the live server spools WHILE the replay is running.
//
// replaySpool() used to read the whole spool file, replay it, then rewrite (or
// delete) the same file. Anything the server appended in between was overwritten
// or deleted with it: a billed call with no usage record. Reproduced: one spooled
// event, a second spooled during its insert; afterwards the spool was gone and
// only the first event had reached the database.
//
// Now a replay first CLAIMS the spool by renaming it aside (atomic; the server's
// next append simply creates a fresh file), works on the claimed copy, hands
// failures back by appending them to the live spool, and only then deletes the
// claimed copy. A crash at any point leaves the claimed file behind, and the next
// run claims leftovers first; inserts are idempotent on event_id, so replaying a
// line twice cannot bill twice.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-spoolRace-\d+\.db/.test(f)) { try { fs.unlinkSync(path.join(__dirname, f)); } catch {} }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-spoolRace-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "finops-spoolrace-"));
const SPOOL = path.join(SPOOL_DIR, "spool.jsonl");
process.env.FINOPS_SPOOL_PATH = SPOOL;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_spoolrace_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const { spoolEvent, replaySpool } = require("../server/meteringSpool");

test.before(async () => { await storage.ready; });
test.afterEach(() => { for (const f of fs.readdirSync(SPOOL_DIR)) fs.rmSync(path.join(SPOOL_DIR, f), { force: true }); });
test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
  fs.rmSync(SPOOL_DIR, { recursive: true, force: true });
});

let n = 0;
const row = (tag) => ({
  event_time: new Date().toISOString(), provider: "openai", model: "gpt-4.1", team: "t", environment: "e",
  git_branch: null, user_id: `race-${tag}-${++n}`, input_tokens: 10, output_tokens: 5, cost_usd: 0.25, tagged: 1,
  raw_json: "{}", event_id: randomUUID(),
});
const line = (r) => JSON.stringify({ spooled_at: new Date().toISOString(), reason: "test", tenant_schema: null, row: r }) + "\n";
const inDb = async (r) => Number((await storage.get("SELECT COUNT(*) AS n FROM usage_events WHERE event_id = ?", [r.event_id])).n);
const spoolLines = () => (fs.existsSync(SPOOL) ? fs.readFileSync(SPOOL, "utf8").split("\n").filter(Boolean) : []);
const spoolEventIds = () => spoolLines().map((l) => JSON.parse(l).row?.event_id);
const leftovers = () => fs.readdirSync(SPOOL_DIR).filter((f) => f !== path.basename(SPOOL));
const isClaimed = (p) => typeof p === "string" && path.dirname(p) === SPOOL_DIR && path.basename(p).startsWith(path.basename(SPOOL) + ".replaying.");

test("an event spooled WHILE a replay is running is not lost", async (t) => {
  const first = row("first");
  const late = row("late");
  fs.writeFileSync(SPOOL, line(first));
  const realRun = storage.run.bind(storage);
  let fired = false;
  t.mock.method(storage, "run", async (sql, params) => {
    if (!fired && /INSERT INTO usage_events/.test(sql)) { fired = true; spoolEvent(late, "db blip"); } // the live server spools mid-replay
    return realRun(sql, params);
  });
  const result = await replaySpool();
  t.mock.restoreAll();

  assert.equal(await inDb(first), 1);
  assert.deepEqual(spoolEventIds(), [late.event_id], "the late event is still waiting in the spool - it used to be deleted with the file");
  assert.deepEqual(result, { total: 1, replayed: 1, duplicates: 0, remaining: 1 }, "remaining counts what is left in the spool now");

  const next = await replaySpool();
  assert.deepEqual(next, { total: 1, replayed: 1, duplicates: 0, remaining: 0 });
  assert.equal(await inDb(late), 1);
  assert.equal(fs.existsSync(SPOOL), false);
});

test("a straggler write into the claimed file after it was read is still processed", async (t) => {
  // spoolEvent() opens the path, then writes. If a replay renames the file between
  // the two, the write lands in the claimed file after we read it.
  const first = row("first");
  const straggler = row("straggler");
  fs.writeFileSync(SPOOL, line(first));
  const realRead = fs.readFileSync;
  let fired = false;
  t.mock.method(fs, "readFileSync", (p, ...rest) => {
    const out = realRead(p, ...rest);
    if (!fired && isClaimed(p)) { fired = true; fs.appendFileSync(p, line(straggler)); }
    return out;
  });
  const result = await replaySpool();
  t.mock.restoreAll();
  assert.equal(await inDb(first), 1);
  assert.equal(await inDb(straggler), 1, "the straggler was found by re-reading the claimed file before it was deleted");
  assert.deepEqual(result, { total: 2, replayed: 2, duplicates: 0, remaining: 0 });
  assert.deepEqual(leftovers(), []);
});

test("failures and a line spooled mid-replay both end up in the live spool", async (t) => {
  const bad = row("bad");
  const ok = row("ok");
  const late = row("late");
  fs.writeFileSync(SPOOL, line(bad) + line(ok));
  const realRun = storage.run.bind(storage);
  let spooledLate = false;
  t.mock.method(storage, "run", async (sql, params) => {
    if (/INSERT INTO usage_events/.test(sql)) {
      if (!spooledLate) { spooledLate = true; spoolEvent(late, "db blip"); }
      if (params.includes(bad.user_id)) throw new Error("still failing");
    }
    return realRun(sql, params);
  });
  const result = await replaySpool();
  t.mock.restoreAll();
  assert.equal(await inDb(ok), 1);
  assert.equal(await inDb(bad), 0);
  assert.deepEqual(new Set(spoolEventIds()), new Set([bad.event_id, late.event_id]));
  assert.deepEqual(result, { total: 2, replayed: 1, duplicates: 0, remaining: 2 });
  assert.deepEqual(leftovers(), []);
});

test("a crash right after claiming leaves the events recoverable by the next run", async (t) => {
  const r = row("crash1");
  fs.writeFileSync(SPOOL, line(r));
  const realRead = fs.readFileSync;
  let crashed = false;
  t.mock.method(fs, "readFileSync", (p, ...rest) => {
    if (!crashed && isClaimed(p)) { crashed = true; throw new Error("simulated crash after claiming the spool"); }
    return realRead(p, ...rest);
  });
  await assert.rejects(() => replaySpool(), /simulated crash/);
  t.mock.restoreAll();
  assert.equal(fs.existsSync(SPOOL), false, "the live spool was claimed");
  assert.equal(leftovers().length, 1, "the claimed file is still there");
  assert.equal(await inDb(r), 0);

  const again = await replaySpool();
  assert.deepEqual(again, { total: 1, replayed: 1, duplicates: 0, remaining: 0 });
  assert.equal(await inDb(r), 1);
  assert.deepEqual(leftovers(), []);
});

test("a crash after the inserts but before the claimed file is removed yields one row", async (t) => {
  const r = row("crash2");
  fs.writeFileSync(SPOOL, line(r));
  const realUnlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (p, ...rest) => {
    if (isClaimed(p)) throw new Error("simulated crash before cleanup");
    return realUnlink(p, ...rest);
  });
  await assert.rejects(() => replaySpool(), /simulated crash/);
  t.mock.restoreAll();
  assert.equal(await inDb(r), 1);

  const again = await replaySpool();
  assert.deepEqual(again, { total: 1, replayed: 0, duplicates: 1, remaining: 0 });
  assert.equal(await inDb(r), 1);
  assert.deepEqual(leftovers(), []);
});

test("a crash while handing failures back to the live spool loses nothing", async (t) => {
  const bad = row("bad");
  fs.writeFileSync(SPOOL, line(bad));
  const realRun = storage.run.bind(storage);
  t.mock.method(storage, "run", async (sql, params) => {
    if (/INSERT INTO usage_events/.test(sql) && params.includes(bad.user_id)) throw new Error("still failing");
    return realRun(sql, params);
  });
  const realAppend = fs.appendFileSync;
  t.mock.method(fs, "appendFileSync", (p, ...rest) => {
    if (p === SPOOL) throw new Error("simulated crash while handing failures back");
    return realAppend(p, ...rest);
  });
  await assert.rejects(() => replaySpool(), /simulated crash while handing/);
  t.mock.restoreAll();
  assert.equal(leftovers().length, 1, "the claimed file still holds the event");

  const again = await replaySpool(); // DB healthy now
  assert.deepEqual(again, { total: 1, replayed: 1, duplicates: 0, remaining: 0 });
  assert.equal(await inDb(bad), 1);
});

test("a leftover claimed file from a crashed run and a fresh live spool are both processed in one run", async () => {
  const a = row("leftover");
  const b = row("live");
  fs.writeFileSync(`${SPOOL}.replaying.99999`, line(a));
  fs.writeFileSync(SPOOL, line(b));
  const result = await replaySpool();
  assert.deepEqual(result, { total: 2, replayed: 2, duplicates: 0, remaining: 0 });
  assert.equal(await inDb(a), 1);
  assert.equal(await inDb(b), 1);
  assert.deepEqual(leftovers(), []);
  assert.equal(fs.existsSync(SPOOL), false);
});

test("an unparseable line is kept in the live spool for a human, never dropped, and not counted as replayed", async () => {
  const ok = row("ok");
  fs.writeFileSync(SPOOL, "this is not json\n" + line(ok));
  const result = await replaySpool();
  assert.deepEqual(result, { total: 2, replayed: 1, duplicates: 0, remaining: 1 });
  assert.equal(fs.readFileSync(SPOOL, "utf8"), "this is not json\n");
  assert.equal(await inDb(ok), 1);
});

test("a leftover claimed file named with THIS process's pid is not overwritten by a new claim", async () => {
  const old = row("oldclaim");
  const live = row("liveclaim");
  fs.writeFileSync(`${SPOOL}.replaying.${process.pid}`, line(old));
  fs.writeFileSync(SPOOL, line(live));
  const result = await replaySpool();
  assert.deepEqual(result, { total: 2, replayed: 2, duplicates: 0, remaining: 0 });
  assert.equal(await inDb(old), 1, "renaming over the leftover would have destroyed it");
  assert.equal(await inDb(live), 1);
});

test("another replay removing the claimed file first is tolerated (ENOENT on cleanup is not an error)", async (t) => {
  const r = row("enoent");
  fs.writeFileSync(SPOOL, line(r));
  const realUnlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (p, ...rest) => {
    if (isClaimed(p)) {
      realUnlink(p, ...rest); // the other replay got there first...
      const err = new Error("ENOENT: no such file or directory"); err.code = "ENOENT"; // ...so ours finds nothing
      throw err;
    }
    return realUnlink(p, ...rest);
  });
  const result = await replaySpool();
  t.mock.restoreAll();
  assert.deepEqual(result, { total: 1, replayed: 1, duplicates: 0, remaining: 0 });
  assert.equal(await inDb(r), 1);
});

test("an empty spool directory: nothing to do, nothing created", async () => {
  assert.deepEqual(await replaySpool(), { total: 0, replayed: 0, duplicates: 0, remaining: 0 });
  assert.deepEqual(fs.readdirSync(SPOOL_DIR), []);
});

test("a clean run leaves no claimed or temp files behind, and spoolEvent still appends to the live path", async () => {
  const r = row("clean");
  spoolEvent(r, "db down");
  assert.equal(spoolLines().length, 1);
  assert.deepEqual((await replaySpool()).remaining, 0);
  assert.deepEqual(fs.readdirSync(SPOOL_DIR), []);
});
