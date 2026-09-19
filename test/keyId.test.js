// test/keyId.test.js - usage_events.key_id: the API key that actually
// authenticated each event.
//
// Why it exists: downstream consumers (e.g. an autonomous-action layer that
// needs to quarantine "the key behind agent X") must be able to go from a usage
// row to a real, revocable API key. user_id can't serve: the proxy fills it with
// the key, but /api/ingest lets the CLIENT declare it. A first draft of this
// feature added the column and the row field but never the INSERT, so the
// column would have stayed empty - hence tests that read it back from the DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-keyid-\d+\.db/.test(f)) { try { fs.unlinkSync(path.join(__dirname, f)); } catch {} }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-keyid-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_keyid_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const proxyRoute = require("../server/routes/proxy");
const ingestRoute = require("../server/routes/ingest");
const { realKeyId } = require("../server/keyIdentity");

let server;
test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/proxy", proxyRoute);
  app.use("/api/ingest", ingestRoute);
  server = await new Promise((resolve, reject) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); s.on("error", reject); });
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
});

function post(pathName, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port: server.address().port, path: pathName, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks = []; res.on("data", (c) => chunks.push(c));
        res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
      });
    req.on("error", reject); req.write(data); req.end();
  });
}
let n = 0;
async function makeKey(role = "developer") {
  n++; const key_id = `fk_test_keyid_${role}_${n}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [key_id, `k${n}`, role]);
  return key_id;
}
const PK = { "X-Provider-Key": "sk-x" };
const oai = (i, o) => ({ id: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: i, completion_tokens: o } });
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
async function eventually(fn) { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } }

test("realKeyId: real keys pass through; session logins, bootstrap and empties are NULL", () => {
  assert.equal(realKeyId("fk_abc"), "fk_abc");
  assert.equal(realKeyId({ key_id: "fk_abc", team: "x" }), "fk_abc");
  assert.equal(realKeyId("bootstrap"), null);
  assert.equal(realKeyId("user:alice"), null);
  assert.equal(realKeyId(undefined), null);
  assert.equal(realKeyId({}), null);
});

test("proxy: a non-streaming event records the authenticating key in key_id", async (t) => {
  const key = await makeKey();
  t.mock.method(global, "fetch", async () => ok(oai(10, 10)));
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  const row = await storage.get("SELECT key_id, user_id FROM usage_events WHERE user_id = ? ORDER BY id DESC LIMIT 1", [key]);
  assert.equal(row.key_id, key, "the column must actually be written, not just declared");
});

test("proxy: exact-cache hits also record key_id", async (t) => {
  const key = await makeKey();
  t.mock.method(global, "fetch", async () => ok(oai(10, 10)));
  const body = { model: "gpt-4.1", messages: [{ role: "user", content: `cache me ${process.pid}` }] };
  const h = { "X-API-Key": key, ...PK, "X-Enable-Cache": "true" };
  await post("/api/proxy/openai", { headers: h, body });
  const hit = await post("/api/proxy/openai", { headers: h, body });
  assert.equal(hit.headers["x-finops-cache"], "HIT");
  const rows = await storage.all("SELECT key_id, cost_usd FROM usage_events WHERE user_id = ? ORDER BY id", [key]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.key_id === key), "both the miss and the cache hit are attributed to the key");
});

test("proxy: a streaming event records key_id", async (t) => {
  const key = await makeKey();
  const enc = new TextEncoder();
  const sse = (async function* () {
    yield enc.encode(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n`);
    yield enc.encode(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}\n\n`);
  })();
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, body: sse }));
  await post("/api/proxy/anthropic", { headers: { "X-API-Key": key, ...PK }, body: { model: "claude-haiku-4-5", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] } });
  const row = await eventually(() => storage.get("SELECT key_id FROM usage_events WHERE user_id = ? ORDER BY id DESC LIMIT 1", [key]));
  assert.equal(row.key_id, key);
});

test("ingest: key_id is the AUTHENTICATED key even when the client declares a different user_id", async () => {
  const key = await makeKey();
  const res = await post("/api/ingest", { headers: { "X-API-Key": key }, body: { provider: "openai", model: "gpt-4.1", input_tokens: 1, output_tokens: 1, user_id: "someone-else", team: "t", environment: "e" } });
  assert.equal(res.status, 201);
  const row = await storage.get("SELECT key_id, user_id FROM usage_events WHERE user_id = 'someone-else' ORDER BY id DESC LIMIT 1");
  assert.equal(row.user_id, "someone-else", "user_id stays whatever the client declared");
  assert.equal(row.key_id, key, "key_id cannot be spoofed via the request body");
});

test("ingest: a client cannot forge key_id by sending it in the body", async () => {
  const key = await makeKey();
  await post("/api/ingest", { headers: { "X-API-Key": key }, body: { provider: "openai", model: "gpt-4.1", input_tokens: 1, output_tokens: 1, user_id: "forger", key_id: "fk_victim_key", team: "t", environment: "e" } });
  const row = await storage.get("SELECT key_id FROM usage_events WHERE user_id = 'forger' ORDER BY id DESC LIMIT 1");
  assert.equal(row.key_id, key);
});

test("upgrade: an existing SQLite database gains key_id and is backfilled only where user_id is a real key",
  { skip: isPostgres ? "SQLite upgrade path; the Postgres path is exercised against a live server separately" : false },
  () => {
    const legacy = path.join(__dirname, `.tmp-keyid-legacy-${process.pid}.db`);
    for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(legacy + s); } catch {} }
    // Runs in a child process because storage/sqlite.js opens its file at require time.
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const { SCHEMA_SQL } = require(${JSON.stringify(path.join(__dirname, "..", "server", "storage", "schema.sqlite.js"))});
      // A PRE-upgrade database is exactly the frozen v1 baseline (which has no key_id / allow_background).
      const old = new DatabaseSync(${JSON.stringify(legacy)});
      old.exec(SCHEMA_SQL.replace(/^\\s*key_id TEXT,\\s*--.*$/m, ""));
      const cols = old.prepare("PRAGMA table_info(usage_events)").all().map(c => c.name);
      if (cols.includes("key_id")) throw new Error("test setup failed: legacy table still has key_id");
      old.prepare("INSERT INTO api_keys (key_id,label,role) VALUES ('fk_real','r','developer')").run();
      const ins = old.prepare("INSERT INTO usage_events (event_time,provider,model,user_id,input_tokens,output_tokens,cost_usd,tagged) VALUES (?,?,?,?,?,?,?,0)");
      ins.run("2026-01-01T00:00:00Z","openai","gpt-4o","fk_real",1,1,0.1);       // proxy-style row: user_id IS a key
      ins.run("2026-01-01T00:00:00Z","openai","gpt-4o","client-declared",1,1,0.1); // ingest-style row: not a key
      ins.run("2026-01-01T00:00:00Z","openai","gpt-4o",null,1,1,0.1);
      old.close();
      process.env.FINOPS_DB_PATH = ${JSON.stringify(legacy)};
      const storage = require(${JSON.stringify(path.join(__dirname, "..", "server", "storage"))});
      (async () => {
        await storage.ready;
        const rows = await storage.all("SELECT user_id, key_id FROM usage_events ORDER BY id");
        console.log("RESULT:" + JSON.stringify(rows));
        // second boot must not re-run the backfill or fail
        process.exit(0);
      })();`;
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, FINOPS_DB_DRIVER: "", FINOPS_SKIP_PREMIGRATION_BACKUP: "true" } }); // snapshots are covered in migrator.test.js; keep the repo clean
    for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(legacy + s); } catch {} }
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout.split("RESULT:")[1]);
    assert.deepEqual(rows, [
      { user_id: "fk_real", key_id: "fk_real" },
      { user_id: "client-declared", key_id: null },
      { user_id: null, key_id: null },
    ]);
  });
