// test/usageEventIdPaths.test.js - every way a usage event is created stamps
// an event_id, and the id survives the spool.
//
// An idempotency key only works if it is minted ONCE, where the event is first
// built, and carried unchanged through every later step. If one insert path
// forgot to stamp it, that path would silently have no protection. So this
// drives each real path (proxy: non-streaming, streaming, exact-cache hit,
// semantic-cache hit; ingest) and checks the stored id, then proves the case the
// key exists for: an insert that COMMITTED but whose acknowledgement was lost,
// so the event was spooled although it was already stored.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-eidpaths-\d+\.db/.test(f)) { try { fs.unlinkSync(path.join(__dirname, f)); } catch {} }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-eidpaths-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const SPOOL = path.join(os.tmpdir(), `finops-spool-eidpaths-${process.pid}.jsonl`);
process.env.FINOPS_SPOOL_PATH = SPOOL;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_eidpaths_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const proxyRoute = require("../server/routes/proxy");
const ingestRoute = require("../server/routes/ingest");
const { replaySpool } = require("../server/meteringSpool");

let server;
test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/proxy", proxyRoute);
  app.use("/api/ingest", ingestRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});
test.afterEach(() => { try { fs.unlinkSync(SPOOL); } catch {} });
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
  try { fs.unlinkSync(SPOOL); } catch {}
});

function post(pathName, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port: server.address().port, path: pathName, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json; try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

let keyCounter = 0;
async function makeApiKey() {
  keyCounter++;
  const key_id = `fk_test_eid_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, 'developer', 'active')", [key_id, `eid key ${keyCounter}`]);
  return key_id;
}
const events = (user_id) => storage.all("SELECT id, event_id, raw_json FROM usage_events WHERE user_id = ? ORDER BY id", [user_id]);
async function eventually(fn, { tries = 80, delayMs = 25 } = {}) {
  let v;
  for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, delayMs)); }
  return v;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PK = { "X-Provider-Key": "sk-real-upstream-key" };
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const openaiResponse = (i, o) => ({
  id: "m", object: "chat.completion", model: "x",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: i, completion_tokens: o, total_tokens: i + o },
});
function sseBody(lines) {
  const enc = new TextEncoder();
  return (async function* () { for (const l of lines) yield enc.encode(l); })();
}

test("proxy, non-streaming: the stored event carries a UUID event_id", async (t) => {
  const key = await makeApiKey();
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(100, 20)));
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  const rows = await events(key);
  assert.equal(rows.length, 1);
  assert.match(rows[0].event_id, UUID);
});

test("proxy, streaming: the stored event carries a UUID event_id", async (t) => {
  const key = await makeApiKey();
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    body: sseBody([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 7 } })}\n\n`,
      `data: [DONE]\n\n`,
    ]),
  }));
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: { model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  const rows = await eventually(async () => { const r = await events(key); return r.length ? r : null; });
  assert.ok(rows, "the streamed event was metered");
  assert.match(rows[0].event_id, UUID);
});

test("proxy, exact-cache hit: both the miss and the hit get distinct UUID event_ids", async (t) => {
  const key = await makeApiKey();
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(200, 50)));
  const body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "cache me for the event id test" }] };
  const h = { "X-API-Key": key, ...PK, "X-Enable-Cache": "true" };
  assert.equal((await post("/api/proxy/openai", { headers: h, body })).headers["x-finops-cache"], "MISS");
  assert.equal((await post("/api/proxy/openai", { headers: h, body })).headers["x-finops-cache"], "HIT");
  const rows = await events(key);
  assert.equal(rows.length, 2);
  assert.ok(JSON.parse(rows[1].raw_json).cacheHit, "the second row is the cache hit");
  for (const r of rows) assert.match(r.event_id, UUID);
  assert.notEqual(rows[0].event_id, rows[1].event_id);
});

test("proxy, semantic-cache hit: the hit's event carries a UUID event_id", async (t) => {
  const key = await makeApiKey();
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(150, 30)));
  const body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "explain how semantic caching saves money on repeated questions" }] };
  const h = { "X-API-Key": key, ...PK, "X-Enable-Semantic-Cache": "true" };
  await post("/api/proxy/openai", { headers: h, body });
  const second = await post("/api/proxy/openai", { headers: h, body });
  assert.equal(second.headers["x-finops-cache"], "SEMANTIC-HIT", "precondition: the second call was served from the semantic cache");
  const rows = await events(key);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r.event_id, UUID);
  assert.notEqual(rows[0].event_id, rows[1].event_id);
});

test("ingest: each event carries its own UUID event_id", async () => {
  const key = await makeApiKey();
  const body = { provider: "openai", model: "gpt-4o-mini", team: "eng", environment: "prod", input_tokens: 10, output_tokens: 10 };
  assert.equal((await post("/api/ingest", { headers: { "X-API-Key": key }, body })).status, 201);
  assert.equal((await post("/api/ingest", { headers: { "X-API-Key": key }, body })).status, 201);
  const rows = await events(key);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r.event_id, UUID);
  assert.notEqual(rows[0].event_id, rows[1].event_id, "two separate calls are two separate events, never merged");
});

test("an insert that COMMITTED but whose acknowledgement was lost is spooled, then replays as a duplicate - billed once", async (t) => {
  const key = await makeApiKey();
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(200, 50)));
  const realRun = storage.run.bind(storage);
  let fired = false;
  t.mock.method(storage, "run", async (sql, params) => {
    const r = await realRun(sql, params);
    if (!fired && /INSERT INTO usage_events/.test(sql)) { fired = true; throw new Error("connection lost after commit"); }
    return r;
  });
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: { model: "gpt-4.1", messages: [{ role: "user", content: "hello there" }] } });
  t.mock.restoreAll();
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-finops-metering"], "failed", "the proxy believed the write failed");

  assert.equal((await events(key)).length, 1, "but the row was in fact stored");
  const entry = JSON.parse(fs.readFileSync(SPOOL, "utf8").trim());
  assert.match(entry.row.event_id, UUID, "the spooled row carries the id minted when the event was first built");
  assert.equal((await events(key))[0].event_id, entry.row.event_id, "the same id that the committed row has");

  const result = await replaySpool();
  assert.deepEqual(result, { total: 1, replayed: 0, duplicates: 1, remaining: 0 });
  assert.equal((await events(key)).length, 1, "before this fix: two rows, so the call was billed twice");
});
