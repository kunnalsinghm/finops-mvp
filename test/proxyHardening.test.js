// test/proxyHardening.test.js
//
// Regression tests for the governance-hardening pass. Each block pins down a
// hole found by auditing the proxy, using the SAME scenarios that were run
// against a live server to prove the hole existed:
//
//   1. Budget enforcement trusted request headers  (omit X-Team / claim
//      another team / self-assert X-Workload-Type: background => bypass)
//   2. Real model IDs were metered at $0           (=> no budget could trip)
//   3. No upstream timeout                         (=> a hung provider pinned
//                                                      the connection forever)
//   4. Metering failures were silent or misreported (=> spend vanished, or a
//      successful, BILLED call was answered with a 502)
//
// The upstream provider is mocked via global.fetch, as in proxy.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-hardening-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-hardening-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const SPOOL = path.join(os.tmpdir(), `finops-spool-${process.pid}.jsonl`);
process.env.FINOPS_SPOOL_PATH = SPOOL;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_hardening_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const proxyRoute = require("../server/routes/proxy");
const keysRoute = require("../server/routes/keys");
const pricingRoute = require("../server/routes/pricing");
const { replaySpool } = require("../server/meteringSpool");

let server;
test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/proxy", proxyRoute);
  app.use("/api/keys", keysRoute);
  app.use("/api/pricing", pricingRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});
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

function request(method, pathName, { headers = {}, body } = {}) {
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
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const post = (p, o) => request("POST", p, o);

let keyCounter = 0;
async function makeApiKey(role = "developer", { team = null, allowBackground = false } = {}) {
  keyCounter++;
  const key_id = `fk_test_hard_${role}_${keyCounter}`;
  await storage.run(
    "INSERT INTO api_keys (key_id, label, role, team, allow_background, status) VALUES (?, ?, ?, ?, ?, 'active')",
    [key_id, `hardening key ${keyCounter}`, role, team, allowBackground ? 1 : 0]
  );
  return key_id;
}
const latestEvent = (user_id) =>
  storage.get("SELECT * FROM usage_events WHERE user_id = ? ORDER BY id DESC LIMIT 1", [user_id]);
const countEvents = async (user_id) =>
  Number((await storage.get("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?", [user_id])).n);

// Streaming responses are ended BEFORE usage is metered (by design - the client
// must not wait on our DB write), so on a real network-latency backend like
// Postgres the row lands slightly after the client sees the stream finish.
// SQLite's synchronous writes hide that gap; poll instead of assuming.
async function eventually(fn, { tries = 60, delayMs = 25 } = {}) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return v;
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function overBudget(team, limit = 0.01) {
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, ?)", [team, limit]);
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4.1', ?, 0.5, 1)`,
    [new Date().toISOString(), team]
  );
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
const openaiResponse = (i, o) => ({
  id: "m", object: "chat.completion", model: "x",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: i, completion_tokens: o, total_tokens: i + o },
});
const anthropicResponse = (i, o) => ({
  id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: i, output_tokens: o },
});
const PK = { "X-Provider-Key": "sk-real-upstream-key" };
const chat = (model = "gpt-4.1") => ({ model, messages: [{ role: "user", content: "hello there" }] });

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// =====================================================================
// 1. IDENTITY: budgets can no longer be dodged with headers
// =====================================================================

test("BUDGET BYPASS #1: a key bound to a team is still blocked when it simply omits X-Team", async (t) => {
  const team = `bound-omit-${process.pid}`;
  const key = await makeApiKey("developer", { team });
  await overBudget(team);
  let called = false;
  t.mock.method(global, "fetch", async () => { called = true; return jsonResponse(openaiResponse(10, 10)); });

  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat() });

  assert.equal(res.status, 402, "before the fix this returned 200: no X-Team header meant no team, meant no budget check");
  assert.equal(called, false, "a blocked request must never reach (or cost money at) the provider");
});

test("BUDGET BYPASS #2: claiming a different team via X-Team is refused 403, not honoured", async (t) => {
  const team = `bound-lie-${process.pid}`;
  const key = await makeApiKey("developer", { team });
  await overBudget(team);
  let called = false;
  t.mock.method(global, "fetch", async () => { called = true; return jsonResponse(openaiResponse(10, 10)); });

  const res = await post("/api/proxy/openai", {
    headers: { "X-API-Key": key, ...PK, "X-Team": "some-other-team" },
    body: chat(),
  });

  assert.equal(res.status, 403);
  assert.equal(res.json.code, "team-mismatch");
  assert.equal(called, false);
});

