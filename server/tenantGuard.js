// tenantGuard.js - fail loudly, not silently, where multi-tenant support is incomplete.
//
// In multi-tenant mode each tenant's data lives in its own Postgres schema, reached
// through req.db. The route groups below were written against ONE global database
// and have not been converted: left mounted, they would read and write the default
// schema for every tenant - so tenant A could see tenant B's commitments, alerts or
// logged tool calls. A 501 that says so is safe; a quiet leak is not.
//
// This is a stopgap, not a feature: converting a group means threading req.db through
// its module (see how routes/budgets.js and budgets/alerts callers do it), adding a
// two-tenant test to test/multiTenantIsolation.test.js, and deleting its line here.
// Single-tenant mode is unaffected - the guard is a no-op unless multi-tenant is on.

const tenancy = require("./tenancy");

const NOT_TENANT_AWARE = [
  { path: "/api/alerts", why: "alert log and alert checks run against the default database" },
  { path: "/api/commitments", why: "commitments are stored in the default database" },
  { path: "/api/gitops", why: "budget sync writes to the default database" },
  { path: "/api/reconcile", why: "provider invoice imports use the default database" },
  { path: "/api/reports", why: "weekly briefings read the default database" },
  { path: "/api/query", why: "the natural-language query reads the default database" },
  { path: "/api/tool-calls", why: "the tool-call audit log is stored in the default database" },
];

function blockInMultiTenant({ isMultiTenant = () => tenancy.MULTI_TENANT } = {}) {
  return function notTenantAware(req, res, next) {
    if (!isMultiTenant()) return next();
    const entry = NOT_TENANT_AWARE.find((e) => req.baseUrl === e.path);
    return res.status(501).json({
      error: `${req.baseUrl} is not available in multi-tenant mode yet: ${entry ? entry.why : "it is not tenant-aware"}. It is disabled rather than risk showing one tenant another tenant's data.`,
    });
  };
}

module.exports = { NOT_TENANT_AWARE, blockInMultiTenant };
