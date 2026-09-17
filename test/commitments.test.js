// test/commitments.test.js
//
// Exercises both the route (create/list/delete) and the underlying burn
// calculation + alert-tier logic in commitments.js. deliverAlert is NOT
// mocked here, same reasoning as alerts.test.js: with no Slack/webhook/SMTP
// env vars configured in this test environment, it already degrades to a
// local alerts_log write with no network call.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-commitments-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-commitments-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_commitments_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const commitmentsRoute = require("../server/routes/commitments");
const { checkCommitmentAlerts } = require("../server/commitments");

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/commitments", commitmentsRoute);
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
      console.warn(`[commitments.test.js] Failed to drop test schema: ${err.message}`);
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
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: pathName,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let keyCounter = 0;
async function makeApiKey(role = "admin") {
  keyCounter++;
  const key_id = `fk_test_commitments_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

async function seedSpend({ provider, cost_usd, event_time }) {
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, ?, 'gpt-4o', ?, 1)",
    [event_time || new Date().toISOString(), provider, cost_usd]
  );
}

test("creating a commitment requires provider, label, and initial_amount_usd", async () => {
  const key_id = await makeApiKey();
  const res = await request("/api/commitments", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { provider: "openai" },
  });
  assert.equal(res.status, 400);
});

test("a viewer cannot create a commitment", async () => {
  const key_id = await makeApiKey("viewer");
  const res = await request("/api/commitments", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { provider: "openai", label: "test", initial_amount_usd: 100 },
  });
  assert.equal(res.status, 403);
});

test("creates a commitment and reports burned/remaining/pct_remaining against real usage", async () => {
  const admin = await makeApiKey();
  const provider = `commit-provider-${process.pid}`;
  const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago

  const createRes = await request("/api/commitments", {
    method: "POST",
    headers: { "X-API-Key": admin },
    body: { provider, label: "Annual OpenAI credits", initial_amount_usd: 100, starts_at: startsAt },
  });
  assert.equal(createRes.status, 201);

  await seedSpend({ provider, cost_usd: 30 });
  await seedSpend({ provider, cost_usd: 10 });
  // Spend on a DIFFERENT provider must not count against this commitment
  await seedSpend({ provider: `${provider}-other`, cost_usd: 1000 });

  const listRes = await request("/api/commitments", { headers: { "X-API-Key": admin } });
  assert.equal(listRes.status, 200);
  const c = listRes.json.find((row) => row.provider === provider);
  assert.ok(c, "expected the created commitment to appear in the list");
  assert.equal(c.burned_usd, 40);
  assert.equal(c.remaining_usd, 60);
  assert.equal(c.pct_remaining, 60);
  assert.equal(c.tier, "healthy");
});

test("tier drops to 'low' then 'critical' then 'exhausted' as burn approaches the full amount", async () => {
  const admin = await makeApiKey();
  const provider = `commit-tier-${process.pid}`;
  await request("/api/commitments", {
    method: "POST",
    headers: { "X-API-Key": admin },
    body: { provider, label: "Tier test", initial_amount_usd: 100 },
  });

  await seedSpend({ provider, cost_usd: 85 }); // 15% remaining -> low (<=20%, >10%)
  let listRes = await request("/api/commitments", { headers: { "X-API-Key": admin } });
  let c = listRes.json.find((row) => row.provider === provider);
  assert.equal(c.tier, "low");

  await seedSpend({ provider, cost_usd: 7 }); // 8% remaining -> critical (<=10%)
  listRes = await request("/api/commitments", { headers: { "X-API-Key": admin } });
  c = listRes.json.find((row) => row.provider === provider);
  assert.equal(c.tier, "critical");

  await seedSpend({ provider, cost_usd: 20 }); // over 100% burned -> exhausted
  listRes = await request("/api/commitments", { headers: { "X-API-Key": admin } });
  c = listRes.json.find((row) => row.provider === provider);
  assert.equal(c.tier, "exhausted");
  assert.ok(c.remaining_usd < 0, "remaining_usd should go negative once burn exceeds the commitment");
});

test("checkCommitmentAlerts fires each remaining-balance tier exactly once", async () => {
  const admin = await makeApiKey();
  const provider = `commit-alert-${process.pid}`;
  const createRes = await request("/api/commitments", {
    method: "POST",
    headers: { "X-API-Key": admin },
    body: { provider, label: "Alert test", initial_amount_usd: 100 },
  });
  const commitmentId = createRes.json.id;

  await seedSpend({ provider, cost_usd: 95 }); // 5% remaining -> both 20pct and 10pct tiers crossed
  await checkCommitmentAlerts();
  await checkCommitmentAlerts(); // second call must NOT re-fire already-fired tiers

  const firedRows = await storage.all(
    "SELECT tier FROM commitment_alert_state WHERE commitment_id = ?",
    [commitmentId]
  );
  const tiers = firedRows.map((r) => r.tier).sort();
  assert.deepEqual(tiers, ["10pct-remaining", "20pct-remaining"]);

  const alertRows = await storage.all(
    "SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'commitment' AND message LIKE ?",
    [`%Alert test%`]
  );
  // Two distinct tiers fired = two distinct delivered messages, not
  // duplicated by the second checkCommitmentAlerts() call above.
  assert.equal(Number(alertRows[0].n), 2);
});

test("deleting a commitment also clears its alert-fired state", async () => {
  const admin = await makeApiKey();
  const provider = `commit-delete-${process.pid}`;
  const createRes = await request("/api/commitments", {
    method: "POST",
    headers: { "X-API-Key": admin },
    body: { provider, label: "Delete test", initial_amount_usd: 50 },
  });
  const id = createRes.json.id;
  await seedSpend({ provider, cost_usd: 49 });
  await checkCommitmentAlerts();

  const delRes = await request(`/api/commitments/${id}`, { method: "DELETE", headers: { "X-API-Key": admin } });
  assert.equal(delRes.status, 200);

  const remaining = await storage.all("SELECT * FROM commitments WHERE id = ?", [id]);
  assert.equal(remaining.length, 0);
  const alertState = await storage.all("SELECT * FROM commitment_alert_state WHERE commitment_id = ?", [id]);
  assert.equal(alertState.length, 0);
});
