// server/index.js - entrypoint. Run with: npm start (or npm run serve for auto-restart)

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const storage = require("./storage");
const logger = require("./logger");
const { runBackup } = require("./backup");
const pgBackup = require("./backupPostgres");

const ingestRoute = require("./routes/ingest");
const costsRoute = require("./routes/costs");
const budgetsRoute = require("./routes/budgets");
const pricingRoute = require("./routes/pricing");
const keysRoute = require("./routes/keys");
const alertsRoute = require("./routes/alerts");
const recommendationsRoute = require("./routes/recommendations");
const proxyRoute = require("./routes/proxy");
const { router: gitopsRoute } = require("./routes/gitops");
const authRoute = require("./routes/auth");
const ssoRoute = require("./routes/sso");
const reconcileRoute = require("./routes/reconcile");
const auditRoute = require("./routes/audit");
const cacheRoute = require("./routes/cache");
const semanticCacheRoute = require("./routes/semanticCache");
const dataRoute = require("./routes/data");
const backupRoute = require("./routes/backup");
const shadowTestRoute = require("./routes/shadowTest");
const modelAllowlistRoute = require("./routes/modelAllowlist");
const toolCallDenylistRoute = require("./routes/toolCallDenylist");
const tokenQuotaRoute = require("./routes/tokenQuota");
const commitmentsRoute = require("./routes/commitments");
const reportsRoute = require("./routes/reports");
const billingRoute = require("./routes/billing");
const { stripeWebhookHandler } = require("./routes/billingWebhook");
const agentsRoute = require("./routes/agents");
const tagsRoute = require("./routes/tags");
const regionAllowlistRoute = require("./routes/regionAllowlist");
const toolCallsRoute = require("./routes/toolCalls");
const gpuUsageRoute = require("./routes/gpuUsage");
const queryRoute = require("./routes/query");
const tenantsRoute = require("./routes/tenants");
const platformAdminRoute = require("./routes/platformAdmin");
const healthRoute = require("./routes/health");
const { NOT_TENANT_AWARE, blockInMultiTenant } = require("./tenantGuard");
const tenancy = require("./tenancy");
const { checkBudgetAlerts, checkBurnRate } = require("./alerts");
const { checkCommitmentAlerts } = require("./commitments");
const { checkWeeklyBriefing } = require("./weeklyBriefing");

const app = express();
const PORT = process.env.PORT || 4000;

// Bind to localhost only by default. Without an explicit host, Node's
// app.listen(PORT, ...) binds 0.0.0.0 (every network interface) - combined
// with auth-bootstrap mode (full admin access until the first API key/user
// exists), that means anyone reachable on your LAN/tunnel gets free admin
// access on a fresh install. Set FINOPS_HOST=0.0.0.0 to explicitly opt in
// to wider exposure once you understand the risk.
const HOST = process.env.FINOPS_HOST || "127.0.0.1";

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(cors());

// MUST be registered before app.use(express.json()) below - the Stripe
// webhook needs the raw request body for signature verification. See
// routes/billingWebhook.js for the full reasoning. Every other route in
// this app is fine going through the global JSON parser that follows.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

app.use(express.json({ limit: "2mb" }));

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/vendor/chart.js", express.static(path.join(__dirname, "..", "node_modules", "chart.js", "dist")));

// Deliberately unauthenticated and before any /api mount - this is a
// liveness probe for Docker's HEALTHCHECK / a load balancer / an uptime
// monitor, not an application endpoint. It reports process liveness only,
// not "the database is reachable" - a DB-touching health check belongs
// behind auth (or with its own separate care around what it leaks to an
// unauthenticated caller), which is a deliberate scope line, not an
// oversight.
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime_seconds: Math.round(process.uptime()) });
});

// A11: real readiness (GET /health/ready) - queries the database and
// returns 503 with a specific reason if it can't, unlike the liveness
// check above. See routes/health.js's header for the endpoint-shape
// reasoning and why this is deliberately separate from /health.
app.use("/health", healthRoute);

// Route groups not yet converted to per-tenant databases are switched off in multi-tenant
// mode (501) instead of silently serving the default schema. See tenantGuard.js.
for (const { path: guarded } of NOT_TENANT_AWARE) app.use(guarded, blockInMultiTenant());

