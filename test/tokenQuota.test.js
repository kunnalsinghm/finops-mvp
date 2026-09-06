// test/tokenQuota.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-tokenQuota-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const { checkTokenQuota, addQuota, removeQuota, listQuotas } = require("../server/tokenQuota");

const insertEvent = db.prepare(`
  INSERT INTO usage_events (event_time, provider, model, team, user_id, input_tokens, output_tokens, cost_usd, tagged)
  VALUES (?, 'openai', 'gpt-4o', ?, ?, ?, ?, 0.01, 1)
`);

function seedTokens({ team, keyId, inputTokens, outputTokens, daysAgo = 0 }) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  insertEvent.run(d.toISOString(), team || null, keyId || null, inputTokens, outputTokens);
}

test("checkTokenQuota is unrestricted when neither key nor team has any quota rows", () => {
  const result = checkTokenQuota({ keyId: "fk_nobody", team: "no-team" });
  assert.equal(result.allowed, true);
  assert.equal(result.scope, null);
});

test("checkTokenQuota enforces a team-level daily quota", () => {
  addQuota({ scope_type: "team", scope_value: "eng-daily", period: "daily", token_limit: 1000 });

  const underLimit = checkTokenQuota({ keyId: "fk_x", team: "eng-daily" });
  assert.equal(underLimit.allowed, true);

  seedTokens({ team: "eng-daily", inputTokens: 600, outputTokens: 500 }); // 1100 total, over 1000

  const overLimit = checkTokenQuota({ keyId: "fk_x", team: "eng-daily" });
  assert.equal(overLimit.allowed, false);
  assert.equal(overLimit.scope, "team");
  assert.equal(overLimit.violations[0].period, "daily");
  assert.equal(overLimit.violations[0].used, 1100);
});

test("checkTokenQuota: key-level quota takes precedence over team-level quota", () => {
  addQuota({ scope_type: "team", scope_value: "precedence-team", period: "daily", token_limit: 100000 });
  addQuota({ scope_type: "key", scope_value: "fk_restricted", period: "daily", token_limit: 500 });

  seedTokens({ team: "precedence-team", keyId: "fk_restricted", inputTokens: 300, outputTokens: 300 }); // 600 total

  // This key's own limit (500) is exceeded, even though its team's limit
  // (100000) is nowhere close - key-level must win entirely.
  const result = checkTokenQuota({ keyId: "fk_restricted", team: "precedence-team" });
  assert.equal(result.allowed, false);
  assert.equal(result.scope, "key");
});

test("checkTokenQuota: a different key on the same team is unaffected by another key's quota", () => {
  const otherKey = checkTokenQuota({ keyId: "fk_other_on_team", team: "precedence-team" });
  assert.equal(otherKey.allowed, true);
  assert.equal(otherKey.scope, "team");
});

test("checkTokenQuota: a key/team can have both daily and weekly quotas, and either can trigger a block", () => {
  addQuota({ scope_type: "team", scope_value: "dual-period", period: "daily", token_limit: 50000 });
  addQuota({ scope_type: "team", scope_value: "dual-period", period: "weekly", token_limit: 100 });

  seedTokens({ team: "dual-period", inputTokens: 60, outputTokens: 60 }); // 120 total - under daily, over weekly

  const result = checkTokenQuota({ keyId: "fk_y", team: "dual-period" });
  assert.equal(result.allowed, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].period, "weekly");
});

test("checkTokenQuota: only counts events within the period window", () => {
  addQuota({ scope_type: "team", scope_value: "old-events-team", period: "daily", token_limit: 100 });
  seedTokens({ team: "old-events-team", inputTokens: 500, outputTokens: 500, daysAgo: 10 }); // way over limit, but 10 days ago

  const result = checkTokenQuota({ keyId: "fk_z", team: "old-events-team" });
  assert.equal(result.allowed, true, "events from 10 days ago should not count toward today's daily quota");
});

test("addQuota rejects a duplicate scope+period combination", () => {
  addQuota({ scope_type: "team", scope_value: "dup-quota-test", period: "daily", token_limit: 1000 });
  assert.throws(() => {
    addQuota({ scope_type: "team", scope_value: "dup-quota-test", period: "daily", token_limit: 2000 });
  }, /UNIQUE/);
});

test("removeQuota deletes a row and re-opens access for that scope/period", () => {
  const id = addQuota({ scope_type: "team", scope_value: "temp-quota-team", period: "daily", token_limit: 10 });
  seedTokens({ team: "temp-quota-team", inputTokens: 20, outputTokens: 20 });

  const before = checkTokenQuota({ keyId: "fk_temp", team: "temp-quota-team" });
  assert.equal(before.allowed, false);

  removeQuota(id);

  const after = checkTokenQuota({ keyId: "fk_temp", team: "temp-quota-team" });
  assert.equal(after.allowed, true);
});

test("removeQuota returns false for a non-existent id", () => {
  assert.equal(removeQuota(999999), false);
});

test("listQuotas filters by scope when provided", () => {
  addQuota({ scope_type: "team", scope_value: "list-quota-test", period: "daily", token_limit: 1000 });
  addQuota({ scope_type: "team", scope_value: "list-quota-test", period: "weekly", token_limit: 5000 });

  const filtered = listQuotas({ scope_type: "team", scope_value: "list-quota-test" });
  assert.equal(filtered.length, 2);

  const all = listQuotas();
  assert.ok(all.length >= 2);
});
