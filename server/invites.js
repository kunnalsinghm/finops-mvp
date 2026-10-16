// invites.js - "invite a teammate": an admin invites an email address, the
// recipient follows an emailed link and chooses their own username/password.
//
// DB-only logic, like users.js: this file never sends mail (accountEmail.js
// does) and never creates the user (users.js / tenantUsers.js do). It owns
// "what an invite token unlocks": issuing, listing, revoking, and the
// peek -> consume -> (restore) sequence that makes a token single-use.
//
// Security properties, and where each one is enforced:
//   * Tokens are 32 random bytes; only a sha256 HASH is stored (tokenHash.js),
//     so a database dump cannot be used to accept an outstanding invite.
//   * Expiry: INVITE_TTL_MS, checked in peek() AND again inside the atomic
//     consume, so an invite cannot be accepted after it expires even if peek()
//     ran just before the deadline.
//   * Single use: consume() is ONE conditional UPDATE (accepted_at IS NULL AND
//     revoked_at IS NULL AND expires_at > now) and succeeds for exactly one of
//     any number of concurrent accepts - the row count is the lock.
//   * No privilege escalation: an inviter may only grant a role whose
//     permissions are a subset of their own (canGrantRole).
//   * Tenant scoping (multi-tenant): every query except the token lookup is
//     constrained by tenant_id, and tenantInvites() refuses to be built
//     without one, so a missing tenant id cannot silently become an unscoped
//     query over every tenant's invites. The token lookup is by token hash
//     alone and derives the tenant FROM the invite row - the caller never
//     supplies it.
//   * Bounded fan-out: at most MAX_PENDING_INVITES pending invites per
//     deployment/tenant, so an admin credential cannot be used to mail an
//     unbounded number of strangers.

const { generateToken, hashToken } = require("./tokenHash");
const { normalizeEmail } = require("./emailLookup");
const { ROLE_PERMISSIONS, DASHBOARD_ROLES } = require("./auth");

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_INVITES = 50;

class InviteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A role may be granted only if every permission it carries is also held by
// the granter. "agent" (machine-scoped) is never a dashboard role, so it is
// refused outright rather than falling out of the subset test.
function canGrantRole(inviterRole, targetRole) {
  if (!DASHBOARD_ROLES.includes(targetRole)) return false;
  const have = new Set(ROLE_PERMISSIONS[inviterRole] || []);
  return (ROLE_PERMISSIONS[targetRole] || []).every((p) => have.has(p));
}

function build(db, tenantId) {
  const scoped = tenantId !== undefined;
  const tenantSql = scoped ? " AND tenant_id = ?" : "";
  const tenantParams = scoped ? [tenantId] : [];

  async function pendingCount(nowIso) {
    const row = await db.get(
      `SELECT COUNT(*) AS n FROM invites WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?${tenantSql}`,
      [nowIso, ...tenantParams]
    );
    return Number(row.n);
  }

  // Returns { id, token, email, role, expires_at }. The raw token is returned
  // ONCE, for the caller to email - it is never retrievable again.
  async function create({ email, role, invitedBy, inviterRole }) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw new InviteError("bad_email", "a valid email is required");
    if (!canGrantRole(inviterRole, role)) {
      throw new InviteError("role_not_grantable", `you cannot grant the role '${role}'`);
    }
    const now = new Date();
    const nowIso = now.toISOString();

    // Re-inviting an address supersedes its older pending invite (so only the
    // newest link works) - done before the cap check so a re-invite never
    // counts against the limit twice.
    await db.run(
      `UPDATE invites SET revoked_at = ? WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL${tenantSql}`,
      [nowIso, normalized, ...tenantParams]
    );
    if ((await pendingCount(nowIso)) >= MAX_PENDING_INVITES) {
      throw new InviteError("too_many_pending", `too many pending invitations (limit ${MAX_PENDING_INVITES}); revoke some first`);
    }

    const token = generateToken();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    const columns = ["email", "role", "token_hash", "invited_by", "created_at", "expires_at"];
    const values = [normalized, role, hashToken(token), String(invitedBy), nowIso, expiresAt];
    if (scoped) {
      columns.unshift("tenant_id");
      values.unshift(tenantId);
    }
    await db.run(
      `INSERT INTO invites (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      values
    );
    const row = await db.get("SELECT id FROM invites WHERE token_hash = ?", [hashToken(token)]);
    return { id: row.id, token, email: normalized, role, expires_at: expiresAt };
  }

  async function listPending() {
    return db.all(
      `SELECT id, email, role, invited_by, created_at, expires_at FROM invites
       WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?${tenantSql}
       ORDER BY id`,
      [new Date().toISOString(), ...tenantParams]
    );
  }

  // true if a pending invite was revoked; false if there was nothing to revoke
  // (unknown id, another tenant's id, already accepted/revoked) - the route
  // answers all of those identically.
  async function revoke(id) {
    const info = await db.run(
      `UPDATE invites SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL${tenantSql}`,
      [new Date().toISOString(), id, ...tenantParams]
    );
    return info.changes === 1;
  }

  return { create, listPending, revoke };
}

function singleTenantInvites(db) {
  return build(db, undefined);
}

function tenantInvites(db, tenantId) {
  if (tenantId === undefined || tenantId === null) {
    throw new Error("tenantInvites requires a tenant id - refusing to build an unscoped invite store");
  }
  return build(db, tenantId);
}

// ---- Redeeming (anonymous side; lookup is by token hash only) ----

// The invite row if `token` is currently redeemable, otherwise null. Every
// reason it might not be (unknown, expired, accepted, revoked) is the same
// null - the route must not distinguish them either.
async function peek(db, token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 256) return null;
  const row = await db.get("SELECT * FROM invites WHERE token_hash = ?", [hashToken(token)]);
  if (!row) return null;
  if (row.accepted_at || row.revoked_at) return null;
  if (!(row.expires_at > new Date().toISOString())) return null;
  return row;
}

// Atomically marks the invite accepted. Returns true for exactly one caller.
async function consume(db, row) {
  const info = await db.run(
    "UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    [new Date().toISOString(), row.id, new Date().toISOString()]
  );
  return info.changes === 1;
}

// Undo consume() when the account could not be created afterwards (e.g. the
// chosen username is taken), so the invitee can retry with the same link.
async function restore(db, row) {
  await db.run("UPDATE invites SET accepted_at = NULL WHERE id = ?", [row.id]);
}

module.exports = {
  INVITE_TTL_MS,
  MAX_PENDING_INVITES,
  InviteError,
  canGrantRole,
  singleTenantInvites,
  tenantInvites,
  peek,
  consume,
  restore,
};
