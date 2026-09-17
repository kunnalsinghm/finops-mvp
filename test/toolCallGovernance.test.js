// test/toolCallGovernance.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-toolCallGovernance-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_toolCallGovernance_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[toolCallGovernance.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { logToolCall, listToolCalls, detectRiskyCommand } = require("../server/toolCallGovernance");
const { addRegionAllowlistEntry } = require("../server/dataResidency");

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

test("detectRiskyCommand flags a recursive force-delete", () => {
  assert.deepEqual(detectRiskyCommand("rm -rf /important-data"), ["recursive-force-delete"]);
});

test("detectRiskyCommand flags a DROP TABLE statement", () => {
  assert.deepEqual(detectRiskyCommand("DROP TABLE users;"), ["drop-database-object"]);
});

test("detectRiskyCommand flags sudo/privilege escalation", () => {
  assert.deepEqual(detectRiskyCommand("sudo rm /etc/passwd"), ["privilege-escalation"]);
});

test("detectRiskyCommand is empty for an ordinary, safe command", () => {
  assert.deepEqual(detectRiskyCommand("ls -la /home/user/documents"), []);
});

test("detectRiskyCommand handles non-string/empty input safely", () => {
  assert.deepEqual(detectRiskyCommand(null), []);
  assert.deepEqual(detectRiskyCommand(undefined), []);
  assert.deepEqual(detectRiskyCommand(""), []);
});

test("logToolCall records a safe, ordinary tool call as low risk and not flagged", async () => {
  const result = await logToolCall({ agent_id: `agent-safe-${process.pid}`, tool_name: "list_files", target: "/home/user" });
  assert.equal(result.risk_level, "low");
  assert.equal(result.flagged, false);
});

test("logToolCall flags a risky command as high risk", async () => {
  const result = await logToolCall({ agent_id: `agent-risky-${process.pid}`, tool_name: "bash", target: "rm -rf /data" });
  assert.equal(result.risk_level, "high");
  assert.equal(result.flagged, true);
  assert.ok(result.reasons.some((r) => r.includes("recursive-force-delete")));
});

test("logToolCall flags a data-residency violation when the target region isn't approved", async () => {
  const team = `tc-residency-team-${process.pid}`;
  await addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "eu-west" });

  const result = await logToolCall({
    agent_id: `agent-residency-${process.pid}`,
    tool_name: "upload_file",
    target: "s3://bucket/file",
    region: "us-east",
    team,
  });

  assert.equal(result.flagged, true);
  assert.ok(result.reasons.some((r) => r.includes("data-residency-violation")));
});

test("logToolCall does not flag a target region that IS on the team's allow-list", async () => {
  const team = `tc-residency-ok-team-${process.pid}`;
  await addRegionAllowlistEntry({ scope_type: "team", scope_value: team, region: "eu-west" });

  const result = await logToolCall({
    agent_id: `agent-residency-ok-${process.pid}`,
    tool_name: "upload_file",
    target: "s3://bucket/file",
    region: "eu-west",
    team,
  });

  assert.equal(result.flagged, false);
});

test("logToolCall flags a volume spike against an established per-agent daily baseline", async () => {
  const agent = `agent-volume-${process.pid}`;
  for (let d = 1; d <= 5; d++) {
    await storage.run(
      "INSERT INTO tool_calls (event_time, agent_id, tool_name, risk_level, flagged) VALUES (?, ?, 'read_file', 'low', 0)",
      [daysAgo(d), agent]
    );
  }
  for (let i = 0; i < 10; i++) {
    await storage.run(
      "INSERT INTO tool_calls (event_time, agent_id, tool_name, risk_level, flagged) VALUES (?, ?, 'read_file', 'low', 0)",
      [new Date().toISOString(), agent]
    );
  }

  const result = await logToolCall({ agent_id: agent, tool_name: "read_file", target: "/tmp/notes.txt" });
  assert.equal(result.flagged, true);
  assert.ok(result.reasons.some((r) => r.includes("data-access-volume-spike")));
});

test("listToolCalls with onlyFlagged=true returns only flagged rows", async () => {
  const agent = `agent-list-${process.pid}`;
  await logToolCall({ agent_id: agent, tool_name: "safe_op" });
  await logToolCall({ agent_id: agent, tool_name: "bash", target: "DROP TABLE accounts;" });

  const flagged = await listToolCalls({ onlyFlagged: true, agent_id: agent });
  assert.ok(flagged.length >= 1);
  assert.ok(flagged.every((r) => Number(r.flagged) === 1));
});
