// auth.js - simple API-key based auth + RBAC (Admin, Budget-Manager, Developer, Viewer)
//
// This is intentionally simple (no SAML/OIDC yet by default - see
// server/sso.js for a spec-compliant OIDC client you can wire up with your
// own identity provider credentials). For a self-hosted single-tenant
// deployment, API keys + roles + optional session login cover real access
// control needs without external dependencies.

const db = require("./storage");
const { getSession } = require("./users");
const logger = require("./logger");

// Fires once per process, the first time a request is served under
// bootstrap mode, so wide-open access is never silent - see the HOST/
// bootstrap notes in server/index.js and the README's "Bootstrap mode"
// section for the full context.
let warnedBootstrapAccess = false;

const ROLE_PERMISSIONS = {
  admin: ["read", "write", "manage_keys", "manage_budgets", "approve_quarantine"],
  "budget-manager": ["read", "manage_budgets"],
  developer: ["read", "write"], // write = can send usage events for their own key
  viewer: ["read"],
};

function hasPermission(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

// Multi-tenant branch: completely separate code path, only ever reached
// when FINOPS_MULTI_TENANT=true. Deliberately NOT merged into the
// single-tenant logic below it (even though there's some shared shape) so
// that single-tenant behavior can never be accidentally affected by
// multi-tenant changes, and vice versa - see tenancy.js's own header
// comment for the isolation model this resolves into.
async function requireTenantAuth(permission) {
  const tenancy = require("./tenancy");
  const { getTenantSession } = require("./tenantUsers");
  return async (req, res, next) => {
    const sessionToken = req.header("X-Session-Token");
    if (sessionToken) {
      const session = getTenantSession(sessionToken);
      if (!session) {
        return res.status(401).json({ error: "Invalid or expired session token" });
      }
      if (permission && !hasPermission(session.role, permission)) {
        return res.status(403).json({ error: `Role '${session.role}' lacks '${permission}' permission` });
      }
      const tenantRow = await tenancy.getTenantStatus(session.tenantId);
      const denialReason = tenancy.tenantAccessDenialReason(tenantRow);
      if (denialReason) {
        await tenancy.markTrialExpiredIfObserved(tenantRow).catch(() => {});
        return res.status(403).json({ error: denialReason });
      }
      req.apiKey = { role: session.role, key_id: `user:${session.username}`, label: session.username, tenant_id: session.tenantId };
      req.tenantId = session.tenantId;
      req.tenantSchema = session.tenantSchema;
      req.tenantLimits = { max_api_keys: tenantRow.max_api_keys, max_budgets: tenantRow.max_budgets, max_monthly_events: tenantRow.max_monthly_events };
      req.db = await tenancy.getTenantDb(session.tenantSchema);
      req.controlPlaneDb = tenancy.initControlPlane().controlPlaneDb;
      return next();
    }

    const keyId = req.header("X-API-Key");
    if (!keyId) {
      return res.status(401).json({ error: "Missing X-API-Key or X-Session-Token header" });
    }

    // No bootstrap mode here, unlike single-tenant: "no keys exist yet"
    // means nothing on a shared hosted platform - it doesn't imply the
    // caller is the platform's sole legitimate operator the way it does
    // for someone's own self-hosted instance. Tenants and their first key
    // are provisioned explicitly (tenancy.createTenant +
    // tenancy.createTenantApiKey), an ops action, never an automatic
    // side effect of an unauthenticated request.
    const row = await tenancy.resolveTenantApiKey(keyId);
    if (!row) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    const denialReason = tenancy.tenantAccessDenialReason({
      id: row.tenant_id,
      status: row.tenant_status,
      trial_ends_at: row.tenant_trial_ends_at,
      suspended_reason: row.tenant_suspended_reason,
    });
    if (denialReason) {
      await tenancy.markTrialExpiredIfObserved({ id: row.tenant_id, status: row.tenant_status, trial_ends_at: row.tenant_trial_ends_at }).catch(() => {});
      return res.status(403).json({ error: denialReason });
    }
    if (row.status === "revoked") {
      return res.status(403).json({ error: "This API key has been revoked" });
    }
    if (permission && !hasPermission(row.role, permission)) {
      return res.status(403).json({ error: `Role '${row.role}' lacks '${permission}' permission` });
    }

    req.apiKey = row;
    req.tenantId = row.tenant_id;
    req.tenantSchema = row.tenant_schema;
    req.tenantLimits = { max_api_keys: row.tenant_max_api_keys, max_budgets: row.tenant_max_budgets, max_monthly_events: row.tenant_max_monthly_events };
    req.db = await tenancy.getTenantDb(row.tenant_schema);
    // api_keys/users live in the shared control-plane schema, not in any
    // tenant's own schema (see schema.controlPlane.js) - resolveTenantApiKey
    // above already awaited controlPlaneReady, so this is safe to read
    // immediately without awaiting again.
    req.controlPlaneDb = tenancy.initControlPlane().controlPlaneDb;
    next();
  };
}

// Middleware factory: requireAuth('read') / requireAuth('manage_budgets') etc.
// Accepts EITHER an X-API-Key (service/proxy auth) OR an X-Session-Token
// (human dashboard login via /api/auth/login) - whichever is present.
//
// In multi-tenant mode (FINOPS_MULTI_TENANT=true), delegates entirely to
// requireTenantAuth above - none of the single-tenant logic below this
// guard ever runs, and none of it changes behavior when multi-tenant mode
// is off (the overwhelmingly common case: every self-hosted deployment).
function requireAuth(permission) {
  const MULTI_TENANT = process.env.FINOPS_MULTI_TENANT === "true";
  if (MULTI_TENANT) {
    // requireTenantAuth is itself async (it lazy-requires ./tenancy to
    // avoid loading the `pg` pool machinery at all for single-tenant
    // deployments that never touch this branch) - resolve it once, lazily,
    // the first time this permission-scoped middleware is actually invoked.
    let middlewarePromise = null;
    return async (req, res, next) => {
      if (!middlewarePromise) middlewarePromise = requireTenantAuth(permission);
      const middleware = await middlewarePromise;
      return middleware(req, res, next);
    };
  }

  return async (req, res, next) => {
    const sessionToken = req.header("X-Session-Token");
    if (sessionToken) {
      const session = getSession(sessionToken);
      if (!session) {
        return res.status(401).json({ error: "Invalid or expired session token" });
      }
      if (permission && !hasPermission(session.role, permission)) {
        return res.status(403).json({ error: `Role '${session.role}' lacks '${permission}' permission` });
      }
      req.apiKey = { role: session.role, key_id: `user:${session.username}`, label: session.username };
      req.db = db;
      req.controlPlaneDb = db; // single-tenant: same db, no real control-plane split
      return next();
    }

    const keyId = req.header("X-API-Key");

    // Allow local/dev usage without a key ONLY if no keys AND no users exist yet
    // (fresh install bootstrap) - once you create your first key or user, auth is enforced.
    const anyKeys = await db.get("SELECT COUNT(*) AS n FROM api_keys");
    const anyUsers = await db.get("SELECT COUNT(*) AS n FROM users");
    if (anyKeys.n === 0 && anyUsers.n === 0) {
      if (!warnedBootstrapAccess) {
        warnedBootstrapAccess = true;
        logger.warn(
          "No API keys or users exist yet - every request is being served as admin under bootstrap mode. Create your first key or user (POST /api/auth/register) to close this window."
        );
      }
      req.apiKey = { role: "admin", key_id: "bootstrap", label: "bootstrap (no keys/users created yet)" };
      req.db = db;
      req.controlPlaneDb = db; // single-tenant: same db, no real control-plane split
      return next();
    }

    if (!keyId) {
      return res.status(401).json({ error: "Missing X-API-Key or X-Session-Token header" });
    }

    const row = await db.get("SELECT * FROM api_keys WHERE key_id = ?", [keyId]);
    if (!row) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    if (row.status === "revoked") {
      return res.status(403).json({ error: "This API key has been revoked" });
    }

    if (permission && !hasPermission(row.role, permission)) {
      return res.status(403).json({ error: `Role '${row.role}' lacks '${permission}' permission` });
    }

    req.apiKey = row;
    req.db = db;
    req.controlPlaneDb = db; // single-tenant: same db, no real control-plane split
    next();
  };
}

module.exports = { requireAuth, hasPermission, ROLE_PERMISSIONS };
