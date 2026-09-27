// routes/health.js - A11: real READINESS, distinct from the existing
// liveness-only GET /health and GET /api/health (both stay exactly as they
// are: "the process is up", unconditionally 200, no dependency checks -
// that's what a container HEALTHCHECK / process supervisor wants, since
// killing and restarting a process whose DATABASE is merely slow doesn't
// fix anything and just adds a restart storm on top of a DB outage).
//
// ENDPOINT CHOICE: a sibling path (GET /health/ready) rather than a query
// param on the existing /api/health. Reasons: (1) it matches the
// liveness/readiness naming convention most infra already expects
// (Kubernetes' own liveness/readinessProbe split uses separate paths, not
// one path with a mode flag); (2) a query param is one more thing a Docker
// HEALTHCHECK/load-balancer config has to get right, for no benefit; (3)
// keeping it under /health rather than /api/health keeps this in the same
// "infra probe, not an application API call" bucket as the existing
// unauthenticated /health, rather than looking like a first-class REST
// resource under /api.
//
// Deliberately unauthenticated, same reasoning as GET /health: infra
// (load balancers, Docker, uptime monitors) calling this frequently
// shouldn't need a credential, and what it reveals (DB reachable: yes/no,
// a timing reason if not, aggregate connection-pool counts) is ops
// telemetry, not tenant data - no usage/billing/customer information is
// ever in this response.

const express = require("express");
const storage = require("../storage");
const tenancy = require("../tenancy");
const { checkDbHealth } = require("../dbHealth");

const router = express.Router();

router.get("/ready", async (req, res) => {
  const checks = {};
  let dbResult;

  if (tenancy.MULTI_TENANT) {
    // Multi-tenant mode: check the CONTROL-PLANE pool, not any one
    // tenant's schema - there is no bounded, cheap way to check every
    // tenant's pool on every probe (could be hundreds), and the
    // control-plane pool is the one dependency every single request in
    // this mode needs regardless of which tenant it belongs to (see
    // auth.js: every request resolves its tenant via the control plane
    // first). A tenant-specific outage (that tenant's own schema/pool
    // having a problem) is a real gap this readiness check does not catch
    // - documented, not silently implied to be covered.
    const { controlPlaneDb, controlPlaneReady } = tenancy.initControlPlane();
    dbResult = await checkDbHealth(
      async () => {
        await controlPlaneReady;
        await controlPlaneDb.get("SELECT 1 AS ok");
      },
      { label: "controlPlaneDb" }
    );
  } else {
    dbResult = await checkDbHealth(
      async () => {
        await storage.ready;
        await storage.get("SELECT 1 AS ok");
      },
      { label: "db" }
    );
  }

  checks[dbResult.label] = dbResult.ok ? "ok" : { ok: false, reason: dbResult.reason, circuit: dbResult.circuit };

  // Connection-pool stats, Postgres only - node-postgres's Pool exposes
  // these natively (no query needed); node:sqlite's DatabaseSync has no
  // pool concept at all, so this section is simply omitted on SQLite
  // rather than reporting a meaningless always-1 number.
  const pgPool = tenancy.MULTI_TENANT
    ? tenancy.initControlPlane().controlPlanePool
    : storage.dialect === "postgres"
      ? storage.pool
      : null;
  if (pgPool) {
    const total = pgPool.totalCount || 0;
    const idle = pgPool.idleCount || 0;
    const waiting = pgPool.waitingCount || 0;
    // "Exhausted": every connection is checked out AND at least one
    // request is already queued for one - the concrete signal that a
    // request arriving right now will have to wait, not a prediction.
    // Informational only (doesn't flip `ok` to false on its own) - a
    // brief queue under a load spike is normal and recovers on its own;
    // this is here so it shows up BEFORE it becomes a user-visible
    // timeout, not to make a transient queue look like an outage.
    checks.dbPool = { total, idle, waiting, exhausted: total > 0 && idle === 0 && waiting > 0 };
  }

  res.status(dbResult.ok ? 200 : 503).json({ ok: dbResult.ok, time: new Date().toISOString(), checks });
});

module.exports = router;
