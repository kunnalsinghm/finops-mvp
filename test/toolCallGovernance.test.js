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

const { logToolCall, listToolCalls, detectRiskyCommand, checkToolCallPreflight, listPendingApprovals, decideApproval } = require("../server/toolCallGovernance");
const { addRegionAllowlistEntry } = require("../server/dataResidency");
const { addDenylistEntry } = require("../server/toolCallDenylist");

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

// ---- A7: pre-flight check + approval queue ----

test("checkToolCallPreflight allows a call with no denylist match and no risk signal", async () => {
  const result = await checkToolCallPreflight({ tool_name: "read_file", target: "/tmp/harmless.txt", keyId: `key-preflight-ok-${process.pid}` });
  assert.deepEqual(result, { allowed: true });
});

test("checkToolCallPreflight denies a call matching a key-level denylist entry", async () => {
  const keyId = `key-denied-${process.pid}`;
  await addDenylistEntry({ scope_type: "key", scope_value: keyId, tool_name: "delete_file", reason: "no deletes from this key, ever" });

  const result = await checkToolCallPreflight({ tool_name: "delete_file", target: "/tmp/anything.txt", keyId });
  assert.equal(result.allowed, false);
  assert.equal(result.requires_approval, undefined);
  assert.match(result.reason, /no deletes from this key, ever/);
});

test("checkToolCallPreflight denies on a target_pattern substring match, case-insensitively", async () => {
  const keyId = `key-denied-target-${process.pid}`;
  await addDenylistEntry({ scope_type: "key", scope_value: keyId, tool_name: "http_request", target_pattern: "internal-admin.corp" });

  const denied = await checkToolCallPreflight({ tool_name: "http_request", target: "https://INTERNAL-ADMIN.corp/reset", keyId });
  assert.equal(denied.allowed, false);

  const allowed = await checkToolCallPreflight({ tool_name: "http_request", target: "https://public-api.example.com/ping", keyId });
  assert.equal(allowed.allowed, true);
});

test("checkToolCallPreflight most-specific-wins: a key with its own entries ignores team-level entries", async () => {
  const team = `team-preflight-${process.pid}`;
  const keyId = `key-preflight-specific-${process.pid}`;
  // Team-level: this tool is denied for the whole team...
  await addDenylistEntry({ scope_type: "team", scope_value: team, tool_name: "risky_tool" });
  // ...but this specific key has its OWN (empty-of-that-tool) list, which
  // takes over entirely - team-level is not consulted once the key has any
  // entries of its own, mirroring modelAllowlist.js's scope resolution.
  await addDenylistEntry({ scope_type: "key", scope_value: keyId, tool_name: "some_other_tool" });

  const result = await checkToolCallPreflight({ tool_name: "risky_tool", target: null, keyId, team });
  assert.equal(result.allowed, true, "key-level list (which has no entry for risky_tool) should be the only one consulted");
});

test("checkToolCallPreflight queues a pending approval for a risky command not covered by the denylist", async () => {
  const result = await checkToolCallPreflight({
    agent_id: `agent-approval-${process.pid}`,
    tool_name: "bash",
    target: "sudo rm -rf /data",
    keyId: `key-approval-${process.pid}`,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.requires_approval, true);
  assert.ok(result.approval_id);

  const pending = await listPendingApprovals();
  const row = pending.find((p) => p.id === result.approval_id);
  assert.ok(row, "expected the queued approval to appear in listPendingApprovals");
  assert.equal(row.status, "pending_approval");
  assert.equal(row.tool_name, "bash");
});

test("a denylist match takes priority over a risk-approval match (denied outright, never queued)", async () => {
  const keyId = `key-deny-over-approve-${process.pid}`;
  await addDenylistEntry({ scope_type: "key", scope_value: keyId, tool_name: "bash" });

  const before = (await listPendingApprovals()).length;
  const result = await checkToolCallPreflight({ tool_name: "bash", target: "sudo rm -rf /data", keyId });
  assert.equal(result.allowed, false);
  assert.equal(result.requires_approval, undefined);

  const after = (await listPendingApprovals()).length;
  assert.equal(after, before, "a flat denial must not also create an approval-queue row");
});

test("decideApproval: approving a pending row updates its status and is idempotent against a second decision", async () => {
  const result = await checkToolCallPreflight({
    agent_id: `agent-decide-${process.pid}`,
    tool_name: "shutdown",
    target: "prod-db-1",
    keyId: `key-decide-${process.pid}`,
  });
  assert.equal(result.requires_approval, true);

  const decided = await decideApproval({ id: result.approval_id, decision: "approved", decided_by: "admin-key-123", decision_reason: "verified with on-call" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decided_by, "admin-key-123");
  assert.ok(decided.decided_at);

  // A second decision on the same row is a no-op, not an overwrite -
  // deciding is a one-way action.
  const secondAttempt = await decideApproval({ id: result.approval_id, decision: "denied", decided_by: "someone-else" });
  assert.equal(secondAttempt.status, "approved", "the original decision must not be overwritten by a later call");
  assert.equal(secondAttempt.decided_by, "admin-key-123");
});

test("decideApproval returns null for an id that doesn't exist", async () => {
  const result = await decideApproval({ id: 999999999, decision: "approved", decided_by: "admin" });
  assert.equal(result, null);
});

test("decideApproval rejects an invalid decision value", async () => {
  await assert.rejects(() => decideApproval({ id: 1, decision: "maybe", decided_by: "admin" }), /decision must be/);
});

test("the post-hoc logToolCall/tool_calls audit path is unchanged by A7 - still logs and flags exactly as before", async () => {
  const agent = `agent-posthoc-unchanged-${process.pid}`;
  const result = await logToolCall({ agent_id: agent, tool_name: "bash", target: "sudo shutdown -h now" });
  assert.equal(result.flagged, true);
  assert.ok(result.reasons.some((r) => r.startsWith("risky-command:")));
  // logToolCall never consults the denylist or approval queue - it's a
  // pure post-hoc record of what already happened, exactly as it was
  // before A7 (see toolCallGovernance.js's header comment).
  const rows = await listToolCalls({ agent_id: agent });
  assert.equal(rows.length, 1);
});
