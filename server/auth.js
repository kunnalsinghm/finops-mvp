// auth.js - simple API-key based auth + RBAC (Admin, Budget-Manager, Developer, Viewer)
//
// This is intentionally simple (no SAML/OIDC yet by default - see
// server/sso.js for a spec-compliant OIDC client you can wire up with your
// own identity provider credentials). For a self-hosted single-tenant
// deployment, API keys + roles + optional session login cover real access
// control needs without external dependencies.

const db = require("./db");
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

// Middleware factory: requireAuth('read') / requireAuth('manage_budgets') etc.
// Accepts EITHER an X-API-Key (service/proxy auth) OR an X-Session-Token
// (human dashboard login via /api/auth/login) - whichever is present.
function requireAuth(permission) {
  return (req, res, next) => {
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
      return next();
    }

    const keyId = req.header("X-API-Key");

    // Allow local/dev usage without a key ONLY if no keys AND no users exist yet
    // (fresh install bootstrap) - once you create your first key or user, auth is enforced.
    const anyKeys = db.prepare("SELECT COUNT(*) AS n FROM api_keys").get();
    const anyUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get();
    if (anyKeys.n === 0 && anyUsers.n === 0) {
      if (!warnedBootstrapAccess) {
        warnedBootstrapAccess = true;
        logger.warn(
          "No API keys or users exist yet - every request is being served as admin under bootstrap mode. Create your first key or user (POST /api/auth/register) to close this window."
        );
      }
      req.apiKey = { role: "admin", key_id: "bootstrap", label: "bootstrap (no keys/users created yet)" };
      return next();
    }

    if (!keyId) {
      return res.status(401).json({ error: "Missing X-API-Key or X-Session-Token header" });
    }

    const row = db.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(keyId);
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
    next();
  };
}

module.exports = { requireAuth, hasPermission, ROLE_PERMISSIONS };
