// dbHealth.js - the DB-layer half of A11 (real readiness, not just liveness).
//
// Distinct from FINOPS_UPSTREAM_TIMEOUT_MS (routes/proxy.js), which bounds
// how long a hung LLM PROVIDER call can hold a request. This module is
// about the DATABASE this process itself depends on - a completely
// different dependency with a completely different failure mode (a
// provider timing out doesn't mean our own storage is unreachable, and
// vice versa), so it gets its own timeout/breaker rather than reusing that
// one.
//
// NOT per-tenant state (a deliberate exception to the "partition in-memory
// state by tenantId" convention used elsewhere - see governance.js/cache.js):
// this tracks the health of ONE thing - the control-plane pool in
// multi-tenant mode, or the single global pool in single-tenant mode - not
// a per-tenant credential or resource. There is exactly one of these per
// process, by construction, so there is nothing to partition.
//
// THE SMALLEST THING THAT'S HONESTLY BETTER THAN NOTHING (per A10/A11's own
// scoping): a plain consecutive-failure counter that trips a short-lived
// "circuit open" state after FAILURE_THRESHOLD straight failures. While
// open, checkDbHealth() fails FAST (no new connection attempt) instead of
// making every single readiness probe (which infra may call every few
// seconds) wait out its own connection attempt against a database that is
// currently down - a real, if modest, reduction in load on a struggling or
// unreachable database. This is NOT a full resilience framework (no
// half-open request budgeting, no per-endpoint breakers) - just the
// smallest thing that changes behavior for the worse case this repo
// actually has today (a single shared DB dependency).

const logger = require("./logger");

const FAILURE_THRESHOLD = Number(process.env.FINOPS_DB_CIRCUIT_FAILURE_THRESHOLD) || 3;
const OPEN_MS = Number(process.env.FINOPS_DB_CIRCUIT_OPEN_MS) || 30000;
const CHECK_TIMEOUT_MS = Number(process.env.FINOPS_DB_HEALTH_TIMEOUT_MS) || 2000;

let consecutiveFailures = 0;
let openUntil = 0; // 0 = closed (normal); a future timestamp = open (failing fast until then)

function circuitState() {
  const now = Date.now();
  if (openUntil > now) return "open";
  if (openUntil !== 0) return "half-open"; // open window just elapsed - next check is a trial
  return "closed";
}

function recordSuccess() {
  consecutiveFailures = 0;
  openUntil = 0;
}

function recordFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    const opening = openUntil === 0 || openUntil <= Date.now();
    openUntil = Date.now() + OPEN_MS;
    if (opening) {
      logger.warn("DB readiness circuit breaker OPEN - failing fast on readiness checks for a cooldown period", {
        consecutiveFailures,
        cooldownMs: OPEN_MS,
      });
    }
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DB health check timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs a trivial connectivity probe (`SELECT 1`-equivalent, provided by the
// caller since the control-plane pool and the single-tenant storage module
// have different call shapes) through the timeout + circuit breaker. Never
// throws - always resolves to a result object the readiness route can turn
// directly into a response.
async function checkDbHealth(probe, { label = "db" } = {}) {
  const state = circuitState();
  if (state === "open") {
    return { ok: false, label, reason: "circuit open - too many recent DB failures, failing fast", circuit: state };
  }
  try {
    await withTimeout(probe(), CHECK_TIMEOUT_MS);
    recordSuccess();
    return { ok: true, label, circuit: "closed" };
  } catch (err) {
    recordFailure();
    return { ok: false, label, reason: err.message, circuit: circuitState() };
  }
}

// Exposed for tests (and for the readiness route to include pool stats,
// where applicable) - not meant to be mutated by anything other than
// recordSuccess/recordFailure above and _resetForTests below.
function getCircuitBreakerStatus() {
  return { state: circuitState(), consecutiveFailures, failureThreshold: FAILURE_THRESHOLD, openMs: OPEN_MS };
}

function _resetForTests() {
  consecutiveFailures = 0;
  openUntil = 0;
}

module.exports = { checkDbHealth, getCircuitBreakerStatus, _resetForTests };
