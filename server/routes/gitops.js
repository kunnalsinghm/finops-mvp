// routes/gitops.js - "FinOps as Code": sync budgets AND declarative tagging
// rules from finops.yaml
//
// Simple version of the blueprint's GitOps idea: no GitHub Action wiring yet
// (that requires a repo + CI to call this endpoint on push), but the
// sync-on-file-change logic - including drift removal - is fully implemented
// for both `budgets:` (Level 1) and `tagging_rules:` (Level 2 - see
// server/tagRules.js for matching/precedence). One file, one sync pass, one
// drift-removal pass for each section - not two separate endpoints, since
// it's the same "declare policy as code, apply it, remove what's no longer
// declared" workflow either way.

const express = require("express");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const defaultDb = require("../storage");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { ASSIGNABLE_FIELDS } = require("../tagRules");

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, "..", "..", "finops.yaml");

async function syncBudgets(desired, db) {
  const existing = await db.all("SELECT * FROM budgets");
  const desiredKeys = new Set(desired.map((b) => `${b.scope_type}:${b.scope_value}`));

  let created = 0, updated = 0, removed = 0;

  // Upsert desired budgets
  for (const b of desired) {
    const match = existing.find(
      (e) => e.scope_type === b.scope_type && e.scope_value === b.scope_value
    );
    if (match) {
      if (match.monthly_limit_usd !== b.monthly_limit_usd) {
        await db.run("UPDATE budgets SET monthly_limit_usd = ? WHERE id = ?", [b.monthly_limit_usd, match.id]);
        updated++;
      }
    } else {
      await db.run(
        "INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES (?, ?, ?)",
        [b.scope_type, b.scope_value, b.monthly_limit_usd]
      );
      created++;
    }
  }

  // Remove budgets no longer present in the file (prevents drift)
  for (const e of existing) {
    if (!desiredKeys.has(`${e.scope_type}:${e.scope_value}`)) {
      await db.run("DELETE FROM budgets WHERE id = ?", [e.id]);
      removed++;
    }
  }

  return { created, updated, removed, total: desired.length };
}

// desired: the raw `tagging_rules:` list from finops.yaml, each entry
// shaped like `{ match: { api_key_prefix }, assign: { team, ... } }`. A
// malformed entry (no `match.api_key_prefix`) is not defensively validated
// here - it falls through to the INSERT's NOT NULL constraint and surfaces
// as a 400 from the route handler below, same minimal-validation style as
// syncBudgets above (which relies on the same natural-constraint-failure
// path for a malformed budget entry).
function normalizeTagRule(entry) {
  const row = { api_key_prefix: entry?.match?.api_key_prefix || null };
  for (const f of ASSIGNABLE_FIELDS) {
    row[f] = entry?.assign?.[f] || null;
  }
  return row;
}

async function syncTagRules(desiredRaw, db) {
  const desired = desiredRaw.map(normalizeTagRule);
  const existing = await db.all("SELECT * FROM tag_rules");
  const desiredPrefixes = new Set(desired.map((r) => r.api_key_prefix));

  let created = 0, updated = 0, removed = 0;

  for (const r of desired) {
    const match = existing.find((e) => e.api_key_prefix === r.api_key_prefix);
    if (match) {
      const changed = ASSIGNABLE_FIELDS.some((f) => (match[f] || null) !== (r[f] || null));
      if (changed) {
        await db.run(
          `UPDATE tag_rules SET team = ?, environment = ?, project_id = ?, cost_center = ?, customer_id = ?, feature_id = ? WHERE id = ?`,
          [r.team, r.environment, r.project_id, r.cost_center, r.customer_id, r.feature_id, match.id]
        );
        updated++;
      }
    } else {
      await db.run(
        `INSERT INTO tag_rules (api_key_prefix, team, environment, project_id, cost_center, customer_id, feature_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.api_key_prefix, r.team, r.environment, r.project_id, r.cost_center, r.customer_id, r.feature_id]
      );
      created++;
    }
  }

  for (const e of existing) {
    if (!desiredPrefixes.has(e.api_key_prefix)) {
      await db.run("DELETE FROM tag_rules WHERE id = ?", [e.id]);
      removed++;
    }
  }

  return { created, updated, removed, total: desired.length };
}

async function syncFromFile(db = defaultDb) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`finops.yaml not found at ${CONFIG_PATH}`);
  }
  const doc = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) || {};

  const budgetsResult = await syncBudgets(doc.budgets || [], db);
  const tagRulesResult = await syncTagRules(doc.tagging_rules || [], db);

  // Top-level created/updated/removed/total stay budgets-only, for
  // backward compatibility with anything already reading this response
  // shape; tagging_rules gets its own namespaced result alongside it.
  return { ...budgetsResult, tagging_rules: tagRulesResult };
}

router.post("/sync", requireAuth("manage_budgets"), async (req, res) => {
  try {
    const result = await syncFromFile(req.db);
    await logAudit(req.apiKey.key_id, "gitops.sync", "finops.yaml", result, req.db);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = { router, syncFromFile };
