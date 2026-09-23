// test/gitops.test.js
//
// server/routes/gitops.js had ZERO automated test coverage before this
// file. The interesting risk here isn't the upsert half - it's the DRIFT
// REMOVAL half: any budget in the DB that ISN'T in finops.yaml gets
// deleted on sync. That's a destructive operation triggered by a file
// write, with no dry-run or confirmation step, so it deserves real
// coverage of update/create/remove all working together in one sync pass.
//
// gitops.js reads from a HARDCODED path (repoRoot/finops.yaml) with no way
// to inject a different path for testing, so this test backs up whatever
// is really there before overwriting it, and restores it in test.after -
// running this suite must never permanently clobber the repo's real
// finops.yaml.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-gitops-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-gitops-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_gitops_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const { router: gitopsRoute } = require("../server/routes/gitops");

const CONFIG_PATH = path.join(__dirname, "..", "finops.yaml");
let originalConfigContent = null;
let originalConfigExisted = false;

let server;

test.before(async () => {
  await storage.ready;

  originalConfigExisted = fs.existsSync(CONFIG_PATH);
  if (originalConfigExisted) {
    originalConfigContent = fs.readFileSync(CONFIG_PATH, "utf8");
  }

  const app = express();
  app.use(express.json());
  app.use("/api/gitops", gitopsRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));

  if (originalConfigExisted) {
    fs.writeFileSync(CONFIG_PATH, originalConfigContent, "utf8");
  } else {
    try { fs.unlinkSync(CONFIG_PATH); } catch {}
  }

  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[gitops.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

function writeConfig(yamlText) {
  fs.writeFileSync(CONFIG_PATH, yamlText, "utf8");
}

function request(pathName, { method = "POST", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers },
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
    req.end();
  });
}

