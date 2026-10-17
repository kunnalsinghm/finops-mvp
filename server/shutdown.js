// shutdown.js - graceful shutdown on SIGTERM/SIGINT.
//
// WHY: the proxy calls the provider first and meters after. Killing the
// process between the two loses billed spend without even reaching the
// metering spool (verified: SIGTERM during an in-flight provider call gave
// the client ECONNRESET and recorded 0 usage rows). Scale-downs and rolling
// deploys send SIGTERM, so this is the normal way instances stop, not an edge.
//
// WHAT HAPPENS on begin():
//   1. shutting-down flag set -> /health/ready answers 503, responses carry
//      "Connection: close", periodic jobs stop starting new work.
//   2. the listener closes (no new connections); idle keep-alive sockets are
//      dropped.
//   3. wait for in-flight requests to finish, up to graceMs
//      (FINOPS_SHUTDOWN_GRACE_MS, default 25s: under the common 30s
//      orchestrator kill timeout).
//   4. past graceMs, remaining connections are cut and the exit is non-zero.
//   5. closers run (database handles), each guarded so one failure cannot
//      block the rest, then exit(0) - or exit(1) if the grace period expired.
//
// Idempotent: a second signal while draining changes nothing. A request that
// is itself stuck forever cannot hold the process past graceMs.
//
// NOT covered: SIGKILL / power loss / OOM kill (nothing can be: that is what
// the metering spool is for), and Windows, where SIGTERM terminates the
// process without running JS.

let shuttingDown = false;

const DEFAULT_GRACE_MS = 25000;

function isShuttingDown() {
  return shuttingDown;
}

// Invalid, zero or negative values fall back to the default rather than
// disabling the grace period (0 would drop in-flight requests immediately).
function parseGraceMs(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GRACE_MS;
}

function createShutdown({ server, graceMs = DEFAULT_GRACE_MS, closers = [], log = console, exit = process.exit }) {
  let started = false;

  async function begin(signal) {
    if (started) return;
    started = true;
    shuttingDown = true;
    const info = (m, meta) => (log.info || log.log).call(log, m, meta);
    info(`${signal} received: draining (grace ${graceMs}ms)`, { signal, graceMs });

    let forced = false;
    const drained = new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    });
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        forced = true;
        resolve();
      }, graceMs);
    });
    await Promise.race([drained, expired]);
    clearTimeout(timer);

    if (forced) {
      (log.warn || log.log).call(log, "Grace period expired: cutting remaining connections", { graceMs });
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    }

    for (const close of closers) {
      try {
        await close();
      } catch (e) {
        (log.error || log.log).call(log, "Shutdown step failed", { error: e && e.message });
      }
    }
    info("Shutdown complete", { forced });
    exit(forced ? 1 : 0);
  }

  return { begin };
}

module.exports = { createShutdown, isShuttingDown, parseGraceMs, DEFAULT_GRACE_MS };
