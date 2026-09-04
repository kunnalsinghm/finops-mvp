// server/index.js - entrypoint. Run with: npm start (or npm run serve for auto-restart)

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

require("./db");
const logger = require("./logger");
const { runBackup } = require("./backup");

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
const { checkBudgetAlerts, checkBurnRate } = require("./alerts");

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
app.use(express.json({ limit: "2mb" }));

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/vendor/chart.js", express.static(path.join(__dirname, "..", "node_modules", "chart.js", "dist")));

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

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: String(reason) });
});

setInterval(() => {
  checkBudgetAlerts().catch((e) => logger.error("Budget alert check failed", { error: e.message }));
  checkBurnRate().catch((e) => logger.error("Burn-rate check failed", { error: e.message }));
}, 5 * 60 * 1000);

runBackup();
setInterval(() => {
  runBackup();
}, 6 * 60 * 60 * 1000);
