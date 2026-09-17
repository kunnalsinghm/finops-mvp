// audit.js - immutable audit trail for configuration changes.
//
// Distinct from alerts_log (system-generated: budget thresholds, circuit
// breaker triggers) - this captures human/actor-driven changes: who created
// a budget, who revoked a key, who overrode a price. Required for SOC2/audit
// readiness per the original blueprint's compliance section.

const db = require("./storage");

async function logAudit(actor, action, target, details = {}) {
  // created_at is set explicitly here (JS ISO string) rather than relying on
  // the schema's dialect-native DEFAULT, for the same reason event_time
  // always is: a single consistent format regardless of backend. Nothing
  // queries this column by range today, but keeping the convention uniform
  // avoids a future date-range query silently mis-comparing two different
  // per-dialect timestamp formats.
  await db.run(
    "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)",
    [actor, action, target || null, JSON.stringify(details), new Date().toISOString()]
  );
}

async function getAuditLog({ limit = 100, action, actor } = {}) {
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
  return db.all(query, params);
}

module.exports = { logAudit, getAuditLog };
