// tenantQuota.js - per-tenant resource limits: max API keys, max budgets,
// max monthly usage events. Before this file existed, nothing stopped one
// tenant provisioning unbounded objects in shared infrastructure - a bug (or
// a script gone wrong, or a bad-faith actor) on one tenant's side had no
// ceiling at all.
//
// Limits live on the tenant's own control-plane row (max_api_keys,
// max_budgets, max_monthly_events - see schema.controlPlane.js) and are
// attached to req.tenantLimits by auth.js at authentication time (joined
// into the same query that already resolves the tenant, for the API-key
// path - see resolveTenantApiKey - or read off the same tenant-status
// lookup requireTenantAuth already does for the session-token path), so
// checking a quota here costs exactly one extra COUNT query, not a second
// round trip to the control plane on every single check.
//
// Single-tenant mode: req.tenantId is never set there, so every check below
// short-circuits to { allowed: true } immediately - this module has zero
// effect outside multi-tenant mode, same as every other tenant-only control
// in this codebase.
//
// HONEST LIMITATION: checkMonthlyEventQuota runs a COUNT(*) against
// usage_events on every ingest/proxy call in multi-tenant mode - a real
// per-request cost, not a free check. That's an acceptable tradeoff at the
// "modest number of paying customers" scale tenancy.js's own header comment
// already targets; if this ever needs to run at high request volume, the
// right fix is a per-tenant in-memory counter refreshed periodically (same
// shape as governance.js's rate-limit buckets), not removing the check.

const { yearMonthExpr } = require("./storage/dialectSql");

function quotaResult({ allowed, limit, count, resource, message }) {
  return { allowed, limit, count, resource, message: allowed ? null : message };
}

async function checkApiKeyQuota(req) {
  if (!req.tenantId) return quotaResult({ allowed: true, resource: "api_keys" });
  const limit = req.tenantLimits?.max_api_keys;
  if (limit == null) return quotaResult({ allowed: true, resource: "api_keys" });

  const row = await req.controlPlaneDb.get("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ?", [req.tenantId]);
  const count = Number(row?.n || 0);
  return quotaResult({
    allowed: count < limit,
    limit,
    count,
    resource: "api_keys",
    message: `This tenant has reached its API key limit (${limit}). Revoke an unused key, or contact support to raise this limit.`,
  });
}

async function checkBudgetQuota(req) {
  if (!req.tenantId) return quotaResult({ allowed: true, resource: "budgets" });
  const limit = req.tenantLimits?.max_budgets;
  if (limit == null) return quotaResult({ allowed: true, resource: "budgets" });

  const row = await req.db.get("SELECT COUNT(*) AS n FROM budgets");
  const count = Number(row?.n || 0);
  return quotaResult({
    allowed: count < limit,
    limit,
    count,
    resource: "budgets",
    message: `This tenant has reached its budget limit (${limit}). Remove an unused budget, or contact support to raise this limit.`,
  });
}

async function checkMonthlyEventQuota(req) {
  if (!req.tenantId) return quotaResult({ allowed: true, resource: "monthly_events" });
  const limit = req.tenantLimits?.max_monthly_events;
  if (limit == null) return quotaResult({ allowed: true, resource: "monthly_events" });

  const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const row = await req.db.get(
    `SELECT COUNT(*) AS n FROM usage_events WHERE ${yearMonthExpr("event_time")} = ?`,
    [month]
  );
  const count = Number(row?.n || 0);
  return quotaResult({
    allowed: count < limit,
    limit,
    count,
    resource: "monthly_events",
    message: `This tenant has reached its monthly usage-event limit (${limit} events this month). Contact support to raise this limit.`,
  });
}

module.exports = { checkApiKeyQuota, checkBudgetQuota, checkMonthlyEventQuota };