let keyCounter = 0;
async function makeApiKey(role = "admin") {
  keyCounter++;
  const key_id = `fk_test_gitops_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

test("POST /sync rejects a developer-role key (lacks manage_budgets) with 403", async () => {
  const key_id = await makeApiKey("developer");
  writeConfig("budgets: []");
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 403);
});

test("POST /sync returns 400 with a clear error when finops.yaml doesn't exist", async () => {
  const key_id = await makeApiKey();
  try { fs.unlinkSync(CONFIG_PATH); } catch {}

  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /finops\.yaml not found/);
});

test("POST /sync creates budgets that don't exist yet in the DB", async () => {
  const key_id = await makeApiKey();
  const team = `gitops-new-${process.pid}`;
  writeConfig(`budgets:\n  - scope_type: team\n    scope_value: ${team}\n    monthly_limit_usd: 40\n`);

  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.created, 1);
  assert.equal(res.json.updated, 0);
  assert.equal(res.json.removed, 0);

  const row = await storage.get("SELECT * FROM budgets WHERE scope_type = 'team' AND scope_value = ?", [team]);
  assert.ok(row);
  assert.equal(row.monthly_limit_usd, 40);
});

test("POST /sync updates the limit for a budget that already exists with a different value", async () => {
  const key_id = await makeApiKey();
  const team = `gitops-update-${process.pid}`;
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 40)", [team]);

  writeConfig(`budgets:\n  - scope_type: team\n    scope_value: ${team}\n    monthly_limit_usd: 999\n`);
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });

  assert.equal(res.status, 200);
  assert.equal(res.json.updated, 1);
  assert.equal(res.json.created, 0);

  const row = await storage.get("SELECT * FROM budgets WHERE scope_type = 'team' AND scope_value = ?", [team]);
  assert.equal(row.monthly_limit_usd, 999);
});

test("POST /sync leaves an existing budget alone (no spurious update) when the file's value already matches", async () => {
  const key_id = await makeApiKey();
  const team = `gitops-nochange-${process.pid}`;
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 77)", [team]);

  writeConfig(`budgets:\n  - scope_type: team\n    scope_value: ${team}\n    monthly_limit_usd: 77\n`);
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });

  assert.equal(res.status, 200);
  assert.equal(res.json.updated, 0, "an unchanged value must not be counted/treated as an update");
  assert.equal(res.json.created, 0);
});

test("POST /sync REMOVES a budget from the DB that is no longer present in finops.yaml (drift removal)", async () => {
  const key_id = await makeApiKey();
  const keptTeam = `gitops-kept-${process.pid}`;
  const droppedTeam = `gitops-dropped-${process.pid}`;
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 10)", [keptTeam]);
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 10)", [droppedTeam]);

  writeConfig(`budgets:\n  - scope_type: team\n    scope_value: ${keptTeam}\n    monthly_limit_usd: 10\n`);
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });

  assert.equal(res.status, 200);
  assert.ok(res.json.removed >= 1);

  const kept = await storage.get("SELECT * FROM budgets WHERE scope_type = 'team' AND scope_value = ?", [keptTeam]);
  const dropped = await storage.get("SELECT * FROM budgets WHERE scope_type = 'team' AND scope_value = ?", [droppedTeam]);
  assert.ok(kept, "a budget still listed in the file must survive sync");
  assert.equal(dropped, undefined, "a budget removed from the file must be deleted from the DB on sync");
});

test("POST /sync with an empty budgets list removes ALL existing budgets", async () => {
  const key_id = await makeApiKey();
  const team = `gitops-wipe-${process.pid}`;
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 10)", [team]);

  writeConfig("budgets: []");
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });

  assert.equal(res.status, 200);
  assert.ok(res.json.removed >= 1);
  const row = await storage.get("SELECT * FROM budgets WHERE scope_type = 'team' AND scope_value = ?", [team]);
  assert.equal(row, undefined);
});

test("POST /sync treats a completely empty/missing 'budgets:' key as zero desired budgets, not an error", async () => {
  const key_id = await makeApiKey();
  writeConfig("# no budgets key at all\n");
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 0);
});

test("POST /sync creates a tagging rule from a 'tagging_rules:' entry, keyed on match.api_key_prefix", async () => {
  const key_id = await makeApiKey();
  const prefix = `fk_gitops_new_${process.pid}_`;
  writeConfig(
    `budgets: []\ntagging_rules:\n  - match:\n      api_key_prefix: ${prefix}\n    assign:\n      team: growth\n      environment: prod\n`
  );

  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.tagging_rules.created, 1);
  assert.equal(res.json.tagging_rules.updated, 0);
  assert.equal(res.json.tagging_rules.removed, 0);

  const row = await storage.get("SELECT * FROM tag_rules WHERE api_key_prefix = ?", [prefix]);
  assert.ok(row);
  assert.equal(row.team, "growth");
  assert.equal(row.environment, "prod");
});

test("POST /sync updates an existing tagging rule's assigned fields when they change in the file", async () => {
  const key_id = await makeApiKey();
  const prefix = `fk_gitops_update_${process.pid}_`;
  await storage.run("INSERT INTO tag_rules (api_key_prefix, team) VALUES (?, 'old-team')", [prefix]);

  writeConfig(`budgets: []\ntagging_rules:\n  - match:\n      api_key_prefix: ${prefix}\n    assign:\n      team: new-team\n`);
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });

  assert.equal(res.status, 200);
  assert.equal(res.json.tagging_rules.updated, 1);
  assert.equal(res.json.tagging_rules.created, 0);

  const row = await storage.get("SELECT * FROM tag_rules WHERE api_key_prefix = ?", [prefix]);
  assert.equal(row.team, "new-team");
});

test("POST /sync leaves an existing tagging rule alone (no spurious update) when the file's assignment already matches", async () => {
  const key_id = await makeApiKey();
  const prefix = `fk_gitops_nochange_${process.pid}_`;
  await storage.run("INSERT INTO tag_rules (api_key_prefix, team) VALUES (?, 'growth')", [prefix]);

  writeConfig(`budgets: []\ntagging_rules:\n  - match:\n      api_key_prefix: ${prefix}\n    assign:\n      team: growth\n`);
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });

  assert.equal(res.status, 200);
  assert.equal(res.json.tagging_rules.updated, 0);
  assert.equal(res.json.tagging_rules.created, 0);
});

test("POST /sync REMOVES a tagging rule no longer present in finops.yaml (drift removal), same as budgets", async () => {
  const key_id = await makeApiKey();
  const keptPrefix = `fk_gitops_kept_${process.pid}_`;
  const droppedPrefix = `fk_gitops_dropped_${process.pid}_`;
  await storage.run("INSERT INTO tag_rules (api_key_prefix, team) VALUES (?, 'growth')", [keptPrefix]);
  await storage.run("INSERT INTO tag_rules (api_key_prefix, team) VALUES (?, 'growth')", [droppedPrefix]);

  writeConfig(`budgets: []\ntagging_rules:\n  - match:\n      api_key_prefix: ${keptPrefix}\n    assign:\n      team: growth\n`);
  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });

  assert.equal(res.status, 200);
  assert.ok(res.json.tagging_rules.removed >= 1);
  const kept = await storage.get("SELECT * FROM tag_rules WHERE api_key_prefix = ?", [keptPrefix]);
  const dropped = await storage.get("SELECT * FROM tag_rules WHERE api_key_prefix = ?", [droppedPrefix]);
  assert.ok(kept, "a rule still listed in the file must survive sync");
  assert.equal(dropped, undefined, "a rule removed from the file must be deleted from the DB on sync");
});

test("POST /sync treats a completely missing 'tagging_rules:' key as zero desired rules, not an error - and budgets sync is unaffected", async () => {
  const key_id = await makeApiKey();
  const team = `gitops-budgets-only-${process.pid}`;
  writeConfig(`budgets:\n  - scope_type: team\n    scope_value: ${team}\n    monthly_limit_usd: 25\n`);

  const res = await request("/api/gitops/sync", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.created, 1, "budgets sync must work exactly as before when tagging_rules: is absent");
  assert.equal(res.json.tagging_rules.total, 0);
});