test("BUDGET BYPASS #3: X-Workload-Type: background from a key that was NOT granted it is refused, even over budget", async (t) => {
  const team = `bg-spoof-${process.pid}`;
  const key = await makeApiKey("developer", { team }); // not allow_background
  await overBudget(team);
  let called = false;
  t.mock.method(global, "fetch", async () => { called = true; return jsonResponse(openaiResponse(10, 10)); });

  const res = await post("/api/proxy/openai", {
    headers: { "X-API-Key": key, ...PK, "X-Workload-Type": "background" },
    body: chat(),
  });

  assert.equal(res.status, 403, "before the fix any caller could send this header and skip the hard block");
  assert.equal(res.json.code, "background-not-permitted");
  assert.equal(called, false);
});

test("a key that WAS granted background rights is still exempt from the hard block (the feature itself still works)", async (t) => {
  const team = `bg-granted-${process.pid}`;
  const key = await makeApiKey("developer", { team, allowBackground: true });
  await overBudget(team);
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(10, 10)));

  const res = await post("/api/proxy/openai", {
    headers: { "X-API-Key": key, ...PK, "X-Workload-Type": "background" },
    body: chat(),
  });
  assert.equal(res.status, 200);
  assert.equal((await latestEvent(key)).workload_type, "background");
});

test("a bound key's usage is attributed to the KEY's team even if the client sent no header (spend is not hidden)", async (t) => {
  const team = `attrib-${process.pid}`;
  const key = await makeApiKey("developer", { team });
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(10, 10)));
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat() });
  assert.equal(res.status, 200);
  assert.equal((await latestEvent(key)).team, team);
});

test("legacy compatibility: an UNBOUND key still uses the X-Team header by default", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(10, 10)));
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK, "X-Team": "legacy-team" }, body: chat() });
  assert.equal(res.status, 200);
  assert.equal((await latestEvent(key)).team, "legacy-team");
});

test("FINOPS_STRICT_IDENTITY=true refuses an unbound key on the proxy, before any provider call", async (t) => {
  const key = await makeApiKey("developer");
  let called = false;
  t.mock.method(global, "fetch", async () => { called = true; return jsonResponse(openaiResponse(1, 1)); });
  await withEnv({ FINOPS_STRICT_IDENTITY: "true" }, async () => {
    const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK, "X-Team": "anything" }, body: chat() });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, "key-not-bound");
  });
  assert.equal(called, false);
});

test("an over-budget bound key on a model WITH a fallback still degrades (soft path unchanged)", async (t) => {
  const team = `degrade-${process.pid}`;
  const key = await makeApiKey("developer", { team });
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 0.01)", [team]);
  await storage.run(`INSERT INTO usage_events (event_time, provider, model, team, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', ?, 0.5, 1)`, [new Date().toISOString(), team]);
  let sentModel;
  t.mock.method(global, "fetch", async (_u, init) => { sentModel = JSON.parse(init.body).model; return jsonResponse(openaiResponse(10, 10)); });

  // A DATED real-world ID: before the fallback lookup normalized IDs this had
  // no fallback at all and was hard-blocked instead of degraded.
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat("gpt-4o-2024-08-06") });
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-finops-degraded"], "true");
  assert.equal(sentModel, "gpt-4o-mini");
});

// =====================================================================
// 2. KEYS ROUTE: binding existing keys without recreating them
// =====================================================================

