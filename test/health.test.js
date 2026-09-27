// test/health.test.js - A11: real readiness, distinct from liveness.
//
// Two layers, same split as rbac.test.js:
//   1. Unit tests directly against dbHealth.js's checkDbHealth/circuit
//      breaker - the timeout and failure-threshold logic that doesn't need
//      a real HTTP server or even a real database to exercise.
//   2. Route-wiring tests booting a real Express instance with
//      routes/health.js mounted, simulating a down database the same way
//      test/proxyHardening.test.js's FINOPS_METERING_FAILURE_POLICY tests
//      do: mocking storage.get for the exact query under test rather than
//      actually taking a database down.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-health-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_health_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const dbHealth = require("../server/dbHealth");
const healthRoute = require("../server/routes/health");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch { /* ignore */ }
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch { /* ignore */ }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch { /* ignore */ }
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, text: body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- 1. dbHealth.js unit tests ----

test("checkDbHealth resolves ok:true when the probe succeeds", async () => {
  dbHealth._resetForTests();
  const result = await dbHealth.checkDbHealth(async () => "fine", { label: "unit-db" });
  assert.equal(result.ok, true);
  assert.equal(result.label, "unit-db");
  assert.equal(result.circuit, "closed");
});

test("checkDbHealth resolves ok:false with a reason when the probe rejects", async () => {
  dbHealth._resetForTests();
  const result = await dbHealth.checkDbHealth(async () => { throw new Error("boom"); }, { label: "unit-db" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /boom/);
});

test("checkDbHealth times out a probe that never resolves, rather than hanging forever", async () => {
  dbHealth._resetForTests();
  // Never-resolving probe - if withTimeout() didn't work, this test itself
  // would hang until node:test's own default timeout killed the whole run.
  // The default FINOPS_DB_HEALTH_TIMEOUT_MS (2000ms) is what actually
  // trips this, since dbHealth.js reads its constants once at require time.
  const neverResolves = () => new Promise(() => {});
  const result = await dbHealth.checkDbHealth(neverResolves, { label: "slow-db" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out/);
});

test("circuit breaker opens after consecutive failures and fails fast without calling the probe again", async () => {
  dbHealth._resetForTests();
  let calls = 0;
  const failingProbe = async () => { calls += 1; throw new Error("down"); };
  // Default threshold is 3 (FINOPS_DB_CIRCUIT_FAILURE_THRESHOLD) - drive it there.
  for (let i = 0; i < 3; i++) {
    const r = await dbHealth.checkDbHealth(failingProbe, { label: "breaker-db" });
    assert.equal(r.ok, false);
  }
  assert.equal(calls, 3, "each of the first 3 checks should have actually called the probe");
  const opened = await dbHealth.checkDbHealth(failingProbe, { label: "breaker-db" });
  assert.equal(opened.ok, false);
  assert.match(opened.reason, /circuit open/);
  assert.equal(calls, 3, "the 4th check should have failed FAST - the probe must not have been called again");
});

test("circuit breaker recovers (closes) after a successful check", async () => {
  dbHealth._resetForTests();
  const failingProbe = async () => { throw new Error("down"); };
  for (let i = 0; i < 3; i++) await dbHealth.checkDbHealth(failingProbe, { label: "recover-db" });
  assert.equal(dbHealth.getCircuitBreakerStatus().state, "open");
  // Force the open window to have elapsed so the next check is a real trial.
  dbHealth._resetForTests();
  const recovered = await dbHealth.checkDbHealth(async () => "fine", { label: "recover-db" });
  assert.equal(recovered.ok, true);
  assert.equal(dbHealth.getCircuitBreakerStatus().state, "closed");
});

// ---- 2. GET /health/ready route-wiring tests ----

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/health", healthRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("GET /health/ready returns 200 and ok:true when the database is reachable", async () => {
  dbHealth._resetForTests();
  const res = await request(server, "GET", "/health/ready");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.checks.db, "ok");
});

test("GET /health/ready returns 503 with a specific reason when the database is unreachable", async (t) => {
  dbHealth._resetForTests();
  const realGet = storage.get.bind(storage);
  t.mock.method(storage, "get", async (sql, params) => {
    if (/^SELECT 1 AS ok/.test(sql)) throw new Error("simulated DB outage");
    return realGet(sql, params);
  });
  const res = await request(server, "GET", "/health/ready");
  assert.equal(res.status, 503);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.checks.db.ok, false);
  assert.match(res.json.checks.db.reason, /simulated DB outage/);
});

test("GET /health/ready recovers to 200 once the database is reachable again", async (t) => {
  dbHealth._resetForTests();
  const realGet = storage.get.bind(storage);
  t.mock.method(storage, "get", async (sql, params) => {
    if (/^SELECT 1 AS ok/.test(sql)) throw new Error("still down");
    return realGet(sql, params);
  });
  const down = await request(server, "GET", "/health/ready");
  assert.equal(down.status, 503);

  t.mock.restoreAll();
  dbHealth._resetForTests(); // clear the circuit the mocked failures may have tripped
  const up = await request(server, "GET", "/health/ready");
  assert.equal(up.status, 200);
  assert.equal(up.json.ok, true);
});

if (isPostgres) {
  test("GET /health/ready reports Postgres connection-pool stats (total/idle/waiting)", async () => {
    dbHealth._resetForTests();
    const res = await request(server, "GET", "/health/ready");
    assert.equal(res.status, 200);
    assert.ok(res.json.checks.dbPool, "expected a dbPool block on Postgres");
    assert.equal(typeof res.json.checks.dbPool.total, "number");
    assert.equal(typeof res.json.checks.dbPool.idle, "number");
    assert.equal(typeof res.json.checks.dbPool.waiting, "number");
    assert.equal(typeof res.json.checks.dbPool.exhausted, "boolean");
  });
} else {
  test("GET /health/ready has no dbPool block on SQLite (no pool concept to report)", async () => {
    dbHealth._resetForTests();
    const res = await request(server, "GET", "/health/ready");
    assert.equal(res.status, 200);
    assert.equal(res.json.checks.dbPool, undefined);
  });
}
