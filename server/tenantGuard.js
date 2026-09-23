// tenantGuard.js - fail loudly, not silently, where multi-tenant support is incomplete.
//
// In multi-tenant mode each tenant's data lives in its own Postgres schema, reached
// through req.db. Any route group written against a hardcoded global database instead
// of req.db would, left mounted, read and write the default schema for every tenant -
// so tenant A could see tenant B's commitments, alerts or logged tool calls. A 501 that
// says so is safe; a quiet leak is not.
//
// NOT_TENANT_AWARE is empty: alerts, commitments, gitops, reconcile, reports, query and
// tool-calls have all been converted to thread req.db through (see routes/budgets.js for
// the pattern this project follows) and are covered by two-tenant isolation tests in
// test/multiTenantIsolation.test.js. The mechanism below is kept, not deleted - it's the
// safety net for the NEXT route group that ships before its multi-tenant conversion is
// done, not a one-time migration script. To add a group: list it here BEFORE it is
// mounted in index.js, and remove it once req.db is threaded through and isolation-tested.
// Single-tenant mode is unaffected either way - the guard is a no-op unless multi-tenant
// is on.

const tenancy = require("./tenancy");

const NOT_TENANT_AWARE = [];

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
