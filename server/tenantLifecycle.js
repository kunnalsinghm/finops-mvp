// tenantLifecycle.js - suspend / reactivate / offboard / export / purge a
// tenant, plus the periodic sweeps that make trial-expiry and offboarding
// actually happen without a human clicking a button at the exact right
// moment. Before this file existed there was no tenant lifecycle at all: no
// suspend, no soft-delete/offboarding flow, no data-export-then-purge on
// churn, no trial-expired gating - a tenant that stopped paying, or asked to
// leave, or whose trial ran out, just... kept existing exactly as before,
// forever, with no path to actually wind it down.
//
// Every mutation here goes through the control-plane `tenants` row - the
// SAME row auth.js's tenantAccessDenialReason (see tenancy.js) already
// reads on every request, so a status change here takes effect on the very
// next request a tenant makes, not after some separate cache/flag catches
// up.

const logger = require("./logger");
const tenancy = require("./tenancy");
const { clearTenantGovernanceState } = require("./governance");
const { destroyAllSessionsForTenant } = require("./tenantUsers");

const VALID_STATUSES = ["active", "trial", "trial_expired", "suspended", "offboarding", "deleted"];
const DEFAULT_OFFBOARDING_GRACE_DAYS = 14;

async function requireTenant(tenantId) {
  const tenant = await tenancy.getTenantStatus(tenantId);
  if (!tenant) {
    const err = new Error(`No tenant with id ${tenantId}`);
    err.statusCode = 404;
    throw err;
  }
  return tenant;
}

// Cuts a tenant off immediately - the DB write is what actually blocks
// future requests (tenantAccessDenialReason checks status on every
// request), but a dashboard session or a rate-limit bucket that's already
// live doesn't know that yet on its own. clearTenantGovernanceState +
// destroyAllSessionsForTenant make the cutoff immediate rather than "next
// time that in-memory state happens to expire" - up to a 24h dashboard
// session TTL otherwise.
async function suspendTenant(tenantId, reason = null) {
  await requireTenant(tenantId);
  const { controlPlaneDb } = tenancy.initControlPlane();
  await controlPlaneDb.run("UPDATE tenants SET status = 'suspended', suspended_reason = ? WHERE id = ?", [
    reason,
    tenantId,
  ]);
  clearTenantGovernanceState(tenantId);
  destroyAllSessionsForTenant(tenantId);
  logger.warn("Tenant suspended", { tenantId, reason });
  return requireTenant(tenantId);
}

// Reactivating always lands on 'active', even for a tenant that was
// suspended mid-trial - a suspension is an operator action taken FOR a
// reason (see suspended_reason), and lifting it is a deliberate operator
// decision too, not something that should silently hand a half-used trial
// clock back. An operator who actually wants to resume a trial can still
// call setTenantLimits/extendTrial-style updates directly against the row;
// this function's job is just "let this tenant back in."
async function reactivateTenant(tenantId) {
  const tenant = await requireTenant(tenantId);
  if (tenant.status === "deleted") {
    const err = new Error("A deleted (purged) tenant cannot be reactivated - its data no longer exists");
    err.statusCode = 409;
    throw err;
  }
  const { controlPlaneDb } = tenancy.initControlPlane();
  await controlPlaneDb.run("UPDATE tenants SET status = 'active', suspended_reason = NULL, purge_after = NULL WHERE id = ?", [tenantId]);
  logger.info("Tenant reactivated", { tenantId });
  return requireTenant(tenantId);
}

// Soft-delete: marks the tenant for deletion and starts a grace period
// (default 14 days) during which the tenant is blocked (same as
// 'suspended') but its data is still fully intact and exportable -
// runOffboardingSweep only hard-deletes once purge_after has passed. This
// is the "give the customer a window to change their mind / finish an
// export" step; purgeTenant is the irreversible one.
async function requestOffboarding(tenantId, { graceDays = DEFAULT_OFFBOARDING_GRACE_DAYS } = {}) {
  await requireTenant(tenantId);
  const purgeAfter = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString();
  const { controlPlaneDb } = tenancy.initControlPlane();
  await controlPlaneDb.run("UPDATE tenants SET status = 'offboarding', purge_after = ? WHERE id = ?", [purgeAfter, tenantId]);
  clearTenantGovernanceState(tenantId);
  destroyAllSessionsForTenant(tenantId);
  logger.warn("Tenant offboarding requested", { tenantId, purgeAfter });
  return requireTenant(tenantId);
}

// Reverses requestOffboarding, as long as the grace period hasn't already
// been swept - once runOffboardingSweep has actually purged the schema
// there is nothing left to cancel back into.
async function cancelOffboarding(tenantId) {
  const tenant = await requireTenant(tenantId);
  if (tenant.status !== "offboarding") {
    const err = new Error(`Tenant is not currently offboarding (status is '${tenant.status}')`);
    err.statusCode = 409;
    throw err;
  }
  return reactivateTenant(tenantId);
}