test("keys API: create with allow_background, list shows it, PATCH binds team and toggles it, validation + 404", async () => {
  const admin = await makeApiKey("admin");
  const H = { "X-API-Key": admin };

  const created = await post("/api/keys", { headers: H, body: { label: "svc", role: "developer", team: "ops", allow_background: true } });
  assert.equal(created.status, 201);
  assert.equal(created.json.allow_background, true);
  const target = created.json.key_id;

  let list = (await request("GET", "/api/keys", { headers: H })).json;
  assert.equal(Boolean(list.find((k) => k.key_id === target).allow_background), true);

  const patched = await request("PATCH", `/api/keys/${target}`, { headers: H, body: { team: "finance", allow_background: false } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.team, "finance");
  assert.equal(patched.json.allow_background, false);

  const unbound = await request("PATCH", `/api/keys/${target}`, { headers: H, body: { team: null } });
  assert.equal(unbound.json.team, null);

  assert.equal((await request("PATCH", `/api/keys/${target}`, { headers: H, body: { team: "" } })).status, 400);
  assert.equal((await request("PATCH", `/api/keys/${target}`, { headers: H, body: { allow_background: "yes" } })).status, 400);
  assert.equal((await request("PATCH", `/api/keys/${target}`, { headers: H, body: {} })).status, 400);
  assert.equal((await request("PATCH", `/api/keys/nope`, { headers: H, body: { team: "x" } })).status, 404);
  assert.equal((await post("/api/keys", { headers: H, body: { label: "bad", allow_background: "true" } })).status, 400);
});

test("keys API: only manage_keys (admin) may bind a key - a developer cannot grant themselves background rights", async () => {
  const dev = await makeApiKey("developer");
  const res = await request("PATCH", `/api/keys/${dev}`, { headers: { "X-API-Key": dev }, body: { allow_background: true } });
  assert.equal(res.status, 403);
});

// =====================================================================
// 3. PRICING: no more silent $0
// =====================================================================

test("PRICING: a real dated model ID is metered at a real cost, not $0", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => jsonResponse(anthropicResponse(1000, 1000)));
  const res = await post("/api/proxy/anthropic", { headers: { "X-API-Key": key, ...PK }, body: { model: "claude-sonnet-4-5-20250929", max_tokens: 50, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers["x-finops-cost-usd"]), 0.018);
  assert.equal(res.headers["x-finops-unpriced"], undefined);
  assert.equal((await latestEvent(key)).cost_usd, 0.018);
});

test("PRICING: an unpriced model is forwarded by default but LOUDLY flagged (header, event marker, alert)", async (t) => {
  const key = await makeApiKey("developer");
  const model = `mystery-model-${process.pid}`;
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(500, 500)));

  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat(model) });
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-finops-unpriced"], "true");
  const ev = await latestEvent(key);
  assert.equal(ev.cost_usd, 0);
  assert.equal(JSON.parse(ev.raw_json).unpriced, true);
  const alert = await storage.get("SELECT * FROM alerts_log WHERE type = 'unpriced-model' AND message LIKE ? ORDER BY id DESC LIMIT 1", [`%${model}%`]);
  assert.ok(alert, "an unpriced-model alert must be raised");

  // one alert per model per process, not one per request
  await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat(model) });
  const n = Number((await storage.get("SELECT COUNT(*) AS n FROM alerts_log WHERE type = 'unpriced-model' AND message LIKE ?", [`%${model}%`])).n);
  assert.equal(n, 1);
});

test("PRICING: FINOPS_UNPRICED_POLICY=block refuses an unpriced model with 422 BEFORE calling the provider", async (t) => {
  const key = await makeApiKey("developer");
  let called = false;
  t.mock.method(global, "fetch", async () => { called = true; return jsonResponse(openaiResponse(1, 1)); });
  await withEnv({ FINOPS_UNPRICED_POLICY: "block" }, async () => {
    const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat(`blocked-model-${process.pid}`) });
    assert.equal(res.status, 422);
    assert.match(res.json.error, /No price is configured/);
  });
  assert.equal(called, false);
  assert.equal(await countEvents(key), 0);
});

test("PRICING: block mode does not affect a model that IS priced", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(10, 10)));
  await withEnv({ FINOPS_UNPRICED_POLICY: "block" }, async () => {
    const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat("gpt-4.1") });
    assert.equal(res.status, 200);
  });
});

test("PRICING: a new model priced only via its family is flagged approximate on the response and the endpoint", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => jsonResponse(anthropicResponse(1000, 1000)));
  const res = await post("/api/proxy/anthropic", { headers: { "X-API-Key": key, ...PK }, body: { model: "claude-sonnet-5-9", max_tokens: 5, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-finops-price-approximate"], "true");
  assert.ok(Number(res.headers["x-finops-cost-usd"]) > 0);

  const admin = await makeApiKey("admin");
  const report = (await request("GET", "/api/pricing/unpriced", { headers: { "X-API-Key": admin } })).json;
  assert.ok(report.approximate.some((r) => r.model === "claude-sonnet-5-9" && r.matched_family === "claude-sonnet-5"));
  assert.ok(report.unpriced.some((r) => r.model.startsWith("mystery-model-")), "the unpriced model from the earlier test should be listed");
});

// =====================================================================
// 4. RELIABILITY: timeouts and metering durability
// =====================================================================

test("TIMEOUT: a hung provider produces 504 within the configured window instead of hanging forever (non-streaming)", async (t) => {
  const key = await makeApiKey("developer");
  // Behaves like real fetch: never resolves on its own, rejects when the signal fires.
  t.mock.method(global, "fetch", (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => rej(init.signal.reason));
  }));
  await withEnv({ FINOPS_UPSTREAM_TIMEOUT_MS: "60" }, async () => {
    const started = Date.now();
    const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat() });
    assert.equal(res.status, 504);
    assert.match(res.json.error, /did not respond within 60ms/);
    assert.ok(Date.now() - started < 3000);
  });
  assert.equal(await countEvents(key), 0, "a request that never completed must not be metered");
});

