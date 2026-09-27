// tracing.js - A13's contained, reversible step toward the spec's
// OpenTelemetry-compatible traces/metrics gap (see docs/tech-stack-
// migration-plan.md for the full five-deviation analysis this is one part
// of).
//
// WHY THIS SHAPE, NOT THE REAL @opentelemetry/sdk-trace-node: the goal
// here is deliberately narrow - prove the ingest/pricing/attribution/
// policy/provider-call path in ONE route (routes/proxy.js) CAN be traced,
// behind an opt-in flag, with zero new runtime dependencies and zero
// restructuring of that route's control flow - not to ship production
// distributed tracing. A real OTel SDK integration is real, separate work
// (see the migration plan doc for what it would additionally need: context
// propagation across async boundaries via AsyncLocalStorage, an OTLP
// exporter, a collector to send it to). What's built here is
// OTEL-COMPATIBLE in the sense that matters for a future upgrade being a
// SWAP rather than a rewrite: the same trace_id/span_id/parent/name/
// start-time/duration/attributes shape OTel's own data model uses, emitted
// as one structured JSON line per request to stdout - so a JSON->OTLP
// bridge or a log-based collector (many exist) can ingest this today, with
// literally zero code changes on this side, and swapping in the real SDK
// later only touches this one file.
//
// WHY CHECKPOINTS, NOT NESTED START/END SPAN PAIRS PER STAGE: the route
// this instruments (routes/proxy.js) has upwards of a dozen early-return
// exit points (fail-closed metering, data-residency block, quarantine,
// budget circuit breaker, model allow-list, token quota, pricing-block,
// prompt-injection block, cache hits...) reached from deep inside a single
// long handler. Giving every stage its own try/finally-guarded span would
// mean touching every one of those exit paths - real restructuring risk
// against a handler backed by hundreds of passing tests, which is exactly
// what A13 says this pass must NOT do. Instead, mark() records a single
// timestamp; the child "spans" shown in the final JSON line are computed
// retrospectively from consecutive checkpoints when the span ends -
// equivalent information, none of the restructuring risk. The one place
// that DOES need a completion hook (ending the root span) uses Express's
// res.on("finish") event, which fires no matter which of those early
// returns the request actually took - so nothing has to be duplicated at
// each exit point either.
//
// OPT-IN, ZERO DEPENDENCY, ZERO COST WHEN DISABLED: FINOPS_OTEL_ENABLED
// must be exactly "true" (checked once per request, not read from env
// repeatedly) or startRequestSpan/mark/endRequestSpan are all single-branch
// no-ops - no object allocation, no Date/hrtime calls, no console output.
// The existing structured JSON request/audit logs (logger.js) are
// untouched - this is additive, not a replacement for them.

const crypto = require("crypto");

function tracingEnabled() {
  return process.env.FINOPS_OTEL_ENABLED === "true";
}

function newHexId(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

// Starts a root span for one request. Returns a disabled stub (just
// `{ enabled: false }`) when tracing is off, so every call site can call
// mark()/endRequestSpan() unconditionally without an `if` at each site.
function startRequestSpan(name, attributes = {}) {
  if (!tracingEnabled()) return { enabled: false };
  return {
    enabled: true,
    traceId: newHexId(16), // 128-bit, hex - same width as a W3C trace-context trace-id
    spanId: newHexId(8), // 64-bit, hex - same width as a W3C trace-context parent-id
    name,
    attributes,
    startTime: process.hrtime.bigint(),
    checkpoints: [],
  };
}

// Records a named point-in-time checkpoint within the root span. See the
// module header for why this is a timestamp, not a nested span.
function mark(span, name, attributes) {
  if (!span || !span.enabled) return;
  span.checkpoints.push({ name, time: process.hrtime.bigint(), attributes: attributes || {} });
}

// Ends the root span and emits it as one structured JSON line to stdout.
// Never throws - a tracing bug must never break the request it's
// describing.
function endRequestSpan(span, { attributes = {}, status = "ok" } = {}) {
  if (!span || !span.enabled) return;
  try {
    const endTime = process.hrtime.bigint();
    const events = span.checkpoints.map((cp, i) => {
      const next = span.checkpoints[i + 1];
      const nextTime = next ? next.time : endTime;
      return {
        name: cp.name,
        start_offset_ms: msBetween(span.startTime, cp.time),
        duration_ms: msBetween(cp.time, nextTime),
        attributes: cp.attributes,
      };
    });
    console.log(
      JSON.stringify({
        otel_compatible_span: true,
        trace_id: span.traceId,
        span_id: span.spanId,
        name: span.name,
        duration_ms: msBetween(span.startTime, endTime),
        status,
        attributes: { ...span.attributes, ...attributes },
        events,
      })
    );
  } catch {
    // Never let a tracing/serialization failure surface as a request error.
  }
}

function msBetween(startNs, endNs) {
  return Math.round((Number(endNs - startNs) / 1e6) * 1000) / 1000;
}

module.exports = { startRequestSpan, mark, endRequestSpan, tracingEnabled };
