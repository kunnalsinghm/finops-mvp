// tenantJobs.js - runs the periodic checks (budget alerts, burn-rate,
// commitment alerts, weekly briefing) ONCE PER ACTIVE TENANT in multi-tenant
// mode, instead of once against a single global database.
//
// Before this file existed, index.js's setInterval called
// checkBudgetAlerts()/checkBurnRate()/checkCommitmentAlerts()/
// checkWeeklyBriefing() with no arguments, so they always ran against
// storage/index.js's single global db - the SAME db object regardless of
// how many tenants existed. In multi-tenant mode that db is essentially a
// leftover single-tenant fallback: not any real tenant's schema, just
// whatever FINOPS_DB_DRIVER points at by default. Every tenant except
// whichever one happened to be reachable through that fallback got NO
// budget alerts, NO burn-rate warnings, NO commitment alerts, and NO weekly
// briefings, ever - not broken exactly, just silently inert.
//
// The fix is exactly the shape tenancy.js's isolation model was designed
// for: get the list of active tenants from the control plane, get each
// one's own req.db-equivalent, and run the SAME per-tenant-safe functions
// (already converted to accept a `db` param - see alerts.js, commitments.js,
// weeklyBriefing.js) against each one in turn.

const logger = require("./logger");
const tenancy = require("./tenancy");
const { checkBudgetAlerts, checkBurnRate } = require("./alerts");
const { checkCommitmentAlerts } = require("./commitments");
const { checkWeeklyBriefing } = require("./weeklyBriefing");

// One tenant's check throwing (a transient connection blip, a schema not
// finished provisioning yet, whatever) must never stop every OTHER
// tenant's checks from running - that would turn one unlucky tenant into
// an outage for the whole fleet's alerting. Each tenant's whole set of
// checks is isolated in its own try/catch, logged and skipped, not
// propagated.
async function runChecksForOneTenant(tenant) {
  let db;
  try {
    db = await tenancy.getTenantDb(tenant.schema_name);
  } catch (err) {
    logger.error("Could not open tenant db for periodic checks - skipping this tenant this cycle", {
      tenantId: tenant.id,
      schema: tenant.schema_name,
      error: err.message,
    });
    return;
  }

  const checks = [
    ["Budget alert check", () => checkBudgetAlerts(db)],
    ["Burn-rate check", () => checkBurnRate(db)],
    ["Commitment alert check", () => checkCommitmentAlerts(db)],
    ["Weekly briefing check", () => checkWeeklyBriefing(db)],
  ];
  for (const [label, run] of checks) {
    try {
      await run();
    } catch (err) {
      logger.error(`${label} failed for tenant`, { tenantId: tenant.id, schema: tenant.schema_name, error: err.message });
    }
  }
}

// Called on the same periodic timer index.js already runs (see
// index.js's setInterval) - iterates every tenant tenancy.listActiveTenants()
// considers active ('active' or a not-yet-expired 'trial'; see tenancy.js's
// tenantAccessDenialReason for the exact classification) and runs each
// tenant's checks one at a time. Sequential rather than
// Promise.all(tenants.map(...)) on purpose: each tenant's checks already
// open/use that tenant's own small (max 3) connection pool, and running
// every active tenant's checks fully in parallel on every tick would mean
// briefly holding open connections across every tenant pool at once - fine
// for a handful of tenants, an unnecessary spike for a larger fleet. This
// is the same "modest number of paying customers" tradeoff tenancy.js's own
// header comment already made explicit for pool sizing.
async function runPeriodicChecksForAllTenants() {
  const tenants = await tenancy.listActiveTenants();
  for (const tenant of tenants) {
    await runChecksForOneTenant(tenant);
  }
  return { tenantsChecked: tenants.length };
}

module.exports = { runPeriodicChecksForAllTenants, runChecksForOneTenant };
