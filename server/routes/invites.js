// routes/invites.js - "invite a teammate" (single- and multi-tenant).
//
//   POST   /api/invites          admin: invite an email address (emails a link)
//   GET    /api/invites          admin: list pending invites (never the tokens)
//   DELETE /api/invites/:id      admin: revoke a pending invite
//   POST   /api/invites/accept   anonymous: redeem the emailed token, choosing
//                                a username and password
//
// Unlike routes/auth.js there is one flow for both modes: requireAuth already
// resolves the right database (req.controlPlaneDb is the shared control plane
// in multi-tenant mode and the one database in single-tenant mode) and, in
// multi-tenant mode, req.tenantId. The only mode-specific code is how the
// invite store is scoped and how the user row is created.
//
// DELIBERATE CHOICES (see invites.js for the security properties):
//   * The invite email is AWAITED, not detached. Creation is authenticated,
//     so response time can leak nothing to an anonymous caller, and the admin
//     is told whether the mail actually went out (`email_sent`). The anonymous
//     forgot-password/resend-verification endpoints are the opposite case and
//     detach their sends (routes/auth.js sendInBackground).
//   * Accepting never reveals WHY a token failed. Unknown, expired, already
//     used, revoked, or belonging to a suspended tenant all return the same
//     400. The only account-specific answer is "username already taken",
//     which is only reachable by someone already holding a valid token.
//   * Request-shape errors (missing/short fields) are decided before the token
//     is looked up, so a 400 for shape never depends on whether a token exists.
//   * Redeeming is rate-limited by IP with the shared token-redeem limiter.

const express = require("express");
const db = require("../storage");
const tenancy = require("../tenancy");
const { requireAuth } = require("../auth");
const { createUser } = require("../users");
const { createTenantUser } = require("../tenantUsers");
const { logAudit } = require("../audit");
const { tokenRedeemRateLimit } = require("../loginRateLimit");
const { sendInviteEmail } = require("../accountEmail");
const { isValidEmail } = require("../emailLookup");
const invites = require("../invites");
const logger = require("../logger");

const router = express.Router();

const INVALID_INVITE = "This invitation is invalid or has expired.";

function storeFor(req) {
  return tenancy.MULTI_TENANT
    ? invites.tenantInvites(req.controlPlaneDb, req.tenantId)
    : invites.singleTenantInvites(req.controlPlaneDb);
}

// Delivery failure must not turn into a 500 - the invite exists and can be
// re-sent by inviting again; the admin sees email_sent: false.
async function sendInvite(toEmail, token, opts) {
  try {
    return await sendInviteEmail(toEmail, token, opts);
  } catch (err) {
    logger.error("Invite email failed to send", { error: err.message });
    return false;
  }
}

router.post("/", requireAuth("manage_keys"), async (req, res) => {
  const { email, role = "viewer" } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "a valid email is required" });
  }
  if (typeof role !== "string") {
    return res.status(400).json({ error: "role must be a string" });
  }
  let created;
  try {
    created = await storeFor(req).create({
      email,
      role,
      invitedBy: req.apiKey.key_id,
      inviterRole: req.apiKey.role,
    });
  } catch (err) {
    if (err instanceof invites.InviteError) {
      const status = err.code === "too_many_pending" ? 429 : err.code === "role_not_grantable" ? 403 : 400;
      return res.status(status).json({ error: err.message });
    }
    throw err;
  }

  let orgName;
  if (tenancy.MULTI_TENANT) {
    const tenantRow = await tenancy.getTenantStatus(req.tenantId);
    orgName = tenantRow && tenantRow.name;
  }
  const emailSent = await sendInvite(created.email, created.token, { role: created.role, orgName });
  await logAudit(req.apiKey.key_id, "invite.create", created.email, { role: created.role, invite_id: created.id, email_sent: emailSent }, req.db);
  // The raw token is deliberately NOT in the response: it exists only in the
  // emailed link.
  res.status(201).json({ ok: true, id: created.id, email: created.email, role: created.role, expires_at: created.expires_at, email_sent: emailSent });
});

router.get("/", requireAuth("manage_keys"), async (req, res) => {
  res.json(await storeFor(req).listPending());
});

router.delete("/:id", requireAuth("manage_keys"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: "no such pending invitation" });
  }
  // Same 404 whether the id never existed, belongs to another tenant, or is no
  // longer pending.
  if (!(await storeFor(req).revoke(id))) {
    return res.status(404).json({ error: "no such pending invitation" });
  }
  await logAudit(req.apiKey.key_id, "invite.revoke", String(id), {}, req.db);
  res.json({ ok: true });
});

router.post("/accept", tokenRedeemRateLimit, async (req, res) => {
  const { token, username, password } = req.body || {};
  // Shape first - independent of the token.
  if (typeof token !== "string" || !token || typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "token, username and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const sharedDb = tenancy.MULTI_TENANT ? tenancy.initControlPlane().controlPlaneDb : db;
  const invite = await invites.peek(sharedDb, token);
  if (!invite) return res.status(400).json({ error: INVALID_INVITE });

  // A suspended/offboarded tenant must not gain members through an invite
  // that was issued before it was suspended.
  let tenantRow = null;
  if (tenancy.MULTI_TENANT) {
    tenantRow = await tenancy.getTenantStatus(invite.tenant_id);
    if (!tenantRow || tenancy.tenantAccessDenialReason(tenantRow)) {
      return res.status(400).json({ error: INVALID_INVITE });
    }
  }

  if (!(await invites.consume(sharedDb, invite))) {
    return res.status(400).json({ error: INVALID_INVITE }); // lost a race to another accept/revoke
  }

  const cleanUsername = username.trim();
  try {
    if (tenancy.MULTI_TENANT) {
      await createTenantUser({
        tenant_id: invite.tenant_id,
        username: cleanUsername,
        password,
        role: invite.role,
        email: invite.email,
        emailVerified: true,
        db: sharedDb,
      });
    } else {
      await createUser({ username: cleanUsername, password, role: invite.role, email: invite.email, emailVerified: true });
    }
  } catch (err) {
    // Give the invitee their link back so they can retry with another name.
    await invites.restore(sharedDb, invite);
    if (/unique/i.test(err.message)) {
      return res.status(409).json({ error: "that username is already taken" });
    }
    logger.error("Invite accepted but account creation failed", { error: err.message });
    return res.status(500).json({ error: "could not create the account" });
  }

  try {
    const auditDb = tenancy.MULTI_TENANT ? await tenancy.getTenantDb(tenantRow.schema_name) : db;
    await logAudit(cleanUsername, "invite.accept", invite.email, { role: invite.role, invite_id: invite.id }, auditDb);
  } catch (err) {
    logger.error("Failed to write invite-accepted audit entry", { error: err.message });
  }
  // Multi-tenant login needs the tenant id up front, and the invitee has no
  // other way to learn it - returning it here is safe, they hold a valid token.
  const body = { ok: true, username: cleanUsername, role: invite.role };
  if (tenancy.MULTI_TENANT) body.tenant_id = invite.tenant_id;
  res.status(201).json(body);
});

module.exports = router;
