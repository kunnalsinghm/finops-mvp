// routes/gitops.js - "FinOps as Code": sync budgets from finops.yaml
//
// Simple version of the blueprint's GitOps idea: no GitHub Action wiring yet
// (that requires a repo + CI to call this endpoint on push), but the
// sync-on-file-change logic - including drift removal - is fully implemented.

const express = require("express");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, "..", "..", "finops.yaml");

function syncFromFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`finops.yaml not found at ${CONFIG_PATH}`);
  }
  const doc = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
  const desired = doc.budgets || [];

  const existing = db.prepare("SELECT * FROM budgets").all();
  const desiredKeys = new Set(desired.map((b) => `${b.scope_type}:${b.scope_value}`));

  let created = 0, updated = 0, removed = 0;

  // Upsert desired budgets
  for (const b of desired) {
    const match = existing.find(
      (e) => e.scope_type === b.scope_type && e.scope_value === b.scope_value
    );
    if (match) {
      if (match.monthly_limit_usd !== b.monthly_limit_usd) {
        db.prepare("UPDATE budgets SET monthly_limit_usd = ? WHERE id = ?").run(
          b.monthly_limit_usd,
          match.id
        );
        updated++;
      }
    } else {
      db.prepare(
        "INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES (?, ?, ?)"
      ).run(b.scope_type, b.scope_value, b.monthly_limit_usd);
      created++;
    }
  }

  // Remove budgets no longer present in the file (prevents drift)
  for (const e of existing) {
    if (!desiredKeys.has(`${e.scope_type}:${e.scope_value}`)) {
      db.prepare("DELETE FROM budgets WHERE id = ?").run(e.id);
      removed++;
    }
  }

  return { created, updated, removed, total: desired.length };
}

router.post("/sync", requireAuth("manage_budgets"), (req, res) => {
  try {
    const result = syncFromFile();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = { router, syncFromFile };