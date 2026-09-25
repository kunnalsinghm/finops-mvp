// routes/auth.js - human user registration + login (session-based).
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

const express = require("express");
const db = require("../storage");
const tenancy = require("../tenancy");
const { requireAuth, DASHBOARD_ROLES } = require("../auth");
const { createUser, verifyLogin, createSession, destroySession, resetPassword } = require("../users");
const {
  createTenantUser,
  verifyTenantLogin,
  createTenantSession,
  destroyTenantSession,
  resetTenantPassword,
} = require("../tenantUsers");
const { logAudit } = require("../audit");
const { loginRateLimit, resetLoginAttempts } = require("../loginRateLimit");

const router = express.Router();

if (tenancy.MULTI_TENANT) {
  // ---- Multi-tenant dashboard accounts ----

  // Creating a dashboard user requires an already-authenticated tenant
  // admin (API key or existing session, either works via requireAuth) -
  // there is no anonymous bootstrap path here. A brand-new tenant's FIRST
  // dashboard user is created by routes/tenants.js at signup time instead.
  router.post("/register", requireAuth("manage_keys"), async (req, res) => {
    const { username, password, role = "viewer" } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    // "agent" is deliberately excluded from DASHBOARD_ROLES - it's a
    // machine-scoped api_keys.role value, not something a human dashboard
    // account should ever hold (see auth.js's DASHBOARD_ROLES comment).
    if (!DASHBOARD_ROLES.includes(role)) {
      return res.status(400).json({ error: `invalid role - must be one of: ${DASHBOARD_ROLES.join(", ")}` });
    }
    try {
      await createTenantUser({ tenant_id: req.tenantId, username, password, role, db: req.controlPlaneDb });
      await logAudit(req.apiKey.key_id, "user.create", username, { role }, req.db);
      res.status(201).json({ ok: true, username, role });
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
} else {
  // ---- Single-tenant dashboard accounts (unchanged) ----

  // Bootstrap: first user can self-register as admin if NO users AND no API keys
  // exist yet. After that, only an admin can create more users.
  router.post("/register", async (req, res) => {
    const { username, password, role = "viewer" } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
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
          await createUser({ username, password, role });
          await logAudit(req.apiKey.key_id, "user.create", username, { role });
          res.status(201).json({ ok: true, username, role });
        } catch (err) {
          res.status(400).json({ error: /unique/i.test(err.message) ? "username already exists" : err.message });
        }
      });
    }

    try {
      await createUser({ username, password, role: "admin" }); // bootstrap user is always admin
      await logAudit(username, "user.create", username, { role: "admin", note: "bootstrap" });
      res.status(201).json({ ok: true, username, role: "admin", note: "bootstrap admin account created" });
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
}

module.exports = router;
