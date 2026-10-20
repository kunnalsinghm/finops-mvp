// server/index.js - entrypoint. Run with: npm start (or npm run serve for auto-restart)

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const storage = require("./storage");
const logger = require("./logger");
const scheduler = require("./scheduler");
const jobLock = require("./jobLock");

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
const invitesRoute = require("./routes/invites");
const { mountApi } = require("./apiMounts");
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

const app = express();

// FINOPS_TRUST_PROXY (RFC 0001 A2): opt-in "trust proxy" so per-IP rate limits
// see the real client behind a load balancer. Unset = unchanged. An invalid
// value refuses to start rather than silently trusting every client header.
// See trustProxy.js.
const { applyTrustProxy } = require("./trustProxy");
try {
  const trusted = applyTrustProxy(app, process.env.FINOPS_TRUST_PROXY);
  if (trusted !== undefined) logger.info(`FINOPS_TRUST_PROXY=${JSON.stringify(trusted)}: trusting X-Forwarded-For from that proxy setting`);
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
}

// Drain support (see shutdown.js): once SIGTERM arrives, every response says
// "Connection: close" so keep-alive clients reconnect elsewhere.
const shutdown = require("./shutdown");
app.use((req, res, next) => {
  if (shutdown.isShuttingDown()) res.set("Connection", "close");
  next();
});
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
for (const { path: guarded } of NOT_TENANT_AWARE) mountApi(app, guarded, blockInMultiTenant());

// The API description. Unauthenticated on purpose: it documents the public surface
// and contains no tenant data. Versioned path only - it describes /api/v1.
app.get("/api/v1/openapi.json", (req, res) => res.json(require("./openapi")));

mountApi(app, "/api/ingest", ingestRoute);
mountApi(app, "/api/costs", costsRoute);
mountApi(app, "/api/budgets", budgetsRoute);
mountApi(app, "/api/pricing", pricingRoute);
mountApi(app, "/api/keys", keysRoute);
mountApi(app, "/api/alerts", alertsRoute);
mountApi(app, "/api/recommendations", recommendationsRoute);
mountApi(app, "/api/proxy", proxyRoute);
mountApi(app, "/api/gitops", gitopsRoute);
mountApi(app, "/api/auth", authRoute);
mountApi(app, "/api/invites", invitesRoute);
mountApi(app, "/api/sso", ssoRoute);
mountApi(app, "/api/reconcile", reconcileRoute);
mountApi(app, "/api/audit", auditRoute);
mountApi(app, "/api/cache", cacheRoute);
mountApi(app, "/api/semantic-cache", semanticCacheRoute);
mountApi(app, "/api/data", dataRoute);
mountApi(app, "/api/backup", backupRoute);
mountApi(app, "/api/shadow-test", shadowTestRoute);
mountApi(app, "/api/model-allowlist", modelAllowlistRoute);
mountApi(app, "/api/tool-call-denylist", toolCallDenylistRoute);
mountApi(app, "/api/token-quotas", tokenQuotaRoute);
mountApi(app, "/api/commitments", commitmentsRoute);
mountApi(app, "/api/reports", reportsRoute);
mountApi(app, "/api/billing", billingRoute);
mountApi(app, "/api/agents", agentsRoute);
mountApi(app, "/api/tags", tagsRoute);
mountApi(app, "/api/region-allowlist", regionAllowlistRoute);
mountApi(app, "/api/tool-calls", toolCallsRoute);
mountApi(app, "/api/gpu-usage", gpuUsageRoute);
mountApi(app, "/api/query", queryRoute);
// Tenant signup - deliberately unauthenticated (a new customer has no key yet) and a 404
// unless FINOPS_MULTI_TENANT=true. See routes/tenants.js.
mountApi(app, "/api/tenants", tenantsRoute);
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

  const server = app.listen(PORT, HOST, () => {
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
  installShutdown(server);
}

// Graceful shutdown: stop accepting, let in-flight requests finish and be
// metered, close the database, then exit. See shutdown.js and RFC 0001.
function installShutdown(server) {
  const graceMs = shutdown.parseGraceMs(process.env.FINOPS_SHUTDOWN_GRACE_MS);
  const handle = shutdown.createShutdown({
    server,
    graceMs,
    log: logger,
    closers: [
      // Let a running periodic job finish before the database closes, and make sure its
      // advisory lock is released (see jobLock.js). Bounded, so a stuck job cannot hold
      // the process past the orchestrator's kill timeout.
      async () => {
        await jobLock.drain({ timeoutMs: Math.max(1000, Math.floor(graceMs / 2)) });
      },
      async () => {
        if (tenancy.MULTI_TENANT) await tenancy.closeAll();
      },
      async () => {
        if (storage.dialect === "postgres") await storage.pool.end();
        else storage.raw.close();
      },
    ],
    exit: (code) => process.exit(code),
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => handle.begin(sig));
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

// Periodic jobs. What each tick does, and which instance does it, lives in scheduler.js: every
// tick goes through a per-job Postgres advisory lock, so with several instances a job runs on ONE
// of them per tick instead of once per instance (see jobLock.js).
setInterval(() => {
  scheduler.runPeriodicChecks().catch((e) => logger.error("Periodic check run failed", { error: e.message }));
}, 5 * 60 * 1000);

// A10: automatic backups every 6 hours. Which implementation runs (SQLite file copy, or Postgres
// dump, single-tenant only) and the once-per-tick lock live in scheduler.js runBackupTick.
function scheduleBackup() {
  scheduler.runBackupTick().catch((e) => logger.error("Backup tick failed", { error: e.message }));
}
scheduleBackup();
setInterval(scheduleBackup, 6 * 60 * 60 * 1000);
