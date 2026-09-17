// routes/gitops.js - "FinOps as Code": sync budgets from finops.yaml
//
// Simple version of the blueprint's GitOps idea: no GitHub Action wiring yet
// (that requires a repo + CI to call this endpoint on push), but the
// sync-on-file-change logic - including drift removal - is fully implemented.

const express = require("express");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const db = require("../storage");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, "..", "..", "finops.yaml");

async function syncFromFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`finops.yaml not found at ${CONFIG_PATH}`);
  }
  const doc = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
  const desired = doc.budgets || [];

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

router.post("/sync", requireAuth("manage_budgets"), async (req, res) => {
  try {
    const result = await syncFromFile();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = { router, syncFromFile };
