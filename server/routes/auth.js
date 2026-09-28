// routes/auth.js - human user registration + login (session-based), plus
// self-service password reset and email verification.
//
// Single-tenant and multi-tenant are two genuinely different flows, not one
// flow with a few tenant_id sprinkled in - same "keep them fully separate"
// reasoning as auth.js's requireTenantAuth vs. its single-tenant sibling.
// Single-tenant: usernames are globally unique, the very first account can
// self-register (bootstrap mode), sessions are one flat in-memory Map.
// Multi-tenant: usernames are only unique WITHIN a tenant, there is no
// bootstrap self-registration (see tenancy.js's own "no bootstrap mode on a
// shared hosted platform" reasoning - a tenant's first dashboard user is
// created as part of signup, see routes/tenants.js), and login needs a
// tenant_id up front since the same username can exist in many tenants.
//
// Self-service forgot-password/verify-email (both modes) share one rule
// throughout: NEVER let the response tell an anonymous caller whether a
// given username (or tenant_id/username pair) exists, has an email on file,
// or is already verified. Every branch below - "no such user", "user has no
// email", "already verified", "email genuinely just got queued" - produces
// the exact same generic response. The only place this differs is redeeming
// an already-issued token (reset-password/verify-email), where the caller
// necessarily already has something only a real recipient could have gotten
// from their inbox, so an "invalid or expired" error there leaks nothing new.

const express = require("express");
const db = require("../storage");
const tenancy = require("../tenancy");
const { requireAuth, DASHBOARD_ROLES } = require("../auth");
const {
  createUser,
  verifyLogin,
  createSession,
  destroySession,
  resetPassword,
  requestPasswordReset,
  resetPasswordWithToken,
  requestEmailVerification,
  verifyEmailToken,
} = require("../users");
const {
  createTenantUser,
  verifyTenantLogin,
  createTenantSession,
  destroyTenantSession,
  resetTenantPassword,
  requestTenantPasswordReset,
  resetTenantPasswordWithToken,
  requestTenantEmailVerification,
  verifyTenantEmailToken,
} = require("../tenantUsers");
const { logAudit } = require("../audit");
const { loginRateLimit, resetLoginAttempts, forgotPasswordRateLimit, tokenRedeemRateLimit } = require("../loginRateLimit");
const { sendPasswordResetEmail, sendVerificationEmail } = require("../accountEmail");
const logger = require("../logger");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Same generic wording every branch responds with - see file header.
const GENERIC_EMAIL_QUEUED_MESSAGE = "If an account matching that request exists, an email has been sent.";

function isValidEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

// A best-effort send - a transient SMTP failure must not surface as a
// user-facing error (least of all one that would leak whether the send was
// even attempted). Logged so an operator can see delivery problems without
// the caller ever being able to distinguish "sent" from "SMTP is down" from
// their side.
async function sendBestEffort(sendFn, ...args) {
  try {
    await sendFn(...args);
  } catch (err) {
    logger.error("Account email failed to send", { error: err.message });
  }
}