test("TIMEOUT: streaming applies the timeout to time-to-first-byte too", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => rej(init.signal.reason));
  }));
  await withEnv({ FINOPS_UPSTREAM_TIMEOUT_MS: "60" }, async () => {
    const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: { ...chat(), stream: true } });
    assert.equal(res.status, 504);
  });
});

test("METERING: if the usage write fails AFTER a successful provider call, the client still gets its response and the event is spooled", async (t) => {
  try { fs.unlinkSync(SPOOL); } catch {}
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(200, 100)));
  const realRun = storage.run.bind(storage);
  t.mock.method(storage, "run", async (sql, params) => {
    if (/INSERT INTO usage_events/.test(sql)) throw new Error("simulated: disk full");
    return realRun(sql, params);
  });

  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat() });

  assert.equal(res.status, 200, "before the fix: a billed, successful call was answered with 502");
  assert.equal(res.headers["x-finops-metering"], "failed");
  assert.equal(res.json.choices[0].message.content, "ok");
  const lines = fs.readFileSync(SPOOL, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.row.user_id, key);
  assert.equal(entry.row.input_tokens, 200);
  assert.match(entry.reason, /disk full/);
});

test("METERING: the spool replays through the normal insert, and is removed once everything is recovered", async () => {
  assert.ok(fs.existsSync(SPOOL), "previous test left one spooled event");
  const before = Number((await storage.get("SELECT COUNT(*) AS n FROM usage_events")).n);
  const result = await replaySpool();
  assert.deepEqual(result, { total: 1, replayed: 1, remaining: 0 });
  assert.equal(Number((await storage.get("SELECT COUNT(*) AS n FROM usage_events")).n), before + 1);
  assert.equal(fs.existsSync(SPOOL), false);
});

test("METERING: a replay that still fails keeps the event in the spool rather than dropping it", async (t) => {
  fs.writeFileSync(SPOOL, JSON.stringify({ spooled_at: "x", reason: "r", row: { event_time: new Date().toISOString(), provider: "openai", model: "gpt-4.1", team: null, environment: null, git_branch: null, user_id: "u", input_tokens: 1, output_tokens: 1, cost_usd: 0, tagged: 0, raw_json: "{}" } }) + "\n" + "not json at all\n");
  const realRun = storage.run.bind(storage);
  t.mock.method(storage, "run", async (sql, params) => {
    if (/INSERT INTO usage_events/.test(sql)) throw new Error("still down");
    return realRun(sql, params);
  });
  const result = await replaySpool();
  assert.deepEqual(result, { total: 2, replayed: 0, remaining: 2 });
  assert.equal(fs.readFileSync(SPOOL, "utf8").trim().split("\n").length, 2, "both the failed row and the unparseable line are preserved");
  fs.unlinkSync(SPOOL);
});

test("METERING: a failing anomaly detector cannot cost us the usage record (detectors are advisory)", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => jsonResponse(openaiResponse(500, 500))); // priced model => cost > 0 => detector actually runs
  const realGet = storage.get.bind(storage);
  let detectorQueried = false;
  t.mock.method(storage, "get", async (sql, params) => {
    if (/SELECT AVG\(cost_usd\)/.test(sql)) { detectorQueried = true; throw new Error("detector query exploded"); }
    return realGet(sql, params);
  });
  const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat("gpt-4.1") });
  assert.equal(detectorQueried, true, "the test must genuinely drive the detector into failure");
  assert.equal(res.status, 200, "before the fix a detector error aborted metering (and answered 502 for a billed call)");
  assert.notEqual(res.headers["x-finops-metering"], "failed");
  assert.equal(await countEvents(key), 1, "the usage event is still recorded");
});

