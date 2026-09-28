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
const { generateToken, hashToken } = require("./tokenHash");

const tenantSessions = new Map(); // token -> { tenantId, tenantSchema, username, role, expiresAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour - see users.js, identical reasoning
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function createTenantUser({ tenant_id, username, password, role = "viewer", email = null, db }) {
  const { hash, salt } = hashPassword(password);
  await db.run(
    "INSERT INTO users (tenant_id, username, password_hash, salt, role, email) VALUES (?, ?, ?, ?, ?, ?)",
    [tenant_id, username, hash, salt, role, email || null]
  );
  if (email) {
    return { verifyToken: await issueTenantEmailVerificationToken({ tenant_id, username, db }) };
  }
  return {};
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

function invalidateAllTenantSessionsFor(tenant_id, username) {
  for (const [token, session] of tenantSessions.entries()) {
    if (session.tenantId === tenant_id && session.username === username) tenantSessions.delete(token);
  }
}

// Self-service reset, step 1 - same enumeration-safe "null means nothing to
// do" contract as users.js's requestPasswordReset. tenant_id is required (as
// everywhere else in this file) so the lookup can never cross into another
// tenant's username.
async function requestTenantPasswordReset({ tenant_id, username, db }) {
  const user = await db.get("SELECT * FROM users WHERE tenant_id = ? AND username = ?", [tenant_id, username]);
  if (!user || !user.email) return null;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await db.run(
    "UPDATE users SET reset_token_hash = ?, reset_token_expires_at = ? WHERE tenant_id = ? AND username = ?",
    [hashToken(token), expiresAt, tenant_id, username]
  );
  return { token, email: user.email, username: user.username };
}

// Self-service reset, step 2. Deliberately NOT scoped by tenant_id in the
// WHERE clause (unlike every other function here) - the caller only has a
// token from an emailed link, not a tenant_id to assert up front (that's the
// whole point of a token-based reset vs. the admin-triggered one above), and
// reset_token_hash is drawn from a 32-byte random value so collision across
// tenants is not a realistic concern. tenant_id is still returned so the
// caller can log/scope anything downstream correctly.
async function resetTenantPasswordWithToken({ token, newPassword, db }) {
  const user = await db.get("SELECT * FROM users WHERE reset_token_hash = ?", [hashToken(token)]);
  if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at).getTime() < Date.now()) {
    throw new Error("This reset link is invalid or has expired");
  }
  const { hash, salt } = hashPassword(newPassword);
  await db.run(
    "UPDATE users SET password_hash = ?, salt = ?, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE tenant_id = ? AND username = ?",
    [hash, salt, user.tenant_id, user.username]
  );
  invalidateAllTenantSessionsFor(user.tenant_id, user.username);
  return { tenant_id: user.tenant_id, username: user.username };
}

async function issueTenantEmailVerificationToken({ tenant_id, username, db }) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  await db.run(
    "UPDATE users SET verify_token_hash = ?, verify_token_expires_at = ? WHERE tenant_id = ? AND username = ?",
    [hashToken(token), expiresAt, tenant_id, username]
  );
  return token;
}

async function requestTenantEmailVerification({ tenant_id, username, db }) {
  const user = await db.get("SELECT * FROM users WHERE tenant_id = ? AND username = ?", [tenant_id, username]);
  if (!user || !user.email || user.email_verified) return null;
  const token = await issueTenantEmailVerificationToken({ tenant_id, username, db });
  return { token, email: user.email, username: user.username };
}

// Same "not tenant-scoped in the WHERE clause" reasoning as
// resetTenantPasswordWithToken - the caller only has the token itself.
async function verifyTenantEmailToken({ token, db }) {
  const user = await db.get("SELECT * FROM users WHERE verify_token_hash = ?", [hashToken(token)]);
  if (!user || !user.verify_token_expires_at || new Date(user.verify_token_expires_at).getTime() < Date.now()) {
    throw new Error("This verification link is invalid or has expired");
  }
  await db.run(
    "UPDATE users SET email_verified = 1, verify_token_hash = NULL, verify_token_expires_at = NULL WHERE tenant_id = ? AND username = ?",
    [user.tenant_id, user.username]
  );
  return { tenant_id: user.tenant_id, username: user.username };
}

module.exports = {
  createTenantUser,
  verifyTenantLogin,
  createTenantSession,
  getTenantSession,
  destroyTenantSession,
  destroyAllSessionsForTenant,
  resetTenantPassword,
  requestTenantPasswordReset,
  resetTenantPasswordWithToken,
  requestTenantEmailVerification,
  verifyTenantEmailToken,
};
