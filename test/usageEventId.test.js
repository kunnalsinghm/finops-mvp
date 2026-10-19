// test/usageEventId.test.js - idempotent usage events (RFC 0001, phase A3).
//
// usage_events had no idempotency key, so the same event could be inserted
// twice: a spool replay run twice, a replay after a crash between the insert
// and the spool rewrite, or an insert that committed but whose acknowledgement
// was lost before the event was spooled. Metering is money, so a duplicate is
// double billing.
//
// An event now carries event_id (a UUID minted once, when the row is first
// built). A unique index makes the insert the arbiter: a second insert of the
// same event_id is ignored. Rows without an event_id (older rows, older spool
// lines) behave exactly as before.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-usageEventId-\d+\.db/.test(f)) { try { fs.unlinkSync(path.join(__dirname, f)); } catch {} }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-usageEventId-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const SPOOL = path.join(os.tmpdir(), `finops-spool-eid-${process.pid}.jsonl`);
process.env.FINOPS_SPOOL_PATH = SPOOL;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_usageeventid_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const { insertUsageEvent } = require("../server/usageStore");
const { spoolEvent, replaySpool } = require("../server/meteringSpool");

test.before(async () => { await storage.ready; });
test.afterEach(() => { try { fs.unlinkSync(SPOOL); } catch {} });
test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
  try { fs.unlinkSync(SPOOL); } catch {}
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let n = 0;
const row = (extra = {}) => ({
  event_time: new Date().toISOString(), provider: "openai", model: "gpt-4.1", team: "t", environment: "e",
  git_branch: null, user_id: `eid-user-${++n}`, input_tokens: 10, output_tokens: 5, cost_usd: 0.25, tagged: 1, raw_json: "{}",
  ...extra,
});
const eid = () => require("node:crypto").randomUUID();
const countBy = async (event_id) => Number((await storage.get("SELECT COUNT(*) AS n FROM usage_events WHERE event_id = ?", [event_id])).n);
const countUser = async (user_id) => Number((await storage.get("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?", [user_id])).n);
const spoolLine = (r, extra = {}) => JSON.stringify({ spooled_at: new Date().toISOString(), reason: "test", tenant_schema: null, row: r, ...extra }) + "\n";

test("schema: event_id is a nullable TEXT column covered by a UNIQUE index", async () => {
  if (isPostgres) {
    const col = await storage.get(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'usage_events' AND column_name = 'event_id'");
    assert.deepEqual({ ...col }, { data_type: "text", is_nullable: "YES" });
    const idx = await storage.all(
      `SELECT i.indisunique, i.indisvalid, a.attname FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
        WHERE ns.nspname = current_schema() AND c.relname = 'usage_events' AND a.attname = 'event_id'`);
    assert.equal(idx.length, 1);
    assert.equal(idx[0].indisunique, true);
    assert.equal(idx[0].indisvalid, true);
  } else {
    const cols = await storage.all("PRAGMA table_info(usage_events)");
    const c = cols.find((x) => x.name === "event_id");
    assert.ok(c, "event_id column exists");
    assert.equal(String(c.type).toUpperCase(), "TEXT");
    assert.equal(Number(c.notnull), 0);
    const uniq = (await storage.all("PRAGMA index_list(usage_events)")).filter((i) => Number(i.unique) === 1);
    const onEventId = [];
    for (const i of uniq) {
      const info = await storage.all(`PRAGMA index_info(${i.name})`);
      if (info.length === 1 && info[0].name === "event_id") onEventId.push(i.name);
    }
    assert.equal(onEventId.length, 1, "exactly one unique index on event_id");
  }
});

test("inserting the same event_id twice stores one row; the second insert reports it was a duplicate", async () => {
  const id = eid();
  const first = await insertUsageEvent(row({ event_id: id }));
  assert.ok(first !== null && first !== undefined, "a new event returns its row id");
  const second = await insertUsageEvent(row({ event_id: id, user_id: "eid-other" }));
  assert.equal(second, null, "a duplicate returns null, not a stale id");
  assert.equal(await countBy(id), 1);
});

test("two events with different ids both insert", async () => {
  const a = eid(), b = eid();
  await insertUsageEvent(row({ event_id: a }));
  await insertUsageEvent(row({ event_id: b }));
  assert.equal(await countBy(a), 1);
  assert.equal(await countBy(b), 1);
});

test("rows without an event_id behave as before: no dedupe, many NULLs allowed", async () => {
  const r = row();
  assert.equal(r.event_id, undefined);
  await insertUsageEvent(r);
  await insertUsageEvent(r);
  assert.equal(await countUser(r.user_id), 2);
  const stored = await storage.get("SELECT event_id FROM usage_events WHERE user_id = ? ORDER BY id DESC LIMIT 1", [r.user_id]);
  assert.equal(stored.event_id, null);
});

test("replaySpool run twice on the same spool file yields one row", async () => {
  const id = eid();
  const r = row({ event_id: id });
  fs.writeFileSync(SPOOL, spoolLine(r));
  const copy = fs.readFileSync(SPOOL);

  const first = await replaySpool();
  assert.deepEqual(first, { total: 1, replayed: 1, duplicates: 0, remaining: 0 });
  assert.equal(fs.existsSync(SPOOL), false);

  fs.writeFileSync(SPOOL, copy); // the operator runs it again with the same file
  const second = await replaySpool();
  assert.deepEqual(second, { total: 1, replayed: 0, duplicates: 1, remaining: 0 });
  assert.equal(await countBy(id), 1);
  assert.equal(fs.existsSync(SPOOL), false, "a duplicate is already safe in the database, so it leaves the spool");
});

// The two crash-window tests that used to be here (crash between the insert and the spool
// cleanup; crash while rewriting the kept lines) tested the old in-place rewrite. Replay now
// claims the spool by renaming it, and those windows are covered against that design in
// spoolReplayConcurrency.test.js.

test("an old spool line with no event_id still replays (once), as before", async () => {
  const r = row();
  fs.writeFileSync(SPOOL, spoolLine(r));
  const result = await replaySpool();
  assert.deepEqual(result, { total: 1, replayed: 1, duplicates: 0, remaining: 0 });
  assert.equal(await countUser(r.user_id), 1);
});

test("the spooled event_id is the stored event_id, byte for byte", async () => {
  const id = eid();
  const r = row({ event_id: id });
  spoolEvent(r, "db down");
  assert.equal(JSON.parse(fs.readFileSync(SPOOL, "utf8").trim()).row.event_id, id);
  await replaySpool();
  const stored = await storage.get("SELECT event_id FROM usage_events WHERE user_id = ?", [r.user_id]);
  assert.equal(stored.event_id, id);
  assert.match(stored.event_id, UUID);
});

test("npm run replay-spool reports duplicates that were already in the database", async () => {
  const id = eid();
  await insertUsageEvent(row({ event_id: id }));
  fs.writeFileSync(SPOOL, spoolLine(row({ event_id: id })));
  const env = { ...process.env };
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "replay-spool.js")], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Replayed 0 of 1 event\(s\)/);
  assert.match(r.stdout, /1 already in the database/);
  assert.equal(await countBy(id), 1);
});
