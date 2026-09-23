// tenantUsers.js - human dashboard accounts for MULTI-TENANT mode.
//
// Parallel to users.js, not a generalization of it: single-tenant's `users`
// table has no tenant_id column at all (see schema.controlPlane.js's header
// for why the two are kept fully separate), and username is unique PER
// TENANT here rather than globally - two different customers each having an
// "admin" account is normal and must not collide, and must not let one
// tenant's login attempt accidentally match another tenant's row. Every
// query below is therefore scoped by tenant_id, not just username.
//
// Lives in the shared control-plane schema (same place tenants/api_keys
// live), NOT in any tenant's own per-schema database - identity/routing
// data has to be reachable before a request even knows which tenant schema
// to use, same reasoning as tenancy.js's resolveTenantApiKey.
//
// Sessions are in-memory, keyed by a random token, same TTL and the same
// "resets on restart" tradeoff as users.js - but each session entry also
// carries tenantId/tenantSchema, so a bare token is enough on its own to
// resolve a request to the right tenant (the client never has to send a
// tenant id on every request, only at login).

const crypto = require("crypto");
const { hashPassword, passwordMatches } = require("./passwordHash");

const tenantSessions = new Map(); // token -> { tenantId, tenantSchema, username, role, expiresAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

async function createTenantUser({ tenant_id, username, password, role = "viewer", db }) {
  const { hash, salt } = hashPassword(password);
  await db.run(
    "INSERT INTO users (tenant_id, username, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)",
    [tenant_id, username, hash, salt, role]
  );
}

async function verifyTenantLogin({ tenant_id, username, password, db }) {
  const user = await db.get("SELECT * FROM users WHERE tenant_id = ? AND username = ?", [tenant_id, username]);
  if (!user) return null;
  const { hash } = hashPassword(password, user.salt);
  if (!passwordMatches(hash, user.password_hash)) return null;
  return user;
}

function createTenantSession(user, tenantSchema) {
  const token = crypto.randomBytes(32).toString("hex");
  tenantSessions.set(token, {
    tenantId: user.tenant_id,
    tenantSchema,
    username: user.username,
    role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function getTenantSession(token) {
  const session = tenantSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    tenantSessions.delete(token);
    return null;
  }
  return session;
}

function destroyTenantSession(token) {
  tenantSessions.delete(token);
}

// Drops every in-memory session for one tenant - called when a tenant is
// suspended or offboarded (tenantLifecycle.js), the same reason
// governance.js's clearTenantGovernanceState exists: a suspended tenant's
// dashboard users shouldn't keep a live session an hour after the account
// was cut off just because their token hasn't hit its 24h TTL yet.
function destroyAllSessionsForTenant(tenantId) {
  for (const [token, session] of tenantSessions.entries()) {
    if (session.tenantId === tenantId) tenantSessions.delete(token);
  }
}

// Admin-triggered password reset, scoped to the admin's own tenant - see
// users.js's resetPassword for the no-SMTP rationale, identical here.
// Deliberately takes tenant_id so an admin in tenant A cannot reset a
// username that happens to also exist in tenant B.
async function resetTenantPassword({ tenant_id, username, newPassword, db }) {
  const user = await db.get("SELECT * FROM users WHERE tenant_id = ? AND username = ?", [tenant_id, username]);
  if (!user) throw new Error("User not found");
  const { hash, salt } = hashPassword(newPassword);
  await db.run("UPDATE users SET password_hash = ?, salt = ? WHERE tenant_id = ? AND username = ?", [
    hash,
    salt,
    tenant_id,
    username,
  ]);

  for (const [token, session] of tenantSessions.entries()) {
    if (session.tenantId === tenant_id && session.username === username) tenantSessions.delete(token);
  }
}

module.exports = {
  createTenantUser,
  verifyTenantLogin,
  createTenantSession,
  getTenantSession,
  destroyTenantSession,
  destroyAllSessionsForTenant,
  resetTenantPassword,
};
