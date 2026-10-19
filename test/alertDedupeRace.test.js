// test/alertDedupeRace.test.js - "fire once" alerts are arbitrated by the INSERT.
//
// Every fire-once alert (budget tiers, burn rate, commitments, the weekly briefing,
// the two per-request anomaly checks) was "SELECT to see if it fired; send; INSERT
// a marker". Two callers can both SELECT before either INSERTs, so both send:
//   - two replicas running the same periodic job, and
//   - even ONE process, for the anomaly checks, which run per request: two
//     concurrent requests for the same team both log the alert.
// Now the INSERT is the arbiter: INSERT ... ON CONFLICT DO NOTHING, and only the
// caller whose insert created the row sends. If sending fails the claim is
// released, so the next check retries - the "retry on the next check" contract the
// old send-then-mark order existed for. The price: a crash between the claim and the
// send loses that one alert (the old order could instead send twice).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-alertRace-\d+\.db/.test(f)) { try { fs.unlinkSync(path.join(__dirname, f)); } catch {} }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-alertRace-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_alertrace_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const { fireOnce, claim, release } = require("../server/fireOnce");
const { checkBudgetAlerts, checkBurnRate } = require("../server/alerts");
const { checkCommitmentAlerts } = require("../server/commitments");
const { checkWeeklyBriefing } = require("../server/weeklyBriefing");
const { checkDailySpendAnomaly, checkRetryRateAnomaly } = require("../server/anomaly");

test.before(async () => {
  await storage.ready;
  await storage.run("CREATE TABLE IF NOT EXISTS fo_state (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b))");
});
test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const uniq = (tag) => `${tag}-${process.pid}-${++n}`;
const alertCount = async (type, pattern) =>
  (await storage.all("SELECT message FROM alerts_log WHERE type = ?", [type])).filter((r) => pattern.test(r.message)).length;