if (tenancy.MULTI_TENANT) {
  // ---- Multi-tenant dashboard accounts ----

  // Creating a dashboard user requires an already-authenticated tenant
  // admin (API key or existing session, either works via requireAuth) -
  // there is no anonymous bootstrap path here. A brand-new tenant's FIRST
  // dashboard user is created by routes/tenants.js at signup time instead.
  router.post("/register", requireAuth("manage_keys"), async (req, res) => {
    const { username, password, role = "viewer", email } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    if (email !== undefined && email !== null && !isValidEmail(email)) {
      return res.status(400).json({ error: "email is not a valid email address" });
    }
    // "agent" is deliberately excluded from DASHBOARD_ROLES - it's a
    // machine-scoped api_keys.role value, not something a human dashboard
    // account should ever hold (see auth.js's DASHBOARD_ROLES comment).
    if (!DASHBOARD_ROLES.includes(role)) {
      return res.status(400).json({ error: `invalid role - must be one of: ${DASHBOARD_ROLES.join(", ")}` });
    }
    try {
      const { verifyToken } = await createTenantUser({
        tenant_id: req.tenantId,
        username,
        password,
        role,
        email: email || null,
        db: req.controlPlaneDb,
      });
      await logAudit(req.apiKey.key_id, "user.create", username, { role, email: email || null }, req.db);
      if (verifyToken) await sendBestEffort(sendVerificationEmail, email, verifyToken);
      res.status(201).json({ ok: true, username, role, email: email || null });
    } catch (err) {
      res.status(400).json({ error: /unique/i.test(err.message) ? "username already exists for this tenant" : err.message });
    }
  });

  router.post("/login", loginRateLimit, async (req, res) => {
    const { tenant_id, username, password } = req.body || {};
    if (!tenant_id || !username || !password) {
      return res.status(400).json({ error: "tenant_id, username, and password are required" });
    }
    const { controlPlaneDb } = tenancy.initControlPlane();
    const tenantRow = await tenancy.getTenantStatus(tenant_id);
    const denialReason = tenancy.tenantAccessDenialReason(tenantRow);
    if (denialReason) {
      return res.status(403).json({ error: denialReason });
    }
    const user = await verifyTenantLogin({ tenant_id, username, password, db: controlPlaneDb });
    if (!user) {
      return res.status(401).json({ error: "Invalid tenant_id, username, or password" });
    }
    resetLoginAttempts(req);
    const token = createTenantSession(user, tenantRow.schema_name);
    res.json({ token, username: user.username, role: user.role, tenant_id: user.tenant_id });
  });

  router.post("/logout", (req, res) => {
    const token = req.header("X-Session-Token");
    if (token) destroyTenantSession(token);
    res.json({ ok: true });
  });

  // Admin-only, scoped to the admin's own tenant: reset a dashboard user's
  // password. requireAuth already resolved req.tenantId, so an admin in
  // tenant A can never reach a username that happens to exist in tenant B.
  router.post("/users/:username/reset-password", requireAuth("manage_keys"), async (req, res) => {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "newPassword is required and must be at least 8 characters" });
    }
    try {
      await resetTenantPassword({ tenant_id: req.tenantId, username: req.params.username, newPassword, db: req.controlPlaneDb });
      await logAudit(req.apiKey.key_id, "user.password_reset", req.params.username, {}, req.db);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ---- Self-service password reset (multi-tenant) ----

  router.post("/forgot-password", forgotPasswordRateLimit, async (req, res) => {
    const { tenant_id, username } = req.body || {};
    if (!tenant_id || !username) {
      return res.status(400).json({ error: "tenant_id and username are required" });
    }
    const { controlPlaneDb } = tenancy.initControlPlane();
    const tenantRow = await tenancy.getTenantStatus(tenant_id);
    // A denied/unknown tenant still gets the generic response, same
    // enumeration-safety reasoning as an unknown username - the caller
    // learns nothing about whether tenant_id itself is valid.
    if (!tenancy.tenantAccessDenialReason(tenantRow)) {
      const result = await requestTenantPasswordReset({ tenant_id, username, db: controlPlaneDb });
      if (result) {
        await sendBestEffort(sendPasswordResetEmail, result.email, result.token);
        try {
          const tenantDb = await tenancy.getTenantDb(tenantRow.schema_name);
          await logAudit(username, "user.password_reset_requested", username, {}, tenantDb);
        } catch (err) {
          logger.error("Failed to write password-reset-requested audit entry", { error: err.message });
        }
      }
    }
    res.json({ ok: true, message: GENERIC_EMAIL_QUEUED_MESSAGE });
  });

  router.post("/reset-password", tokenRedeemRateLimit, async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ error: "token and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "newPassword must be at least 8 characters" });
    }
    const { controlPlaneDb } = tenancy.initControlPlane();
    try {
      const { tenant_id, username } = await resetTenantPasswordWithToken({ token, newPassword, db: controlPlaneDb });
      try {
        const tenantRow = await tenancy.getTenantStatus(tenant_id);
        const tenantDb = await tenancy.getTenantDb(tenantRow.schema_name);
        await logAudit(username, "user.password_reset_completed", username, {}, tenantDb);
      } catch (err) {
        logger.error("Failed to write password-reset-completed audit entry", { error: err.message });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/resend-verification", forgotPasswordRateLimit, async (req, res) => {
    const { tenant_id, username } = req.body || {};
    if (!tenant_id || !username) {
      return res.status(400).json({ error: "tenant_id and username are required" });
    }
    const { controlPlaneDb } = tenancy.initControlPlane();
    const tenantRow = await tenancy.getTenantStatus(tenant_id);
    if (!tenancy.tenantAccessDenialReason(tenantRow)) {
      const result = await requestTenantEmailVerification({ tenant_id, username, db: controlPlaneDb });
      if (result) await sendBestEffort(sendVerificationEmail, result.email, result.token);
    }
    res.json({ ok: true, message: GENERIC_EMAIL_QUEUED_MESSAGE });
  });

  router.post("/verify-email", tokenRedeemRateLimit, async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token is required" });
    const { controlPlaneDb } = tenancy.initControlPlane();
    try {
      const { tenant_id, username } = await verifyTenantEmailToken({ token, db: controlPlaneDb });
      try {
        const tenantRow = await tenancy.getTenantStatus(tenant_id);
        const tenantDb = await tenancy.getTenantDb(tenantRow.schema_name);
        await logAudit(username, "user.email_verified", username, {}, tenantDb);
      } catch (err) {
        logger.error("Failed to write email-verified audit entry", { error: err.message });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
} else {
  // ---- Single-tenant dashboard accounts ----

  // Bootstrap: first user can self-register as admin if NO users AND no API keys
  // exist yet. After that, only an admin can create more users.
  router.post("/register", async (req, res) => {
    const { username, password, role = "viewer", email } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    if (email !== undefined && email !== null && !isValidEmail(email)) {
      return res.status(400).json({ error: "email is not a valid email address" });
    }
    // "agent" is deliberately excluded from DASHBOARD_ROLES - it's a
    // machine-scoped api_keys.role value, not something a human dashboard
    // account should ever hold (see auth.js's DASHBOARD_ROLES comment).
    if (!DASHBOARD_ROLES.includes(role)) {
      return res.status(400).json({ error: `invalid role - must be one of: ${DASHBOARD_ROLES.join(", ")}` });
    }

    const anyUsers = await db.get("SELECT COUNT(*) AS n FROM users");
    const anyKeys = await db.get("SELECT COUNT(*) AS n FROM api_keys");
    const isBootstrap = anyUsers.n === 0 && anyKeys.n === 0;

    if (!isBootstrap) {
      // Not the very first account - require an authenticated admin to create users
      return requireAuth("manage_keys")(req, res, async () => {
        try {
          const { verifyToken } = await createUser({ username, password, role, email: email || null });
          await logAudit(req.apiKey.key_id, "user.create", username, { role, email: email || null });
          if (verifyToken) await sendBestEffort(sendVerificationEmail, email, verifyToken);
          res.status(201).json({ ok: true, username, role, email: email || null });
        } catch (err) {
          res.status(400).json({ error: /unique/i.test(err.message) ? "username already exists" : err.message });
        }
      });
    }

    try {
      const { verifyToken } = await createUser({ username, password, role: "admin", email: email || null }); // bootstrap user is always admin
      await logAudit(username, "user.create", username, { role: "admin", email: email || null, note: "bootstrap" });
      if (verifyToken) await sendBestEffort(sendVerificationEmail, email, verifyToken);
      res.status(201).json({ ok: true, username, role: "admin", email: email || null, note: "bootstrap admin account created" });
    } catch (err) {
      res.status(400).json({ error: /unique/i.test(err.message) ? "username already exists" : err.message });
    }
  });

  router.post("/login", loginRateLimit, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    const user = await verifyLogin(username, password);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    resetLoginAttempts(req);
    const token = createSession(user);
    res.json({ token, username: user.username, role: user.role });
  });

  router.post("/logout", (req, res) => {
    const token = req.header("X-Session-Token");
    if (token) destroySession(token);
    res.json({ ok: true });
  });

  // Admin-only: reset another user's password.
  router.post("/users/:username/reset-password", requireAuth("manage_keys"), async (req, res) => {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "newPassword is required and must be at least 8 characters" });
    }
    try {
      await resetPassword(req.params.username, newPassword);
      await logAudit(req.apiKey.key_id, "user.password_reset", req.params.username, {});
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ---- Self-service password reset (single-tenant) ----

  // Always the same generic response whether or not `username` exists or
  // has an email - see file header. Rate-limited by IP (not by username -
  // that would itself be an enumeration/DoS vector) since this is reachable
  // with zero credentials, same as login.
  router.post("/forgot-password", forgotPasswordRateLimit, async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: "username is required" });
    const result = await requestPasswordReset(username);
    if (result) {
      await sendBestEffort(sendPasswordResetEmail, result.email, result.token);
      await logAudit(username, "user.password_reset_requested", username, {});
    }
    res.json({ ok: true, message: GENERIC_EMAIL_QUEUED_MESSAGE });
  });

  // The actual redemption of the emailed link. No enumeration concern here
  // (see file header) - "invalid or expired" is an honest, specific error.
  router.post("/reset-password", tokenRedeemRateLimit, async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ error: "token and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "newPassword must be at least 8 characters" });
    }
    try {
      const username = await resetPasswordWithToken(token, newPassword);
      await logAudit(username, "user.password_reset_completed", username, {});
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/resend-verification", forgotPasswordRateLimit, async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: "username is required" });
    const result = await requestEmailVerification(username);
    if (result) await sendBestEffort(sendVerificationEmail, result.email, result.token);
    res.json({ ok: true, message: GENERIC_EMAIL_QUEUED_MESSAGE });
  });

  router.post("/verify-email", tokenRedeemRateLimit, async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token is required" });
    try {
      const username = await verifyEmailToken(token);
      await logAudit(username, "user.email_verified", username, {});
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

module.exports = router;
