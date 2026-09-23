// routes/tenants.js - the signup endpoint. Deliberately unauthenticated
// (a brand-new customer has no API key yet by definition) and only
// meaningful when FINOPS_MULTI_TENANT=true - single-tenant self-hosted
// installs use bootstrap mode instead (see auth.js), which is the right
// onboarding story for "I just deployed this myself," not "I'm signing up
// for someone else's hosted instance."
//
// This is intentionally a THIN wrapper around tenancy.createTenant +
// createTenantApiKey - all the actual provisioning logic (schema creation,
// key generation, control-plane bookkeeping) lives in tenancy.js and is
// already covered by test/tenancy.test.js and
// test/multiTenantIsolation.test.js. This file's only job is exposing it
// safely over HTTP: input validation, rate limiting, and returning the
// admin key exactly once.

const express = require("express");
const tenancy = require("../tenancy");
const { createTenantUser } = require("../tenantUsers");
const logger = require("../logger");

const router = express.Router();

// Signup abuse (someone scripting thousands of fake tenants) is a
// resource-exhaustion concern - each tenant provisions a real Postgres
// schema - not just a spam concern. A coarse global rate limit, not a
// per-IP one: this endpoint has no concept of "caller identity" yet
// (that's the whole point of it), so per-IP limiting would just mean
// running it from a botnet defeats it trivially. A global cap means a
// burst gets throttled regardless of source; a legitimate high-signup-
// volume launch day should raise FINOPS_SIGNUP_RATE_LIMIT accordingly,
// not work around this some other way.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.FINOPS_SIGNUP_RATE_LIMIT) || 10;
let windowStart = Date.now();
let windowCount = 0;

function checkGlobalSignupRateLimit() {
  const now = Date.now();
  if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount <= RATE_LIMIT_MAX;
}

const NAME_MAX_LENGTH = 200;

router.post("/", async (req, res) => {
  if (!tenancy.MULTI_TENANT) {
    return res.status(404).json({
      error: "Tenant signup is only available when this server is running in multi-tenant mode (FINOPS_MULTI_TENANT=true). For a self-hosted single-tenant install, just start the server - bootstrap mode handles first-time setup.",
    });
  }

  if (!checkGlobalSignupRateLimit()) {
    return res.status(429).json({ error: "Too many signups right now - please try again in a minute." });
  }

  const { name, admin_label, admin_username, admin_password, trial_days } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "'name' (organization/tenant name) is required" });
  }
  if (name.length > NAME_MAX_LENGTH) {
    return res.status(400).json({ error: `'name' must be ${NAME_MAX_LENGTH} characters or fewer` });
  }
  // Dashboard login is opt-in at signup: give both or neither. A customer
  // that only wants an API key (e.g. scripting straight against the proxy)
  // shouldn't be forced to also pick a dashboard password.
  if ((admin_username && !admin_password) || (admin_password && !admin_username)) {
    return res.status(400).json({ error: "admin_username and admin_password must be provided together" });
  }
  if (admin_password && admin_password.length < 8) {
    return res.status(400).json({ error: "admin_password must be at least 8 characters" });
  }
  const trialDays = trial_days != null ? Number(trial_days) : null;
  if (trialDays != null && (!Number.isInteger(trialDays) || trialDays <= 0)) {
    return res.status(400).json({ error: "trial_days must be a positive integer" });
  }

  try {
    const tenant = await tenancy.createTenant({ name: name.trim(), trial_days: trialDays });
    const key = await tenancy.createTenantApiKey({
      tenant_id: tenant.id,
      label: admin_label && typeof admin_label === "string" ? admin_label.trim().slice(0, NAME_MAX_LENGTH) : "First admin key",
      role: "admin",
    });

    let dashboardUsername = null;
    if (admin_username && admin_password) {
      const { controlPlaneDb } = tenancy.initControlPlane();
      await createTenantUser({
        tenant_id: tenant.id,
        username: String(admin_username).trim().slice(0, NAME_MAX_LENGTH),
        password: admin_password,
        role: "admin",
        db: controlPlaneDb,
      });
      dashboardUsername = String(admin_username).trim().slice(0, NAME_MAX_LENGTH);
    }

    logger.info("New tenant provisioned via signup", { tenantId: tenant.id, name: tenant.name, trial: Boolean(trialDays), dashboardUser: Boolean(dashboardUsername) });

    // key_id is shown here exactly once - the same "treat it like a
    // password" convention as routes/keys.js's POST /. There is no
    // recovery endpoint that reveals it again; losing it means creating a
    // new key through some OTHER already-authenticated flow isn't
    // possible for a tenant that just lost its only key, which is exactly
    // why this response (and whatever UI calls it) should make clear this
    // is the one and only time this value is shown.
    res.status(201).json({
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status, trial_ends_at: tenant.trial_ends_at },
      api_key: key.key_id,
      role: key.role,
      dashboard_login: dashboardUsername ? { username: dashboardUsername, note: "Log in at POST /api/auth/login with this tenant_id, username, and the password you chose." } : null,
      warning: "Save this API key now - it will not be shown again.",
    });
  } catch (err) {
    logger.error("Tenant signup failed", { error: err.message });
    res.status(500).json({ error: "Signup failed - please try again. If this persists, contact support." });
  }
});

module.exports = router;
