// audit.js - immutable audit trail for configuration changes.
//
// Distinct from alerts_log (system-generated: budget thresholds, circuit
// breaker triggers) - this captures human/actor-driven changes: who created
// a budget, who revoked a key, who overrode a price. Required for SOC2/audit
// readiness per the original blueprint's compliance section.

const db = require("./db");

const insert = db.prepare(
  "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
);

function logAudit(actor, action, target, details = {}) {
  insert.run(actor, action, target || null, JSON.stringify(details));
}

function getAuditLog({ limit = 100, action, actor } = {}) {
  let query = "SELECT * FROM audit_log";
  const conditions = [];
  const params = [];
  if (action) {
    conditions.push("action = ?");
    params.push(action);
  }
  if (actor) {
    conditions.push("actor = ?");
    params.push(actor);
  }
  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  return db.prepare(query).all(...params);
}

module.exports = { logAudit, getAuditLog };