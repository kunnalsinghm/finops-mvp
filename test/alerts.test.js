// test/alerts.test.js
//
// server/routes/alerts.js had ZERO automated test coverage before this
// file. checkBudgetAlerts/checkBurnRate themselves have no unit tests
// either (they're wired directly into this route and into ingest.js's
// post-write hook) - this exercises them for real, through the actual
// route, seeding real budgets/usage_events and checking real alerts_log
// and budget_alert_state rows come out the other side. deliverAlert is
// NOT mocked: with no SLACK_WEBHOOK_URL/FINOPS_WEBHOOK_URL/SMTP env vars
// set (true in this test environment), it already falls back to a pure
// local DB write with no network call - see alertDelivery.test.js's own
// "always logs locally even when no channels are configured" test for the
// same guarantee at the unit level.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-alerts-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-alerts-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_alerts_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const alertsRoute = require("../server/routes/alerts");

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/alerts", alertsRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[alerts.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

function request(pathName, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const reqHeaders = { "Content-Type": "application/json", ...headers };
    if (data !== undefined) reqHeaders["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(
      { hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers: reqHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

let keyCounter = 0;
async function makeApiKey(role = "admin") {
  keyCounter++;
  const key_id = `fk_test_alerts_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

test("rejects a request with no API key once at least one key already exists", async () => {
  await makeApiKey();
  const res = await request("/api/alerts");
  assert.equal(res.status, 401);
});

test("GET / returns alerts_log rows, most recent first", async () => {
  const key_id = await makeApiKey();
  await storage.run("INSERT INTO alerts_log (type, message, created_at) VALUES ('budget', 'first', ?)", [
    new Date().toISOString(),
  ]);
  await storage.run("INSERT INTO alerts_log (type, message, created_at) VALUES ('budget', 'second', ?)", [
    new Date().toISOString(),
  ]);

  const res = await request("/api/alerts", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
  assert.equal(res.json[0].message, "second", "most recently inserted row should come first");
  assert.equal(res.json[1].message, "first");
});

test("POST /:id/ack marks the specific alert acknowledged, and does not touch others", async () => {
  const key_id = await makeApiKey();
  const inserted = await storage.run(
    "INSERT INTO alerts_log (type, message, created_at, acknowledged) VALUES ('budget', 'ack me', ?, 0) RETURNING id",
    [new Date().toISOString()]
  );
  const otherId = (
    await storage.run(
      "INSERT INTO alerts_log (type, message, created_at, acknowledged) VALUES ('budget', 'leave me', ?, 0) RETURNING id",
      [new Date().toISOString()]
    )
  ).lastInsertRowid;

  const res = await request(`/api/alerts/${inserted.lastInsertRowid}/ack`, {
    method: "POST",
    headers: { "X-API-Key": key_id },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  const acked = await storage.get("SELECT acknowledged FROM alerts_log WHERE id = ?", [inserted.lastInsertRowid]);
  assert.equal(acked.acknowledged, 1);
  const untouched = await storage.get("SELECT acknowledged FROM alerts_log WHERE id = ?", [otherId]);
  assert.equal(untouched.acknowledged, 0);
});

test("POST /check-now fires a 50% budget alert exactly once, then does not re-fire it on a second call", async () => {
  const key_id = await makeApiKey();
  const team = `alerts-team-${process.pid}`;
  const budget = await storage.run(
    "INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 10) RETURNING id",
    [team]
  );
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 5, 1)",
    [new Date().toISOString(), team]
  );

  const alertsBefore = await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'budget'");

  const first = await request("/api/alerts/check-now", { method: "POST", headers: { "X-API-Key": key_id } });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);

  const firedRow = await storage.get(
    "SELECT * FROM budget_alert_state WHERE budget_id = ? AND tier = '50%'",
    [budget.lastInsertRowid]
  );
  assert.ok(firedRow, "expected the 50% tier to be marked fired for this budget/month");

  const alertsAfterFirst = await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'budget'");
  assert.equal(alertsAfterFirst.n, alertsBefore.n + 1, "expected exactly one new budget alert logged");

  const second = await request("/api/alerts/check-now", { method: "POST", headers: { "X-API-Key": key_id } });
  assert.equal(second.status, 200);
  const alertsAfterSecond = await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'budget'");
  assert.equal(alertsAfterSecond.n, alertsAfterFirst.n, "re-running check-now must not duplicate an already-fired tier alert");
});

test("POST /check-now does not fire any tier for a budget under 50% spend", async () => {
  const key_id = await makeApiKey();
  const team = `alerts-under-team-${process.pid}`;
  const budget = await storage.run(
    "INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 100) RETURNING id",
    [team]
  );
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 1, 1)",
    [new Date().toISOString(), team]
  );

  await request("/api/alerts/check-now", { method: "POST", headers: { "X-API-Key": key_id } });

  const firedRow = await storage.get("SELECT * FROM budget_alert_state WHERE budget_id = ?", [budget.lastInsertRowid]);
  assert.equal(firedRow, undefined, "a budget at 1% spend should not have any tier marked fired");
});
