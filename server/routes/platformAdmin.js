// routes/platformAdmin.js - the OPERATOR side of tenant lifecycle: suspend,
// reactivate, offboard, export, purge, adjust quotas, list every tenant
// regardless of status. This is not a tenant-facing route (no tenant's
// own API key or dashboard session can reach it) - it's for the people
// running the hosted platform itself.
//
// There is no real cross-tenant admin IDENTITY system in this codebase yet
// (that's a bigger piece of work - a platform-admin console with its own
// accounts, roles, and audit trail is explicitly listed as a SaaS-
// operational gap, not something this file tries to solve). What this file
// DOES provide is a safe, deliberately coarse stopgap: every route requires
// a single shared secret (FINOPS_PLATFORM_ADMIN_TOKEN) in the
// X-Platform-Admin-Token header, matched with a constant-time comparison.
// That's the same "coarse but safe now, not a false sense of granularity"
// tradeoff tenants.js's own signup rate limiting already makes elsewhere in
// this codebase - one shared secret an operator's deploy tooling holds, not
// a login system, is honest about what it actually is.
//
// If FINOPS_PLATFORM_ADMIN_TOKEN is not set, every route here 404s - same
// "don't even reveal this surface exists" reasoning as tenants.js's own
// "signup route 404s outside multi-tenant mode" behavior, so a scanner
// probing an instance that hasn't opted into platform-admin tooling learns
// nothing from hitting these paths.

const express = require("express");
const crypto = require("crypto");
const tenancy = require("../tenancy");
const tenantLifecycle = require("../tenantLifecycle");
const logger = require("../logger");

const router = express.Router();

function timingSafeTokenMatch(candidate, expected) {
  const a = Buffer.from(String(candidate || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!tenancy.MULTI_TENANT) {
    return res.status(404).json({ error: "Not found" });
  }
  const configuredToken = process.env.FINOPS_PLATFORM_ADMIN_TOKEN;
  if (!configuredToken) {
    return res.status(404).json({ error: "Not found" });
  }
  const suppliedToken = req.header("X-Platform-Admin-Token");
  if (!suppliedToken || !timingSafeTokenMatch(suppliedToken, configuredToken)) {
    return res.status(401).json({ error: "Missing or invalid X-Platform-Admin-Token" });
  }
  next();
});

function handleLifecycleError(err, res) {
  const status = err.statusCode || 500;
  if (status === 500) logger.error("Platform-admin lifecycle action failed", { error: err.message });
  res.status(status).json({ error: err.message });
}

router.get("/tenants", async (req, res) => {
  res.json(await tenancy.listAllTenants());
});

router.get("/tenants/:id", async (req, res) => {
  const tenant = await tenancy.getTenantStatus(req.params.id);
  if (!tenant) return res.status(404).json({ error: `No tenant with id ${req.params.id}` });
  res.json(tenant);
});

router.post("/tenants/:id/suspend", async (req, res) => {
  try {
    const tenant = await tenantLifecycle.suspendTenant(req.params.id, req.body?.reason || null);
    res.json(tenant);
  } catch (err) {
    handleLifecycleError(err, res);
  }
});

router.post("/tenants/:id/reactivate", async (req, res) => {
  try {
    const tenant = await tenantLifecycle.reactivateTenant(req.params.id);
    res.json(tenant);
  } catch (err) {
    handleLifecycleError(err, res);
  }
});

router.post("/tenants/:id/offboard", async (req, res) => {
  try {
    const graceDays = req.body?.graceDays != null ? Number(req.body.graceDays) : undefined;
    if (graceDays != null && (!Number.isInteger(graceDays) || graceDays <= 0)) {
      return res.status(400).json({ error: "graceDays must be a positive integer" });
    }
    const tenant = await tenantLifecycle.requestOffboarding(req.params.id, graceDays != null ? { graceDays } : undefined);
    res.json(tenant);
  } catch (err) {
    handleLifecycleError(err, res);
  }
});

router.post("/tenants/:id/cancel-offboard", async (req, res) => {
  try {
    const tenant = await tenantLifecycle.cancelOffboarding(req.params.id);
    res.json(tenant);
  } catch (err) {
    handleLifecycleError(err, res);
  }
});

router.get("/tenants/:id/export", async (req, res) => {
  try {
    res.json(await tenantLifecycle.exportTenantData(req.params.id));
  } catch (err) {
    handleLifecycleError(err, res);
  }
});

// Irreversible - requires the caller to echo back { "confirm": "PURGE" } so
// this can never be triggered by, say, a retried request with an empty
// body, or a copy-pasted curl command missing its payload.
router.post("/tenants/:id/purge", async (req, res) => {
  if (req.body?.confirm !== "PURGE") {
    return res.status(400).json({ error: 'This is irreversible. Resend with a JSON body of { "confirm": "PURGE" } to proceed.' });
  }
  try {
    const tenant = await tenantLifecycle.purgeTenant(req.params.id);
    res.json(tenant);
  } catch (err) {
    handleLifecycleError(err, res);
  }
});

router.patch("/tenants/:id/limits", async (req, res) => {
  try {
    const tenant = await tenantLifecycle.setTenantLimits(req.params.id, req.body || {});
    res.json(tenant);
  } catch (err) {
    handleLifecycleError(err, res);
  }
});

// Manual trigger for the periodic trial-expiry/offboarding-purge sweep -
// useful for an operator who just changed a tenant's trial_ends_at or
// purge_after and doesn't want to wait for the next timer tick to see it
// take effect.
router.post("/lifecycle-sweep/run-now", async (req, res) => {
  res.json(await tenantLifecycle.runLifecycleSweep());
});

// Manual trigger for the per-tenant budget/burn-rate/commitment/briefing
// checks (see tenantJobs.js) - same "don't make an operator wait for the
// next timer tick" convenience as the sweep above.
router.post("/jobs/run-now", async (req, res) => {
  res.json(await require("../tenantJobs").runPeriodicChecksForAllTenants());
});

module.exports = router;