// Dumps every row of every table in the tenant's own schema as plain JSON -
// the thing a departing customer (or an operator honoring a data-export
// request before a purge) actually needs: everything, in one file, in a
// format that doesn't require this product to read it back. Intentionally
// simple (no pagination, no streaming) - see the P2 backlog item on this
// same tradeoff for Postgres backups; fine for the schema sizes a single
// tenant accumulates, not meant for a multi-GB export.
async function exportTenantData(tenantId) {
  const tenant = await requireTenant(tenantId);
  const db = await tenancy.getTenantDb(tenant.schema_name);
  const { TENANT_TABLES } = require("./storage/schema.tenant");

  const data = {};
  for (const table of TENANT_TABLES) {
    data[table] = await db.all(`SELECT * FROM ${table}`);
  }

  return {
    exported_at: new Date().toISOString(),
    tenant: { id: tenant.id, name: tenant.name, status: tenant.status },
    tables: data,
  };
}

// IRREVERSIBLE: drops the tenant's entire Postgres schema (all its data,
// gone) and closes its connection pool. The control-plane `tenants` row
// itself is kept, not deleted - status flips to 'deleted' and deleted_at is
// stamped, purely so an operator can still see THAT a tenant named "Acme
// Corp" existed and was purged on some date (audit trail, billing history
// reconciliation, "why did our tenant count drop"), without being able to
// recover so much as a single row of its actual data. api_keys/users rows
// for this tenant are deleted outright (not just orphaned) since they're
// credentials, not business data worth retaining post-purge.
async function purgeTenant(tenantId) {
  const tenant = await requireTenant(tenantId);
  if (tenant.status === "deleted") {
    return tenant; // already purged - idempotent, not an error
  }

  const { controlPlaneDb, controlPlanePool } = tenancy.initControlPlane();
  await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${tenant.schema_name} CASCADE`);
  await tenancy.closeTenantPool(tenant.schema_name);
  await controlPlaneDb.run("DELETE FROM api_keys WHERE tenant_id = ?", [tenantId]);
  await controlPlaneDb.run("DELETE FROM users WHERE tenant_id = ?", [tenantId]);
  await controlPlaneDb.run("UPDATE tenants SET status = 'deleted', deleted_at = ? WHERE id = ?", [new Date().toISOString(), tenantId]);
  destroyAllSessionsForTenant(tenantId);
  clearTenantGovernanceState(tenantId);

  logger.warn("Tenant purged - schema dropped, all data permanently deleted", { tenantId, schema: tenant.schema_name });
  return requireTenant(tenantId);
}

// Called on the same periodic timer as everything else in tenantJobs.js
// (see index.js's setInterval) - two independent sweeps in one pass:
//  1. Any 'trial' tenant whose trial_ends_at has passed flips to
//     'trial_expired'. This is the bulk/eventual-consistency counterpart to
//     tenancy.js's markTrialExpiredIfObserved, which only fires reactively
//     on that ONE trial tenant's next request - a trial tenant that simply
//     stops calling the API around when its trial ends would otherwise
//     never have its status updated at all.
//  2. Any 'offboarding' tenant whose purge_after has passed is hard-deleted
//     via purgeTenant. Each tenant's purge is isolated in its own
//     try/catch, same "one tenant's failure can't take down the sweep for
//     everyone else" reasoning as tenantJobs.js's per-tenant checks.
async function runLifecycleSweep() {
  const { controlPlaneDb } = tenancy.initControlPlane();
  const nowIso = new Date().toISOString();

  const expiredTrials = await controlPlaneDb.run(
    "UPDATE tenants SET status = 'trial_expired' WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?",
    [nowIso]
  );

  const dueForPurge = await controlPlaneDb.all(
    "SELECT id FROM tenants WHERE status = 'offboarding' AND purge_after IS NOT NULL AND purge_after < ?",
    [nowIso]
  );
  let purged = 0;
  for (const row of dueForPurge) {
    try {
      await purgeTenant(row.id);
      purged++;
    } catch (err) {
      logger.error("Scheduled tenant purge failed - will retry next sweep", { tenantId: row.id, error: err.message });
    }
  }

  return { trialsExpired: expiredTrials.changes || 0, tenantsPurged: purged };
}

async function setTenantLimits(tenantId, { max_api_keys, max_budgets, max_monthly_events } = {}) {
  await requireTenant(tenantId);
  const sets = [];
  const params = [];
  if (max_api_keys != null) { sets.push("max_api_keys = ?"); params.push(max_api_keys); }
  if (max_budgets != null) { sets.push("max_budgets = ?"); params.push(max_budgets); }
  if (max_monthly_events != null) { sets.push("max_monthly_events = ?"); params.push(max_monthly_events); }
  if (sets.length === 0) {
    const err = new Error("Provide at least one of max_api_keys, max_budgets, max_monthly_events");
    err.statusCode = 400;
    throw err;
  }
  const { controlPlaneDb } = tenancy.initControlPlane();
  await controlPlaneDb.run(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`, [...params, tenantId]);
  logger.info("Tenant limits updated", { tenantId, max_api_keys, max_budgets, max_monthly_events });
  return requireTenant(tenantId);
}

module.exports = {
  VALID_STATUSES,
  suspendTenant,
  reactivateTenant,
  requestOffboarding,
  cancelOffboarding,
  exportTenantData,
  purgeTenant,
  runLifecycleSweep,
  setTenantLimits,
};
