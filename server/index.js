// server/index.js - entrypoint. Run with: npm start

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

require("./db"); // ensures schema exists on boot

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
const dataRoute = require("./routes/data");
const { checkBudgetAlerts, checkBurnRate } = require("./alerts");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Static dashboard (plain HTML/JS, no build step)
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
app.use("/api/data", dataRoute);

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`FinOps platform running at http://localhost:${PORT}`);
  console.log(`Dashboard:    http://localhost:${PORT}`);
});

// Background alert checks every 5 minutes (progressive budget alerts + burn rate)
setInterval(() => {
  checkBudgetAlerts().catch((e) => console.error("Budget alert check failed:", e.message));
  checkBurnRate().catch((e) => console.error("Burn-rate check failed:", e.message));
}, 5 * 60 * 1000);