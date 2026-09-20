// test/multiTenantHardening.test.js
//
// multiTenantIsolation.test.js proves the ORIGINAL routes are tenant-scoped. This file
// proves the same for the governance-hardening features layered on afterwards - identity
// binding, unpriced-model reporting, the metering spool, key management - none of which
// existed when those tests were written, and each of which was written against a single
// database. Two real tenants, real HTTP, real routes, real auth middleware.
//
// Requires Postgres: multi-tenant mode has no SQLite equivalent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

if (!isPostgres) {
  test("multi-tenant hardening suite requires Postgres - skipped under SQLite", { skip: true }, () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_ctl_hard_${process.pid}`;
  const SPOOL = path.join(os.tmpdir(), `finops-mt-spool-${process.pid}.jsonl`);
  process.env.FINOPS_SPOOL_PATH = SPOOL;

  const tenancy = require("../server/tenancy");
  const { replaySpool } = require("../server/meteringSpool");
  const proxyRoute = require("../server/routes/proxy");
  const keysRoute = require("../server/routes/keys");
  const budgetsRoute = require("../server/routes/budgets");
  const pricingRoute = require("../server/routes/pricing");
  const alertsRoute = require("../server/routes/alerts");
  const gpuUsageRoute = require("../server/routes/gpuUsage");

  let server, tenantA, tenantB, adminA, adminB, dbA, dbB;

  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/proxy", proxyRoute);
    app.use("/api/keys", keysRoute);
    app.use("/api/budgets", budgetsRoute);
    app.use("/api/pricing", pricingRoute);
    app.use("/api/alerts", alertsRoute);
    app.use("/api/gpu-usage", gpuUsageRoute);
    server = await new Promise((resolve, reject) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); s.on("error", reject); });
    tenantA = await tenancy.createTenant({ name: `Hard A ${process.pid}` });
    tenantB = await tenancy.createTenant({ name: `Hard B ${process.pid}` });
    adminA = (await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "A admin", role: "admin" })).key_id;
    adminB = (await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "B admin", role: "admin" })).key_id;
    dbA = await tenancy.getTenantDb(tenantA.schema_name);
    dbB = await tenancy.getTenantDb(tenantB.schema_name);
  });

  test.after(async () => {
    if (server) await new Promise((r) => server.close(r));
    const { controlPlanePool } = tenancy.initControlPlane();
    try {
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${tenantA.schema_name} CASCADE`);
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${tenantB.schema_name} CASCADE`);
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`);
    } catch (err) { console.warn(`[multiTenantHardening] cleanup failed: ${err.message}`); }
    await tenancy.closeAll();
    try { fs.unlinkSync(SPOOL); } catch {}
    delete process.env.FINOPS_MULTI_TENANT;
  });

  function request(method, pathName, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const h = { "Content-Type": "application/json", ...headers };
      if (data !== undefined) h["Content-Length"] = Buffer.byteLength(data);
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers: h }, (res) => {
        const chunks = []; res.on("data", (c) => chunks.push(c));
        res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch { json = text; } resolve({ status: res.statusCode, headers: res.headers, body: json }); });
      });
      req.on("error", reject); if (data !== undefined) req.write(data); req.end();
    });
  }
  const get = (p, o) => request("GET", p, o);
  const post = (p, o) => request("POST", p, o);
  const patch = (p, o) => request("PATCH", p, o);
  const H = (key, extra = {}) => ({ "X-API-Key": key, ...extra });
  const PK = { "X-Provider-Key": "sk-upstream" };
  const chat = (model) => ({ model, messages: [{ role: "user", content: `hello ${process.pid}` }] });
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const oai = (i, o) => ({ id: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: i, completion_tokens: o } });
  const uniq = () => `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  // ---------------------------------------------------------------- key management
  test("KEYS: a tenant cannot PATCH another tenant's key - it looks like an unknown key, and nothing changes", async () => {
    const victim = (await post("/api/keys", { headers: H(adminB), body: { label: "victim", role: "developer" } })).body;
    const before = (await get("/api/keys", { headers: H(adminB) })).body.find((k) => k.key_id === victim.key_id);

    const attack = await patch(`/api/keys/${victim.key_id}`, { headers: H(adminA), body: { team: "attacker-team", allow_background: true } });
    assert.equal(attack.status, 404, "must not even confirm the key exists");

    const after = (await get("/api/keys", { headers: H(adminB) })).body.find((k) => k.key_id === victim.key_id);
    assert.deepEqual(after, before, "the victim's key must be byte-for-byte unchanged");
    assert.equal(Boolean(after.allow_background), false);
    assert.equal(after.team, null);
  });

  test("KEYS: a tenant CAN bind and grant on its own keys", async () => {
    const own = (await post("/api/keys", { headers: H(adminA), body: { label: "own", role: "developer" } })).body;
    const r = await patch(`/api/keys/${own.key_id}`, { headers: H(adminA), body: { team: "growth", allow_background: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.team, "growth");
    assert.equal(r.body.allow_background, true);
  });

  test("KEYS: creating a key through the API PERSISTS team and allow_background (they used to be silently dropped in multi-tenant mode)", async () => {
    const created = await post("/api/keys", { headers: H(adminA), body: { label: "bound", role: "developer", team: "finance", allow_background: true } });
    assert.equal(created.status, 201);
    assert.equal(created.body.team, "finance");
    const listed = (await get("/api/keys", { headers: H(adminA) })).body.find((k) => k.key_id === created.body.key_id);
    assert.equal(listed.team, "finance", "stored, not merely echoed back");
    assert.equal(Boolean(listed.allow_background), true);
  });

  // ------------------------------------------------------------- identity binding
  test("IDENTITY: a team-bound tenant key is enforced from the KEY - omitting X-Team cannot dodge the team budget", async (t) => {
    const team = `t-${uniq()}`;
    const key = (await post("/api/keys", { headers: H(adminA), body: { label: "b", role: "developer", team } })).body.key_id;
    await post("/api/budgets", { headers: H(adminA), body: { scope_type: "team", scope_value: team, monthly_limit_usd: 0.01 } });
    await dbA.run(`INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4.1', ?, 0.5, 1)`, [new Date().toISOString(), team]);
    let called = false;
    t.mock.method(global, "fetch", async () => { called = true; return ok(oai(5, 5)); });

    const omit = await post("/api/proxy/openai", { headers: H(key, PK), body: chat("gpt-4.1") });
    assert.equal(omit.status, 402, "over budget, team taken from the key");
    const lie = await post("/api/proxy/openai", { headers: H(key, { ...PK, "X-Team": "someone-else" }), body: chat("gpt-4.1") });
    assert.equal(lie.status, 403);
    assert.equal(lie.body.code, "team-mismatch");
    assert.equal(called, false, "neither request may reach the provider");
  });

  test("IDENTITY: the same team NAME in another tenant is a different team - tenant B is not blocked by tenant A's overspend", async (t) => {
    const team = `shared-name-${uniq()}`;
    const keyA = (await post("/api/keys", { headers: H(adminA), body: { label: "a", role: "developer", team } })).body.key_id;
    const keyB = (await post("/api/keys", { headers: H(adminB), body: { label: "b", role: "developer", team } })).body.key_id;
    await post("/api/budgets", { headers: H(adminA), body: { scope_type: "team", scope_value: team, monthly_limit_usd: 0.01 } });
    await dbA.run(`INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4.1', ?, 0.5, 1)`, [new Date().toISOString(), team]);
    t.mock.method(global, "fetch", async () => ok(oai(5, 5)));
    assert.equal((await post("/api/proxy/openai", { headers: H(keyA, PK), body: chat("gpt-4.1") })).status, 402);
    assert.equal((await post("/api/proxy/openai", { headers: H(keyB, PK), body: chat("gpt-4.1") })).status, 200, "B has no budget and no spend under this name");
  });

  test("IDENTITY: background rights are per-key and per-tenant - a key that was never granted them is refused", async (t) => {
    const key = (await post("/api/keys", { headers: H(adminB), body: { label: "nobg", role: "developer", team: `bg-${uniq()}` } })).body.key_id;
    t.mock.method(global, "fetch", async () => ok(oai(5, 5)));
    const r = await post("/api/proxy/openai", { headers: H(key, { ...PK, "X-Workload-Type": "background" }), body: chat("gpt-4.1") });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "background-not-permitted");
  });

  test("KEY_ID: a proxied event is recorded in the CALLER's tenant with that tenant's key id, and nowhere else", async (t) => {
    const marker = `kid-${uniq()}`;
    const key = (await post("/api/keys", { headers: H(adminA), body: { label: "kid", role: "developer", team: marker } })).body.key_id;
    t.mock.method(global, "fetch", async () => ok(oai(7, 7)));
    assert.equal((await post("/api/proxy/openai", { headers: H(key, PK), body: chat("gpt-4.1") })).status, 200);
    const inA = await dbA.get("SELECT key_id FROM usage_events WHERE team = ?", [marker]);
    const inB = await dbB.get("SELECT key_id FROM usage_events WHERE team = ?", [marker]);
    assert.equal(inA.key_id, key);
    assert.equal(inB, undefined);
  });

  // ------------------------------------------------------------------ unpriced
  test("PRICING: /unpriced reports only the caller's own tenant", async (t) => {
    const model = `mystery-${uniq()}`;
    const keyA = (await post("/api/keys", { headers: H(adminA), body: { label: "u", role: "developer" } })).body.key_id;
    t.mock.method(global, "fetch", async () => ok(oai(5, 5)));
    await post("/api/proxy/openai", { headers: H(keyA, PK), body: chat(model) });
    const reportA = (await get("/api/pricing/unpriced", { headers: H(adminA) })).body;
    const reportB = (await get("/api/pricing/unpriced", { headers: H(adminB) })).body;
    assert.ok(reportA.unpriced.some((r) => r.model === model), "A sees its own unpriced model");
    assert.ok(!reportB.unpriced.some((r) => r.model === model), "B must not see A's models");
  });

  test("PRICING: the unpriced-model alert is raised once PER TENANT, into that tenant's own alert log", async (t) => {
    const model = `same-unknown-${uniq()}`;
    const keyA = (await post("/api/keys", { headers: H(adminA), body: { label: "ua", role: "developer" } })).body.key_id;
    const keyB = (await post("/api/keys", { headers: H(adminB), body: { label: "ub", role: "developer" } })).body.key_id;
    t.mock.method(global, "fetch", async () => ok(oai(5, 5)));
    await post("/api/proxy/openai", { headers: H(keyA, PK), body: chat(model) });
    await post("/api/proxy/openai", { headers: H(keyB, PK), body: chat(model) }); // B must NOT be silenced by A having triggered it
    await post("/api/proxy/openai", { headers: H(keyB, PK), body: chat(model) }); // ...but still only once for B
    const count = async (db) => Number((await db.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'unpriced-model' AND message LIKE ?", [`%${model}%`])).n);
    assert.equal(await count(dbA), 1);
    assert.equal(await count(dbB), 1);
  });

  // ------------------------------------------------------------------- spool
  test("SPOOL: a metering failure spools the row WITH its tenant, and replay puts it back in that tenant only", async (t) => {
    try { fs.unlinkSync(SPOOL); } catch {}
    const marker = `spool-${uniq()}`;
    const key = (await post("/api/keys", { headers: H(adminA), body: { label: "sp", role: "developer", team: marker } })).body.key_id;
    t.mock.method(global, "fetch", async () => ok(oai(11, 22)));
    const realRun = dbA.run.bind(dbA);
    t.mock.method(dbA, "run", async (sql, params) => {
      if (/INSERT INTO usage_events/.test(sql)) throw new Error("simulated: tenant A's database write failed");
      return realRun(sql, params);
    });

    const res = await post("/api/proxy/openai", { headers: H(key, PK), body: chat("gpt-4.1") });
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-finops-metering"], "failed");
    const entry = JSON.parse(fs.readFileSync(SPOOL, "utf8").trim().split("\n").pop());
    assert.equal(entry.tenant_schema, tenantA.schema_name, "the spooled row remembers which tenant it belongs to");
    t.mock.restoreAll();

    const result = await replaySpool();
    assert.equal(result.replayed, 1);
    assert.equal(result.remaining, 0);
    const inA = await dbA.get("SELECT input_tokens FROM usage_events WHERE team = ?", [marker]);
    const inB = await dbB.get("SELECT input_tokens FROM usage_events WHERE team = ?", [marker]);
    assert.equal(inA.input_tokens, 11, "recovered into the right tenant");
    assert.equal(inB, undefined, "and NOT into the other one");
    assert.equal(fs.existsSync(SPOOL), false);
  });

  test("SPOOL: a row for a tenant the control plane does not know stays spooled - and no schema is created for it", async () => {
    const ghost = `tenant_deadbeef${process.pid}`;
    const row = { event_time: new Date().toISOString(), provider: "openai", model: "gpt-4.1", team: "x", environment: null, git_branch: null, user_id: "u", key_id: "k", input_tokens: 1, output_tokens: 1, cost_usd: 0, tagged: 0, raw_json: "{}" };
    fs.writeFileSync(SPOOL, JSON.stringify({ spooled_at: "x", reason: "r", tenant_schema: ghost, row }) + "\n");
    const result = await replaySpool();
    assert.equal(result.replayed, 0);
    assert.equal(result.remaining, 1, "kept for a human, never guessed into another schema");
    const { controlPlanePool } = tenancy.initControlPlane();
    const exists = await controlPlanePool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [ghost]);
    assert.equal(exists.rowCount, 0, "replay must not resurrect a schema for an unknown tenant");
    fs.unlinkSync(SPOOL);
  });

  // ------------------------------------------------------------------ gpu-usage
  test("GPU: gpu usage is stored in, and reported from, the caller's own tenant only", async () => {
    const cluster = `cluster-${uniq()}`;
    const r = await post("/api/gpu-usage/ingest", { headers: H(adminA), body: { cluster_name: cluster, cost_usd: 42, team: "ml" } });
    assert.equal(r.status, 201);
    assert.equal(Number((await dbA.get("SELECT COUNT(*) AS n FROM gpu_usage_events WHERE cluster_name = ?", [cluster])).n), 1);
    assert.equal(Number((await dbB.get("SELECT COUNT(*) AS n FROM gpu_usage_events WHERE cluster_name = ?", [cluster])).n), 0);
    const blendedA = (await get("/api/gpu-usage/blended", { headers: H(adminA) })).body;
    const blendedB = (await get("/api/gpu-usage/blended", { headers: H(adminB) })).body;
    assert.ok(JSON.stringify(blendedA).includes("ml"), "A sees its own GPU spend");
    assert.ok(!JSON.stringify(blendedB).includes('"ml"'), "B must not see A's GPU spend");
  });

  test("GPU: a client-supplied `db` field in the request body cannot redirect the write", async () => {
    const cluster = `cluster-inject-${uniq()}`;
    const r = await post("/api/gpu-usage/ingest", { headers: H(adminA), body: { cluster_name: cluster, cost_usd: 1, team: "ml", db: "attacker-controlled" } });
    assert.equal(r.status, 201, "the injected field is overridden by the server's own handle, not honoured and not fatal");
    assert.equal(Number((await dbA.get("SELECT COUNT(*) AS n FROM gpu_usage_events WHERE cluster_name = ?", [cluster])).n), 1);
  });
}
