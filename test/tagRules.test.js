// test/tagRules.test.js - declarative tagging rules (tagRules.js): matching
// (including longest-prefix-wins), and applyTagRules' fill-gaps-only,
// never-override behavior.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-tagRules-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_tagRules_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[tagRules.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { applyTagRules, matchingRule } = require("../server/tagRules");

async function makeRule({ api_key_prefix, team = null, environment = null, project_id = null, cost_center = null, customer_id = null, feature_id = null }) {
  await storage.run(
    `INSERT INTO tag_rules (api_key_prefix, team, environment, project_id, cost_center, customer_id, feature_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [api_key_prefix, team, environment, project_id, cost_center, customer_id, feature_id]
  );
}

test("matchingRule returns null when no rule's prefix matches the key", async () => {
  const rule = await matchingRule({ key_id: `fk_unmatched_${process.pid}` });
  assert.equal(rule, null);
});

test("matchingRule returns null for a null/undefined key_id (bootstrap/session logins have no real key)", async () => {
  const rule = await matchingRule({ key_id: null });
  assert.equal(rule, null);
});

test("matchingRule picks the LONGEST matching prefix, not just any match", async () => {
  const prefix = `fk_longest_${process.pid}_`;
  await makeRule({ api_key_prefix: prefix, team: "broad-team" });
  await makeRule({ api_key_prefix: `${prefix}eu_`, team: "narrow-eu-team" });

  const rule = await matchingRule({ key_id: `${prefix}eu_007` });
  assert.equal(rule.team, "narrow-eu-team", "the more specific prefix must win over the broader one");
});

test("matchingRule falls back to the only matching (broader) prefix when the narrower one doesn't apply", async () => {
  const prefix = `fk_fallback_${process.pid}_`;
  await makeRule({ api_key_prefix: prefix, team: "broad-team" });
  await makeRule({ api_key_prefix: `${prefix}eu_`, team: "narrow-eu-team" });

  const rule = await matchingRule({ key_id: `${prefix}us_042` });
  assert.equal(rule.team, "broad-team");
});

test("applyTagRules fills in every blank assignable field from the matching rule", async () => {
  const prefix = `fk_fillall_${process.pid}_`;
  await makeRule({
    api_key_prefix: prefix,
    team: "growth",
    environment: "prod",
    project_id: "checkout-svc",
    cost_center: "cc-4821",
    customer_id: "acme-co",
    feature_id: "checkout-flow",
  });

  const { fields, rule } = await applyTagRules({
    key_id: `${prefix}007`,
    fields: { team: null, environment: null, project_id: null, cost_center: null, customer_id: null, feature_id: null },
  });

  assert.equal(fields.team, "growth");
  assert.equal(fields.environment, "prod");
  assert.equal(fields.project_id, "checkout-svc");
  assert.equal(fields.cost_center, "cc-4821");
  assert.equal(fields.customer_id, "acme-co");
  assert.equal(fields.feature_id, "checkout-flow");
  assert.equal(rule.api_key_prefix, prefix);
});

test("applyTagRules NEVER overrides a field the caller already supplied, even if a rule disagrees", async () => {
  const prefix = `fk_nooverride_${process.pid}_`;
  await makeRule({ api_key_prefix: prefix, team: "rule-team", environment: "rule-env" });

  const { fields } = await applyTagRules({
    key_id: `${prefix}007`,
    fields: { team: "caller-team", environment: null, project_id: null, cost_center: null, customer_id: null, feature_id: null },
  });

  assert.equal(fields.team, "caller-team", "an explicit value must always win over a rule");
  assert.equal(fields.environment, "rule-env", "a genuinely blank field is still filled by the rule");
});

test("applyTagRules only fills fields the rule actually declares, leaving the rest null", async () => {
  const prefix = `fk_partial_${process.pid}_`;
  await makeRule({ api_key_prefix: prefix, team: "growth" }); // environment/project_id/etc left null on the rule itself

  const { fields } = await applyTagRules({
    key_id: `${prefix}007`,
    fields: { team: null, environment: null, project_id: null, cost_center: null, customer_id: null, feature_id: null },
  });

  assert.equal(fields.team, "growth");
  assert.equal(fields.environment, null, "a rule with no environment declared must not invent one");
});

test("applyTagRules is a no-op (returns the fields unchanged, rule: null) when nothing matches", async () => {
  const { fields, rule } = await applyTagRules({
    key_id: `fk_nomatch_${process.pid}`,
    fields: { team: null, environment: "prod", project_id: null, cost_center: null, customer_id: null, feature_id: null },
  });

  assert.equal(fields.team, null);
  assert.equal(fields.environment, "prod");
  assert.equal(rule, null);
});
