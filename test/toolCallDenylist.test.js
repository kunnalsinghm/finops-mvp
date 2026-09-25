// test/toolCallDenylist.test.js - mirrors modelAllowlist.test.js's
// structure, since toolCallDenylist.js deliberately mirrors
// modelAllowlist.js's scope_type/scope_value CRUD shape (with inverted
// deny-vs-allow default semantics - see toolCallDenylist.js's header).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-toolCallDenylist-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-toolCallDenylist-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_toolcalldenylist_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[toolCallDenylist.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const {
  checkToolCallDenied,
  addDenylistEntry,
  removeDenylistEntry,
  listDenylistEntries,
} = require("../server/toolCallDenylist");

test("checkToolCallDenied allows everything when neither key nor team has any entries (default-allow)", async () => {
  const result = await checkToolCallDenied({ keyId: "fk_nobody", team: "no-team", tool_name: "bash", target: "ls" });
  assert.equal(result.denied, false);
  assert.equal(result.scope, null);
});

test("checkToolCallDenied enforces a team-level deny-list entry", async () => {
  await addDenylistEntry({ scope_type: "team", scope_value: "finance", tool_name: "wire_transfer" });

  const denied = await checkToolCallDenied({ keyId: "fk_unlisted", team: "finance", tool_name: "wire_transfer", target: "acct-123" });
  assert.equal(denied.denied, true);
  assert.equal(denied.scope, "team");

  const allowed = await checkToolCallDenied({ keyId: "fk_unlisted", team: "finance", tool_name: "read_balance", target: "acct-123" });
  assert.equal(allowed.denied, false);
  assert.equal(allowed.scope, "team");
});

test("checkToolCallDenied: key-level entries take precedence over team-level entries (most-specific-wins)", async () => {
  // Team allows everything (no team-level entry at all for this tool)...
  const team = "eng-denylist-test";
  // ...but this key has its own denylist for a DIFFERENT tool - once the
  // key has ANY entries, only those are consulted, team-level is ignored,
  // even for a tool the key's own list says nothing about.
  await addDenylistEntry({ scope_type: "key", scope_value: "fk_restricted_dev2", tool_name: "delete_database" });
  await addDenylistEntry({ scope_type: "team", scope_value: team, tool_name: "read_file" });

  const result = await checkToolCallDenied({ keyId: "fk_restricted_dev2", team, tool_name: "read_file", target: null });
  assert.equal(result.denied, false, "key-level list (silent on read_file) should be the only one consulted");
  assert.equal(result.scope, "key");
});

test("checkToolCallDenied: '*' tool_name denies every tool for that scope", async () => {
  await addDenylistEntry({ scope_type: "key", scope_value: "fk_fully_blocked", tool_name: "*", reason: "key compromised, deny all tool calls" });

  const anyTool = await checkToolCallDenied({ keyId: "fk_fully_blocked", tool_name: "whatever_tool", target: "whatever" });
  assert.equal(anyTool.denied, true);
  assert.equal(anyTool.matchedEntry.reason, "key compromised, deny all tool calls");
});

test("checkToolCallDenied: target_pattern matches as a case-insensitive substring", async () => {
  await addDenylistEntry({ scope_type: "key", scope_value: "fk_target_pattern", tool_name: "http_request", target_pattern: "169.254.169.254" });

  const matched = await checkToolCallDenied({ keyId: "fk_target_pattern", tool_name: "http_request", target: "http://169.254.169.254/latest/meta-data/" });
  assert.equal(matched.denied, true);

  const notMatched = await checkToolCallDenied({ keyId: "fk_target_pattern", tool_name: "http_request", target: "http://example.com/api" });
  assert.equal(notMatched.denied, false);
});

test("checkToolCallDenied: an entry with no target_pattern matches ANY target for that tool_name", async () => {
  await addDenylistEntry({ scope_type: "key", scope_value: "fk_any_target", tool_name: "delete_file" });

  const withTarget = await checkToolCallDenied({ keyId: "fk_any_target", tool_name: "delete_file", target: "/anything/at/all" });
  assert.equal(withTarget.denied, true);

  const noTarget = await checkToolCallDenied({ keyId: "fk_any_target", tool_name: "delete_file", target: null });
  assert.equal(noTarget.denied, true);
});

test("removeDenylistEntry deletes a row and re-opens that scope", async () => {
  const id = await addDenylistEntry({ scope_type: "team", scope_value: "temp-denylist-team", tool_name: "risky_op" });

  const before = await checkToolCallDenied({ keyId: "fk_temp_denylist", team: "temp-denylist-team", tool_name: "risky_op" });
  assert.equal(before.denied, true);

  const removed = await removeDenylistEntry(id);
  assert.equal(removed, true);

  const after = await checkToolCallDenied({ keyId: "fk_temp_denylist", team: "temp-denylist-team", tool_name: "risky_op" });
  assert.equal(after.denied, false, "with the only entry removed, this team should be unrestricted again");
});

test("removeDenylistEntry returns false for a non-existent id", async () => {
  assert.equal(await removeDenylistEntry(999999), false);
});

test("listDenylistEntries filters by scope when provided", async () => {
  await addDenylistEntry({ scope_type: "team", scope_value: "list-denylist-test", tool_name: "op_one" });
  await addDenylistEntry({ scope_type: "team", scope_value: "list-denylist-test", tool_name: "op_two" });

  const filtered = await listDenylistEntries({ scope_type: "team", scope_value: "list-denylist-test" });
  assert.equal(filtered.length, 2);

  const all = await listDenylistEntries();
  assert.ok(all.length >= 2, "unfiltered list should include at least these entries plus earlier ones");
});
