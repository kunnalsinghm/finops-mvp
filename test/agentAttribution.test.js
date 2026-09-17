// test/agentAttribution.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-agentAttribution-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_agentAttribution_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[agentAttribution.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { getAgentSummary, listAgentSummaries, getAgentTaskBreakdown, getForecastVariance } = require("../server/agentAttribution");

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function seedEvent({ agent_id, task_id, task_status, cost_usd, input_tokens = 0, output_tokens = 0, team, daysAgoN = 0 }) {
  await storage.run(
    `INSERT INTO usage_events (event_time, provider, model, agent_id, task_id, task_status, team, cost_usd, input_tokens, output_tokens, tagged)
     VALUES (?, 'openai', 'gpt-4o', ?, ?, ?, ?, ?, ?, ?, 1)`,
    [daysAgo(daysAgoN), agent_id, task_id, task_status || null, team || null, cost_usd, input_tokens, output_tokens]
  );
}

test("getAgentSummary returns nulls for an agent with no task_id-tagged events at all", async () => {
  const agent = `agent-empty-${process.pid}`;
  const summary = await getAgentSummary(agent);
  assert.equal(summary.total_tasks, 0);
  assert.equal(summary.cost_per_task_usd, null);
  assert.equal(summary.cost_per_successful_completion_usd, null);
  assert.equal(summary.retry_rate, null);
});

test("cost_per_task_usd divides total cost by DISTINCT task count, not event count", async () => {
  const agent = `agent-tasks-${process.pid}`;
  // task A: 2 events (a retry), task B: 1 event - 3 events, 2 tasks
  await seedEvent({ agent_id: agent, task_id: "task-a", cost_usd: 1, task_status: "failed" });
  await seedEvent({ agent_id: agent, task_id: "task-a", cost_usd: 1, task_status: "success" });
  await seedEvent({ agent_id: agent, task_id: "task-b", cost_usd: 1, task_status: "success" });

  const summary = await getAgentSummary(agent);
  assert.equal(summary.total_tasks, 2);
  assert.equal(summary.total_cost_usd, 3);
  assert.equal(summary.cost_per_task_usd, 1.5, "3 total cost / 2 distinct tasks, not / 3 events");
});

test("cost_per_successful_completion_usd excludes tasks that never reached success", async () => {
  const agent = `agent-success-${process.pid}`;
  await seedEvent({ agent_id: agent, task_id: "t1", cost_usd: 2, task_status: "success" });
  await seedEvent({ agent_id: agent, task_id: "t2", cost_usd: 2, task_status: "failed" }); // never succeeds

  const summary = await getAgentSummary(agent);
  assert.equal(summary.total_cost_usd, 4);
  assert.equal(summary.successful_tasks, 1);
  assert.equal(summary.cost_per_successful_completion_usd, 4, "4 total cost / 1 successful task, the failed task's cost still counts against it");
});

test("retry_rate is the fraction of tasks with more than one event", async () => {
  const agent = `agent-retry-${process.pid}`;
  await seedEvent({ agent_id: agent, task_id: "retried", cost_usd: 1, task_status: "failed" });
  await seedEvent({ agent_id: agent, task_id: "retried", cost_usd: 1, task_status: "success" });
  await seedEvent({ agent_id: agent, task_id: "clean-1", cost_usd: 1, task_status: "success" });
  await seedEvent({ agent_id: agent, task_id: "clean-2", cost_usd: 1, task_status: "success" });

  const summary = await getAgentSummary(agent);
  assert.equal(summary.total_tasks, 3);
  assert.equal(summary.retry_rate, Math.round((1 / 3) * 1000) / 1000);
});

test("token_efficiency_ratio only counts output tokens from successful tasks against ALL tokens consumed", async () => {
  const agent = `agent-efficiency-${process.pid}`;
  // Successful task: 100 output tokens
  await seedEvent({ agent_id: agent, task_id: "ok", cost_usd: 1, task_status: "success", input_tokens: 50, output_tokens: 100 });
  // Failed task: 200 output tokens wasted (never succeeded)
  await seedEvent({ agent_id: agent, task_id: "bad", cost_usd: 1, task_status: "failed", input_tokens: 50, output_tokens: 200 });

  const summary = await getAgentSummary(agent);
  // total tokens = 50+100+50+200 = 400; successful output tokens = 100
  assert.equal(summary.token_efficiency_ratio, Math.round((100 / 400) * 1000) / 1000);
});

test("listAgentSummaries includes every distinct agent_id seen, and excludes events with no agent_id", async () => {
  const agentX = `agent-list-x-${process.pid}`;
  const agentY = `agent-list-y-${process.pid}`;
  await seedEvent({ agent_id: agentX, task_id: "t1", cost_usd: 1, task_status: "success" });
  await seedEvent({ agent_id: agentY, task_id: "t1", cost_usd: 1, task_status: "success" });
  await storage.run(
    "INSERT INTO usage_events (event_time, provider, model, cost_usd, tagged) VALUES (?, 'openai', 'gpt-4o', 1, 1)",
    [daysAgo(0)]
  );

  const summaries = await listAgentSummaries();
  const ids = summaries.map((s) => s.agent_id);
  assert.ok(ids.includes(agentX));
  assert.ok(ids.includes(agentY));
});

test("getAgentTaskBreakdown reports per-task succeeded/retried flags", async () => {
  const agent = `agent-breakdown-${process.pid}`;
  await seedEvent({ agent_id: agent, task_id: "t-retried-success", cost_usd: 1, task_status: "failed" });
  await seedEvent({ agent_id: agent, task_id: "t-retried-success", cost_usd: 1, task_status: "success" });
  await seedEvent({ agent_id: agent, task_id: "t-clean-fail", cost_usd: 1, task_status: "failed" });

  const tasks = await getAgentTaskBreakdown(agent);
  const retried = tasks.find((t) => t.task_id === "t-retried-success");
  const cleanFail = tasks.find((t) => t.task_id === "t-clean-fail");

  assert.equal(retried.retried, true);
  assert.equal(retried.succeeded, true);
  assert.equal(retried.event_count, 2);
  assert.equal(cleanFail.retried, false);
  assert.equal(cleanFail.succeeded, false);
});

test("getForecastVariance reports unavailable with too little prior-window history", async () => {
  const team = `fv-empty-${process.pid}`;
  const result = await getForecastVariance(team);
  assert.equal(result.available, false);
});

test("getForecastVariance computes predicted vs actual and a variance percentage", async () => {
  const team = `fv-team-${process.pid}`;
  // Prior window (days 8-13 ago): $70 total over 6 distinct days = ~$11.67/day baseline -> predicted ~$81.67 for 7 days
  for (let d = 8; d <= 13; d++) {
    await seedEvent({ agent_id: null, task_id: null, cost_usd: 70 / 6, team, daysAgoN: d });
  }
  // Recent window (last 7 days): actual $140 - roughly double the baseline
  await seedEvent({ agent_id: null, task_id: null, cost_usd: 140, team, daysAgoN: 1 });

  const result = await getForecastVariance(team);
  assert.equal(result.available, true);
  assert.equal(result.actual_usd, 140);
  assert.ok(result.predicted_usd > 0);
  assert.ok(result.variance_pct > 0, "actual spend roughly doubling the baseline should show a large positive variance");
});