test("FAIL-CLOSED: with FINOPS_METERING_FAILURE_POLICY=closed, an unreachable usage store means the request is NOT forwarded (503)", async (t) => {
  const key = await makeApiKey("developer");
  let called = false;
  t.mock.method(global, "fetch", async () => { called = true; return jsonResponse(openaiResponse(1, 1)); });
  const realGet = storage.get.bind(storage);
  t.mock.method(storage, "get", async (sql, params) => {
    if (/^SELECT 1 AS ok/.test(sql)) throw new Error("store down");
    return realGet(sql, params);
  });
  await withEnv({ FINOPS_METERING_FAILURE_POLICY: "closed" }, async () => {
    const res = await post("/api/proxy/openai", { headers: { "X-API-Key": key, ...PK }, body: chat() });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /NOT forwarded/);
  });
  assert.equal(called, false);
});

// ---- streaming ----
const enc = new TextEncoder();
function streamOf(chunks, { throwAfter = null } = {}) {
  return (async function* () {
    for (let i = 0; i < chunks.length; i++) {
      yield enc.encode(chunks[i]);
    }
    if (throwAfter) throw new Error(throwAfter);
  })();
}
const anthropicStart = (n) => `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: n } } })}\n\n`;
const anthropicDelta = (n) => `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: n } })}\n\n`;

test("STREAMING: a stream that dies mid-way is still metered with the usage seen so far, flagged partial, with an alert", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => ({
    ok: true, status: 200,
    body: streamOf([anthropicStart(321), "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hel\"}}\n\n"], { throwAfter: "upstream reset" }),
  }));
  const res = await post("/api/proxy/anthropic", { headers: { "X-API-Key": key, ...PK }, body: { model: "claude-haiku-4-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200); // headers were already flushed with the first chunk
  assert.match(res.text, /message_start/);
  const ev = await eventually(() => latestEvent(key));
  assert.ok(ev, "before the fix this event was silently lost");
  assert.equal(ev.input_tokens, 321);
  assert.equal(JSON.parse(ev.raw_json).partial, true);
  assert.equal(JSON.parse(ev.raw_json).streamed, true);
  const alert = await eventually(() => storage.get("SELECT * FROM alerts_log WHERE type = 'stream-interrupted' AND message LIKE ? ORDER BY id DESC LIMIT 1", [`%${key}%`]));
  assert.ok(alert);
});

test("STREAMING: a completed stream is metered fully and NOT flagged partial", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, body: streamOf([anthropicStart(100), anthropicDelta(50)]) }));
  const res = await post("/api/proxy/anthropic", { headers: { "X-API-Key": key, ...PK }, body: { model: "claude-haiku-4-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  const ev = await eventually(() => latestEvent(key));
  assert.equal(ev.input_tokens, 100);
  assert.equal(ev.output_tokens, 50);
  assert.equal(JSON.parse(ev.raw_json).partial, undefined);
});

test("STREAMING: a metering failure after a completed stream is spooled, not swallowed", async (t) => {
  try { fs.unlinkSync(SPOOL); } catch {}
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, body: streamOf([anthropicStart(11), anthropicDelta(22)]) }));
  const realRun = storage.run.bind(storage);
  t.mock.method(storage, "run", async (sql, params) => {
    if (/INSERT INTO usage_events/.test(sql)) throw new Error("db locked");
    return realRun(sql, params);
  });
  const res = await post("/api/proxy/anthropic", { headers: { "X-API-Key": key, ...PK }, body: { model: "claude-haiku-4-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 200);
  assert.match(res.text, /message_start/);
  assert.ok(await eventually(() => fs.existsSync(SPOOL)), "the spool file should appear shortly after the stream ends");
  const entry = JSON.parse(fs.readFileSync(SPOOL, "utf8").trim().split("\n")[0]);
  assert.equal(entry.row.output_tokens, 22);
  assert.equal(entry.row.user_id, key);
  fs.unlinkSync(SPOOL);
});

test("STREAMING: a stream that yields nothing before failing costs nothing and is not metered", async (t) => {
  const key = await makeApiKey("developer");
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, body: streamOf([], { throwAfter: "boom before first byte" }) }));
  const res = await post("/api/proxy/anthropic", { headers: { "X-API-Key": key, ...PK }, body: { model: "claude-haiku-4-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(res.status, 502, "nothing reached the client yet, so a clean error is still possible");
  await settle(); // an absence check must wait, or it would pass even if a write were still in flight
  assert.equal(await countEvents(key), 0);
});
