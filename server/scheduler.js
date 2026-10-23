// scheduler.js - what each periodic tick does, and which instance does it.
//
// index.js owns the timers; this owns the work, so it can be tested without a server.
// Every tick goes through jobLock.runExclusive(), so with several instances on Postgres
// a job runs on one of them per tick (see jobLock.js). The lock names are the contract:
//   periodic-checks          single-tenant: budget, burn-rate, commitment, weekly briefing
//   tenant-periodic-checks   multi-tenant: the same four, once per active tenant
//   tenant-lifecycle-sweep   multi-tenant: trial expiry + offboarding purge
//   backup                   Postgres single-tenant backup
// The tenant checks and the lifecycle sweep are independent jobs with separate locks.
//
// Dependencies are injectable (opts) for tests; the defaults are the real modules.

const jobLock = require("./jobLock");
const logger = require("./logger");

async function runPeriodicChecks(opts = {}) {
  const shutdown = require("./shutdown");
  const isShuttingDown = opts.isShuttingDown || shutdown.isShuttingDown;
  if (isShuttingDown()) return { ran: false, reason: "shutting-down" }; // draining: do not start new work

  const multiTenant = opts.multiTenant !== undefined ? opts.multiTenant : require("./tenancy").MULTI_TENANT;

  if (multiTenant) {
    // The same four checks once PER TENANT (see tenantJobs.js for why that matters), and
    // the trial-expiry + offboarding-purge sweep (see tenantLifecycle.js's runLifecycleSweep
    // for why it can't rely on the reactive per-request check alone).
    const tenantJobs = opts.tenantJobs || require("./tenantJobs");
    const lifecycle = opts.tenantLifecycle || require("./tenantLifecycle");
    const guard = (label) => (e) => {
      logger.error(label, { error: e.message });
      return { ran: false, reason: "error" };
    };
    const results = await Promise.all([
      jobLock.runExclusive("tenant-periodic-checks", () => tenantJobs.runPeriodicChecksForAllTenants())
        .catch(guard("Per-tenant periodic check run failed")),
      jobLock.runExclusive("tenant-lifecycle-sweep", () => lifecycle.runLifecycleSweep())
        .catch(guard("Tenant lifecycle sweep failed")),
    ]);
    return { ran: results.some((r) => r.ran), results };
  }

  const checks = opts.checks || {
    ...require("./alerts"),
    ...require("./commitments"),
    ...require("./weeklyBriefing"),
  };
  // One failing check must not stop the others, so each is guarded on its own.
  return jobLock.runExclusive("periodic-checks", () =>
    Promise.all([
      checks.checkBudgetAlerts().catch((e) => logger.error("Budget alert check failed", { error: e.message })),
      checks.checkBurnRate().catch((e) => logger.error("Burn-rate check failed", { error: e.message })),
      checks.checkCommitmentAlerts().catch((e) => logger.error("Commitment alert check failed", { error: e.message })),
      checks.checkWeeklyBriefing().catch((e) => logger.error("Weekly briefing check failed", { error: e.message })),
    ])
  );
}

// A10: dispatches to whichever backup implementation matches FINOPS_DB_DRIVER. Postgres
// auto-scheduling is deliberately restricted to single-tenant mode - a whole-database
// restore would roll back every tenant at once (see backupPostgres.js and
// docs/backup-restore-runbook.md). Multi-tenant deployments run `npm run backup` manually.
async function runBackupTick(opts = {}) {
  const driver = opts.driver || process.env.FINOPS_DB_DRIVER;
  const multiTenant = opts.multiTenant !== undefined ? opts.multiTenant : require("./tenancy").MULTI_TENANT;
  const isShuttingDown = opts.isShuttingDown || require("./shutdown").isShuttingDown;
  if (isShuttingDown()) return { ran: false, reason: "shutting-down" };

  if (driver === "postgres") {
    if (multiTenant) {
      logger.warn(
        "Automatic Postgres backup scheduling is scoped to single-tenant mode for now (a whole-database restore would roll back every tenant at once) - run `npm run backup` manually, or your own pg_dump/provider-snapshot schedule, for multi-tenant deployments. See docs/backup-restore-runbook.md."
      );
      return { ran: false, reason: "multi-tenant" };
    }
    const pgBackup = opts.pgBackup || require("./backupPostgres");
    // One dump per tick across instances, not one per instance.
    return jobLock.runExclusive("backup", () => pgBackup.runBackup()).catch((e) => {
      logger.error("Postgres backup failed", { error: e.message });
      return { ran: false, reason: "error" };
    });
  }
  const sqliteBackup = opts.sqliteBackup || require("./backup").runBackup;
  await sqliteBackup();
  return { ran: true };
}

module.exports = { runPeriodicChecks, runBackupTick };
