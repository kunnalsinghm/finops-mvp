// test/modelAllowlist.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-modelAllowlist-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const {
  checkModelAllowed,
  addAllowlistEntry,
  removeAllowlistEntry,
  listAllowlistEntries,
} = require("../server/modelAllowlist");

test("checkModelAllowed is unrestricted when neither key nor team has any entries", async () => {
  const result = await checkModelAllowed({ keyId: "fk_nobody", team: "no-team", provider: "openai", model: "gpt-4o" });
  assert.equal(result.allowed, true);
  assert.equal(result.scope, null);
});

test("checkModelAllowed enforces a team-level allow-list", async () => {
  await addAllowlistEntry({ scope_type: "team", scope_value: "finance", provider: "openai", model: "gpt-4o-mini" });

  const allowed = await checkModelAllowed({ keyId: "fk_unlisted", team: "finance", provider: "openai", model: "gpt-4o-mini" });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.scope, "team");

  const denied = await checkModelAllowed({ keyId: "fk_unlisted", team: "finance", provider: "openai", model: "gpt-4o" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, "team");
});

test("checkModelAllowed: key-level entries take precedence over team-level entries", async () => {
  await addAllowlistEntry({ scope_type: "team", scope_value: "eng", provider: "anthropic", model: "claude-opus" });
  await addAllowlistEntry({ scope_type: "key", scope_value: "fk_restricted_dev", provider: "anthropic", model: "claude-haiku" });

  // This key belongs to team 'eng' (which allows claude-opus), but the key
  // has its OWN list (claude-haiku only) - key-level must win entirely,
  // the team's claude-opus entry should NOT apply to this key.
  const opusAttempt = await checkModelAllowed({ keyId: "fk_restricted_dev", team: "eng", provider: "anthropic", model: "claude-opus" });
  assert.equal(opusAttempt.allowed, false);
  assert.equal(opusAttempt.scope, "key");

  const haikuAttempt = await checkModelAllowed({ keyId: "fk_restricted_dev", team: "eng", provider: "anthropic", model: "claude-haiku" });
  assert.equal(haikuAttempt.allowed, true);
  assert.equal(haikuAttempt.scope, "key");
});

test("checkModelAllowed: a different key on the same restricted team is unaffected by another key's list", async () => {
  // fk_restricted_dev's own list (from the previous test) must not leak
  // onto a different key on the same 'eng' team.
  const otherKey = await checkModelAllowed({ keyId: "fk_other_dev", team: "eng", provider: "anthropic", model: "claude-opus" });
  assert.equal(otherKey.allowed, true);
  assert.equal(otherKey.scope, "team");
});

test("addAllowlistEntry rejects an exact duplicate", async () => {
  await addAllowlistEntry({ scope_type: "team", scope_value: "dup-test", provider: "openai", model: "gpt-4o-mini" });
  await assert.rejects(async () => {
    await addAllowlistEntry({ scope_type: "team", scope_value: "dup-test", provider: "openai", model: "gpt-4o-mini" });
  }, /UNIQUE/);
});

test("removeAllowlistEntry deletes a row and re-opens access for that scope", async () => {
  const id = await addAllowlistEntry({ scope_type: "team", scope_value: "temp-team", provider: "openai", model: "gpt-4o-mini" });

  const before = await checkModelAllowed({ keyId: "fk_temp", team: "temp-team", provider: "openai", model: "gpt-4o" });
  assert.equal(before.allowed, false);

  const removed = await removeAllowlistEntry(id);
  assert.equal(removed, true);

  const after = await checkModelAllowed({ keyId: "fk_temp", team: "temp-team", provider: "openai", model: "gpt-4o" });
  assert.equal(after.allowed, true, "with the only entry removed, this team should be unrestricted again");
});

test("removeAllowlistEntry returns false for a non-existent id", async () => {
  assert.equal(await removeAllowlistEntry(999999), false);
});

test("listAllowlistEntries filters by scope when provided", async () => {
  await addAllowlistEntry({ scope_type: "team", scope_value: "list-test", provider: "openai", model: "gpt-4o-mini" });
  await addAllowlistEntry({ scope_type: "team", scope_value: "list-test", provider: "anthropic", model: "claude-haiku" });

  const filtered = await listAllowlistEntries({ scope_type: "team", scope_value: "list-test" });
  assert.equal(filtered.length, 2);

  const all = await listAllowlistEntries();
  assert.ok(all.length >= 2, "unfiltered list should include at least these entries plus earlier ones");
});