app.use("/api/ingest", ingestRoute);
app.use("/api/costs", costsRoute);
app.use("/api/budgets", budgetsRoute);
app.use("/api/pricing", pricingRoute);
app.use("/api/keys", keysRoute);
app.use("/api/alerts", alertsRoute);
app.use("/api/recommendations", recommendationsRoute);
app.use("/api/proxy", proxyRoute);
app.use("/api/gitops", gitopsRoute);
app.use("/api/auth", authRoute);
app.use("/api/sso", ssoRoute);
app.use("/api/reconcile", reconcileRoute);
app.use("/api/audit", auditRoute);
app.use("/api/cache", cacheRoute);
app.use("/api/semantic-cache", semanticCacheRoute);
app.use("/api/data", dataRoute);
app.use("/api/backup", backupRoute);
app.use("/api/shadow-test", shadowTestRoute);
app.use("/api/model-allowlist", modelAllowlistRoute);
app.use("/api/tool-call-denylist", toolCallDenylistRoute);
app.use("/api/token-quotas", tokenQuotaRoute);
app.use("/api/commitments", commitmentsRoute);
app.use("/api/reports", reportsRoute);
app.use("/api/billing", billingRoute);
app.use("/api/agents", agentsRoute);
app.use("/api/tags", tagsRoute);
app.use("/api/region-allowlist", regionAllowlistRoute);
app.use("/api/tool-calls", toolCallsRoute);
app.use("/api/gpu-usage", gpuUsageRoute);
app.use("/api/query", queryRoute);
// Tenant signup - deliberately unauthenticated (a new customer has no key yet) and a 404
// unless FINOPS_MULTI_TENANT=true. See routes/tenants.js.
app.use("/api/tenants", tenantsRoute);
// Operator/ops surface for tenant lifecycle - gated by its own shared
// secret (FINOPS_PLATFORM_ADMIN_TOKEN), not a tenant API key or session.
// See routes/platformAdmin.js's header for the full reasoning.
app.use("/api/platform", platformAdminRoute);

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// storage.ready is a no-op resolved Promise on SQLite (schema init there is
// synchronous, at require time), but genuinely async on Postgres (schema
// creation is a real network round-trip via pool.query()). Awaiting it here
// closes the exact race the earlier migration work flagged: without this,
// the server could start accepting requests before the Postgres schema
// finished being created, and the first request(s) would hit tables that
// don't exist yet.
async function start() {
  await storage.ready;

  app.listen(PORT, HOST, () => {
    logger.info(`FinOps platform running at http://${HOST}:${PORT}`);
    console.log(`Dashboard:    http://${HOST}:${PORT}`);
    if (HOST === "0.0.0.0") {
      logger.warn(
        "FINOPS_HOST=0.0.0.0 - this server is reachable from other devices on your network (LAN, port-forward, tunnel), not just this machine."
      );
      console.warn(
        "[WARN] Server bound to 0.0.0.0 - reachable beyond localhost. Unset FINOPS_HOST (or set it to 127.0.0.1) to restrict access to this machine only."
      );
    }
  });
}

start().catch((err) => {
  logger.error("Failed to start server", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: String(reason) });
});

setInterval(() => {
  if (tenancy.MULTI_TENANT) {
    // Runs the same four checks once PER TENANT instead of once against a
    // single global database - see tenantJobs.js's header comment for why
    // that distinction matters. A tenant-iteration failure (e.g. the
    // control-plane connection is briefly down) is caught inside
    // tenantJobs.js per-tenant already; this outer catch only guards
    // against listActiveTenants() itself failing.
    require("./tenantJobs")
      .runPeriodicChecksForAllTenants()
      .catch((e) => logger.error("Per-tenant periodic check run failed", { error: e.message }));
    // Trial-expiry + offboarding-purge sweep - see tenantLifecycle.js's
    // runLifecycleSweep header comment for why this can't just rely on the
    // reactive per-request check in auth.js alone.
    require("./tenantLifecycle")
      .runLifecycleSweep()
      .catch((e) => logger.error("Tenant lifecycle sweep failed", { error: e.message }));
  } else {
    checkBudgetAlerts().catch((e) => logger.error("Budget alert check failed", { error: e.message }));
    checkBurnRate().catch((e) => logger.error("Burn-rate check failed", { error: e.message }));
    checkCommitmentAlerts().catch((e) => logger.error("Commitment alert check failed", { error: e.message }));
    checkWeeklyBriefing().catch((e) => logger.error("Weekly briefing check failed", { error: e.message }));
  }
}, 5 * 60 * 1000);

// A10: dispatches to whichever backup implementation matches
// FINOPS_DB_DRIVER, so an operator doesn't need to know which backend is
// active to get automatic periodic backups. Postgres auto-scheduling is
// deliberately restricted to single-tenant mode for now - see
// backupPostgres.js's header for why a whole-database restore isn't safe
// to run unattended against a database serving multiple live tenants yet.
// A multi-tenant deployment can still run `npm run backup` manually (it
// works mechanically, since every tenant lives in the same database), it
// just isn't done automatically on a timer until per-tenant-schema restore
// exists.
function scheduleBackup() {
  if (process.env.FINOPS_DB_DRIVER === "postgres") {
    if (tenancy.MULTI_TENANT) {
      logger.warn(
        "Automatic Postgres backup scheduling is scoped to single-tenant mode for now (a whole-database restore would roll back every tenant at once) - run `npm run backup` manually, or your own pg_dump/provider-snapshot schedule, for multi-tenant deployments. See docs/backup-restore-runbook.md."
      );
      return;
    }
    pgBackup.runBackup().catch((e) => logger.error("Postgres backup failed", { error: e.message }));
  } else {
    runBackup();
  }
}
scheduleBackup();
setInterval(scheduleBackup, 6 * 60 * 60 * 1000);
