// test/budgets.test.js
//
// server/routes/budgets.js had ZERO automated test coverage before this
// file. The riskiest part isn't the simple CRUD - it's /status's
// scope_type -> column mapping (team/key/environment) and the tier
// thresholds, both of which are easy to get subtly wrong (off-by-one on a
// boundary, or scoping a key's budget against the wrong column) without
// ever throwing an error - just quietly reporting the wrong number.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-budgets-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-budgets-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_budgets_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const budgetsRoute = require("../server/routes/budgets");

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/budgets", budgetsRoute);
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
      console.warn(`[budgets.test.js] Failed to drop test schema: ${err.message}`);
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
  const key_id = `fk_test_budgets_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

test("rejects a request with no API key once at least one key already exists", async () => {
  await makeApiKey();
  const res = await request("/api/budgets");
  assert.equal(res.status, 401);
});

test("POST / rejects a developer-role key (lacks manage_budgets) with 403", async () => {
  const key_id = await makeApiKey("developer");
  const res = await request("/api/budgets", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team", scope_value: "eng", monthly_limit_usd: 100 },
  });
  assert.equal(res.status, 403);
});

test("POST / allows a budget-manager-role key (has manage_budgets, not manage_keys)", async () => {
  const key_id = await makeApiKey("budget-manager");
  const res = await request("/api/budgets", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team", scope_value: `bm-team-${process.pid}`, monthly_limit_usd: 100 },
  });
  assert.equal(res.status, 201);
});

test("POST / rejects a request missing required fields with 400", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/budgets", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team" },
  });
  assert.equal(res.status, 400);
});

test("POST / creates a budget, returns its id, and logs a budget.create audit entry", async () => {
  const key_id = await makeApiKey();
  const auditBefore = await storage.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'budget.create'");

  const res = await request("/api/budgets", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team", scope_value: `create-team-${process.pid}`, monthly_limit_usd: 250 },
  });
  assert.equal(res.status, 201);
  assert.ok(typeof res.json.id === "number" || typeof res.json.id === "bigint" || typeof res.json.id === "string");

  const row = await storage.get("SELECT * FROM budgets WHERE id = ?", [res.json.id]);
  assert.ok(row);
  assert.equal(row.monthly_limit_usd, 250);

  const auditAfter = await storage.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'budget.create'");
  assert.equal(Number(auditAfter.n), Number(auditBefore.n) + 1);
});

test("GET / lists budgets, most recently created first", async () => {
  const key_id = await makeApiKey();
  const teamA = `list-team-a-${process.pid}`;
  const teamB = `list-team-b-${process.pid}`;
  await request("/api/budgets", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team", scope_value: teamA, monthly_limit_usd: 10 },
  });
  await request("/api/budgets", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { scope_type: "team", scope_value: teamB, monthly_limit_usd: 20 },
  });

  const res = await request("/api/budgets", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  const values = res.json.map((b) => b.scope_value);
  assert.ok(values.indexOf(teamB) < values.indexOf(teamA), "the more recently created budget should be listed first");
});

test("GET /status classifies spend into the correct tier at each threshold boundary", async () => {
  const key_id = await makeApiKey();

  const cases = [
    { pct: 0.1, tier: "ok" },
    { pct: 0.5, tier: "50%" },
    { pct: 0.8, tier: "80%" },
    { pct: 0.9, tier: "90%" },
    { pct: 1.2, tier: "exceeded" },
  ];

  for (const { pct, tier } of cases) {
    const team = `status-team-${tier.replace("%", "pct")}-${process.pid}`;
    await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 100)", [team]);
    await storage.run(
      "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, ?, 1)",
      [new Date().toISOString(), team, pct * 100]
    );

    const res = await request("/api/budgets/status", { headers: { "X-API-Key": key_id } });
    assert.equal(res.status, 200);
    const entry = res.json.find((b) => b.scope_value === team);
    assert.ok(entry, `expected a /status entry for ${team}`);
    assert.equal(entry.alert_tier, tier, `spend at ${pct * 100}% of budget should classify as tier '${tier}'`);
  }
});

test("GET /status scopes 'key' budgets against user_id and 'environment' budgets against environment, not team", async () => {
  const key_id = await makeApiKey();
  const targetKey = `scoped-key-${process.pid}`;
  const targetEnv = `scoped-env-${process.pid}`;

  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('key', ?, 10)", [targetKey]);
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('environment', ?, 10)", [
    targetEnv,
  ]);

  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, user_id, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 5, 1)",
    [new Date().toISOString(), targetKey]
  );
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, environment, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 5, 1)",
    [new Date().toISOString(), targetEnv]
  );
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 999, 1)",
    [new Date().toISOString(), targetKey]
  );

  const res = await request("/api/budgets/status", { headers: { "X-API-Key": key_id } });
  const keyEntry = res.json.find((b) => b.scope_value === targetKey && b.scope_type === "key");
  const envEntry = res.json.find((b) => b.scope_value === targetEnv);

  assert.equal(keyEntry.spent_this_month, 5, "a key-scoped budget must sum user_id spend, not team spend under the same string");
  assert.equal(envEntry.spent_this_month, 5);
});

test("GET /status: a 'background' scope_type budget only counts workload_type='background' spend for that team, separate from the team's regular spend", async () => {
  const key_id = await makeApiKey();
  const team = `background-team-${process.pid}`;

  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('background', ?, 50)", [team]);

  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, workload_type, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 'background', 30, 1)",
    [new Date().toISOString(), team]
  );
  // Regular, non-background spend for the SAME team must not count against the background budget
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 9999, 1)",
    [new Date().toISOString(), team]
  );

  const res = await request("/api/budgets/status", { headers: { "X-API-Key": key_id } });
  const entry = res.json.find((b) => b.scope_value === team && b.scope_type === "background");
  assert.ok(entry, "expected a background-scoped /status entry");
  assert.equal(entry.spent_this_month, 30, "only the workload_type='background' spend should count, not the team's $9999 of regular spend");
});

test("GET /status only counts spend from the current calendar month", async () => {
  const key_id = await makeApiKey();
  const team = `month-boundary-team-${process.pid}`;
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 100)", [team]);

  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o-mini', ?, 10, 1)",
    [new Date().toISOString(), team]
  );
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES ('2020-01-15T00:00:00.000Z', 'openai', 'gpt-4o-mini', ?, 500, 1)",
    [team]
  );

  const res = await request("/api/budgets/status", { headers: { "X-API-Key": key_id } });
  const entry = res.json.find((b) => b.scope_value === team);
  assert.equal(entry.spent_this_month, 10, "spend from a prior year must not bleed into this month's total");
});

test("GET /status reports zero spend and 'ok' tier for a budget with no usage yet", async () => {
  const key_id = await makeApiKey();
  const team = `no-spend-team-${process.pid}`;
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 50)", [team]);

  const res = await request("/api/budgets/status", { headers: { "X-API-Key": key_id } });
  const entry = res.json.find((b) => b.scope_value === team);
  assert.equal(entry.spent_this_month, 0);
  assert.equal(entry.pct_used, 0);
  assert.equal(entry.alert_tier, "ok");
});