async function seedEvent({ team = null, agent_id = null, task_id = null, provider = "openai", cost_usd = 0.1, event_time = new Date().toISOString() }) {
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, team, user_id, agent_id, task_id, input_tokens, output_tokens, cost_usd, tagged)
     VALUES (?, ?, 'gpt-4o', ?, 'race-user', ?, ?, 1, 1, ?, 0)`,
    [event_time, provider, team, agent_id, task_id, cost_usd]
  );
}
const daysAgoIso = (d) => { const x = new Date(); x.setUTCDate(x.getUTCDate() - d); return x.toISOString(); };

// ---------------------------------------------------------------- the helper
test("fireOnce: concurrent callers with the same key run the action exactly once", async () => {
  const key = { a: uniq("same"), b: "x" };
  let ran = 0;
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    fireOnce(storage, "fo_state", key, async () => { await sleep(15); ran++; return "sent"; })));
  assert.equal(ran, 1);
  assert.equal(results.filter((r) => r.fired).length, 1);
  assert.equal(results.find((r) => r.fired).value, "sent");
});

test("fireOnce: different keys do not block each other", async () => {
  let ran = 0;
  await Promise.all([uniq("k1"), uniq("k2"), uniq("k3")].map((a) =>
    fireOnce(storage, "fo_state", { a, b: "x" }, async () => { await sleep(5); ran++; })));
  assert.equal(ran, 3);
});

test("fireOnce: an already-claimed key does not run the action", async () => {
  const key = { a: uniq("pre"), b: "x" };
  assert.equal(await claim(storage, "fo_state", key), true);
  let ran = 0;
  const r = await fireOnce(storage, "fo_state", key, async () => { ran++; });
  assert.equal(r.fired, false);
  assert.equal(ran, 0);
});

test("fireOnce: if the action fails the claim is released, so the next call retries it", async () => {
  const key = { a: uniq("retry"), b: "x" };
  await assert.rejects(() => fireOnce(storage, "fo_state", key, async () => { throw new Error("channel down"); }), /channel down/);
  assert.equal(await claim(storage, "fo_state", key), true, "the failed attempt left no claim behind");
  await release(storage, "fo_state", key);
  let ran = 0;
  const r = await fireOnce(storage, "fo_state", key, async () => { ran++; });
  assert.equal(r.fired, true);
  assert.equal(ran, 1);
});

test("fireOnce: table and column names must be plain identifiers", async () => {
  await assert.rejects(() => claim(storage, "fo_state; DROP TABLE fo_state", { a: "x", b: "y" }), /identifier/i);
  await assert.rejects(() => claim(storage, "fo_state", { "a) VALUES (1); --": "x" }), /identifier/i);
});

// ------------------------------------- the real state tables can arbitrate
async function uniqueKeyColumns(table) {
  if (isPostgres) {
    const rows = await storage.all(
      `SELECT i.indexrelid, a.attname FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
        WHERE ns.nspname = current_schema() AND c.relname = ? AND i.indisunique`, [table]);
    const by = {};
    for (const r of rows) (by[r.indexrelid] ||= []).push(r.attname);
    return Object.values(by).map((cols) => cols.sort().join(","));
  }
  const out = [];
  for (const idx of await storage.all(`PRAGMA index_list(${table})`)) {
    if (Number(idx.unique) !== 1) continue;
    out.push((await storage.all(`PRAGMA index_info(${idx.name})`)).map((c) => c.name).sort().join(","));
  }
  return out;
}
for (const [table, cols] of [
  ["budget_alert_state", "budget_id,month,tier"],
  ["commitment_alert_state", "commitment_id,tier"],
  ["weekly_briefing_state", "week_key"],
  ["anomaly_alert_state", "anomaly_type,period,scope_type,scope_value"],
]) {
  test(`${table} has a unique key on exactly (${cols.split(",").sort().join(", ")}), which ON CONFLICT DO NOTHING depends on`, async () => {
    assert.ok((await uniqueKeyColumns(table)).includes(cols), `${table} must be UNIQUE on ${cols}`);
  });
}

// ------------------------------------------------ the real alert paths race
test("budget tiers: concurrent checks send each tier once", async () => {
  const team = uniq("budget-team");
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 100)", [team]);
  await seedEvent({ team, cost_usd: 60 }); // 60%: the 50% tier only
  await Promise.all(Array.from({ length: 5 }, () => checkBudgetAlerts()));
  const re = new RegExp(`team:${team}\\* has reached \\*50%\\*`);
  assert.equal(await alertCount("budget", re), 1, "before: one per concurrent caller");
  await Promise.all(Array.from({ length: 3 }, () => checkBudgetAlerts()));
  assert.equal(await alertCount("budget", re), 1, "and never again for the same month");
});

test("burn-rate: concurrent checks send it once", async () => {
  const team = uniq("burn-team");
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 100)", [team]);
  await seedEvent({ team, cost_usd: 5000 }); // projected far beyond 120% of the budget, on any day of the month
  await Promise.all(Array.from({ length: 5 }, () => checkBurnRate()));
  assert.equal(await alertCount("budget", new RegExp(`Burn-rate alert - \\*team:${team}\\*`)), 1);
});

test("commitments: concurrent checks send each remaining-balance tier once", async () => {
  const mk = async (provider, label) => {
    await storage.run("INSERT INTO commitments (provider, label, initial_amount_usd, starts_at) VALUES (?, ?, 100, '2000-01-01')", [provider, label]);
    await seedEvent({ provider, cost_usd: 96 }); // 4% left: every tier is crossed
  };
  const control = uniq("commit-control");
  const racing = uniq("commit-racing");
  await mk(control, control);
  await checkCommitmentAlerts(); // the sequential count is the expected one per commitment
  const expected = await alertCount("commitment", new RegExp(`\\*${control}\\*`));
  assert.ok(expected >= 1);
  await mk(racing, racing);
  await Promise.all(Array.from({ length: 5 }, () => checkCommitmentAlerts()));
  assert.equal(await alertCount("commitment", new RegExp(`\\*${racing}\\*`)), expected);
});

test("weekly briefing: concurrent checks on a Monday send one briefing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2031-03-03T10:00:00Z") }); // a Monday, UTC
  await Promise.all(Array.from({ length: 5 }, () => checkWeeklyBriefing()));
  const rows = await storage.all("SELECT message FROM alerts_log WHERE type = 'weekly-briefing'");
  assert.equal(rows.length, 1);
  assert.equal(Number((await storage.get("SELECT COUNT(*) AS n FROM weekly_briefing_state")).n), 1);
  await checkWeeklyBriefing();
  assert.equal((await storage.all("SELECT 1 FROM alerts_log WHERE type = 'weekly-briefing'")).length, 1, "nor on a later check the same week");
});

test("anomaly (per request): concurrent daily-spend checks for one team log one alert", async () => {
  const team = uniq("race-daily");
  for (const d of [1, 2, 3, 4]) await seedEvent({ team, cost_usd: 10, event_time: daysAgoIso(d) });
  await seedEvent({ team, cost_usd: 60 });
  const results = await Promise.all(Array.from({ length: 5 }, () => checkDailySpendAnomaly({ team })));
  assert.equal(await alertCount("anomaly", new RegExp(`Daily spend anomaly: team '${team}'`)), 1);
  assert.equal(results.filter(Boolean).length, 1, "only the request that won the claim reports the anomaly");
});

test("anomaly (per request): concurrent retry-rate checks for one agent log one alert", async () => {
  const agent_id = uniq("race-retry");
  for (const task of ["t1", "t2", "t3", "t4"]) { await seedEvent({ agent_id, task_id: task }); await seedEvent({ agent_id, task_id: task }); }
  await seedEvent({ agent_id, task_id: "t5" });
  const results = await Promise.all(Array.from({ length: 5 }, () => checkRetryRateAnomaly({ agent_id })));
  assert.equal(await alertCount("anomaly", new RegExp(`Retry-rate anomaly: agent '${agent_id}'`)), 1);
  assert.equal(results.filter(Boolean).length, 1);
});

test("a delivery that fails is retried on the next check (the claim is released, not kept)", async (t) => {
  const team = uniq("retry-team");
  await storage.run("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES ('team', ?, 100)", [team]);
  await seedEvent({ team, cost_usd: 60 });
  const realRun = storage.run.bind(storage);
  let failed = false;
  t.mock.method(storage, "run", async (sql, params) => {
    if (!failed && /INSERT INTO alerts_log/.test(sql) && params.some((p) => String(p).includes(team))) { failed = true; throw new Error("alerts_log write failed"); }
    return realRun(sql, params);
  });
  await checkBudgetAlerts(); // delivery fails: logged, not thrown
  t.mock.restoreAll();
  const re = new RegExp(`team:${team}\\* has reached \\*50%\\*`);
  assert.equal(await alertCount("budget", re), 0);
  await checkBudgetAlerts();
  assert.equal(await alertCount("budget", re), 1, "delivered on the next check");
  await checkBudgetAlerts();
  assert.equal(await alertCount("budget", re), 1);
});
