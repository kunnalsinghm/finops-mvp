# RFC 0002 — Real OpenTelemetry exporter and collector

- **Status:** proposal, not started. **Verdict: ready for a small, flag-off-by-default slice (Phase 1). The
  collector and backend are a deployment decision, not code, and are not ready.**
- **Scope:** P2 item 2.
- **Baseline:** `main` at `3adbea3`. `server/tracing.js` (118 lines) emits one JSON line per proxied request
  to stdout when `FINOPS_OTEL_ENABLED=true`. It is called only from `routes/proxy.js`.
- **Reads first:** `server/tracing.js` header, `docs/tech-stack-migration-plan.md` §4.

## 1. What exists and what is missing

Today: a root span per proxy request with checkpoints (computed into child "events" at the end), random
128/64-bit hex ids, `hrtime` durations. Nothing reads it unless an operator scrapes stdout.

Missing for "real OpenTelemetry":

1. **Export.** Nothing sends spans in OTLP, so no collector or backend can receive them directly.
2. **Wall-clock timestamps.** The module records only `process.hrtime`, which is monotonic and has no
   epoch. OTLP needs `startTimeUnixNano`/`endTimeUnixNano`. Fix: capture one `(Date.now(), hrtime)` anchor
   per span at start and derive absolute times from it.
3. **Context propagation.** An inbound W3C `traceparent` header is ignored, so a caller's trace is never
   continued, and the outbound provider call carries no `traceparent`.
4. **Resource identity.** No `service.name`, `service.version`, or deployment environment.
5. **Spans beyond one route.** Only the proxy is traced; the rest of the API and the background jobs are not.
6. **Metrics.** Nothing is emitted. This RFC does not cover metrics (see "Out of scope").

## 2. Options

| Option | Dependencies | Effort | For | Against |
|---|---|---|---|---|
| **A. Real OTel Node SDK** (`sdk-trace-node` + `exporter-trace-otlp-http` + resources) | Measured in a scratch project: **14 packages, ~30 MB, 0 known vulnerabilities** (sdk-trace-node 2.12.0, exporter 0.223.0). | 3–4 days | Standard; batching, retry, resource detection, context propagation and auto-instrumentation available. | The checkpoint design does not map onto nested spans without restructuring `routes/proxy.js`'s dozen-plus early returns (the reason `tracing.js` is built the way it is). A new runtime dependency tree to keep patched. |
| **B. Zero-dependency OTLP/HTTP JSON exporter on the existing checkpoint design** | None (Node `http`/`https`). | 2–3 days | Keeps the "no restructuring" property; flag-off cost stays zero; one file changes. | We own batching, retry, size limits and the wire format. OTLP/JSON has traps (ids are hex strings, 64-bit timestamps are *strings*, enums are ints). Narrow: traces only. |
| C. Collector `filelog` receiver parsing today's stdout JSON | None in the app | 0 code days | No app change; works today. | Spans become log records that must be re-assembled by the collector config; no real trace ids in OTel's own model; fragile to field renames; no propagation. |
| D. Do nothing | — | — | — | The item stays open. |

**Recommendation: B for Phase 1, with the span-building code isolated so A can replace the transport later.**
Reasons: it matches the constraint already written into `tracing.js` (swap, don't restructure); the app's
runtime dependency list stays as it is (it currently has no OTel packages); and the risk is bounded by a
flag. If the product later needs auto-instrumentation of `pg`/`http` or tail sampling in-process, that is
the point to switch to A; the measured footprint says A is *affordable*, so the choice is about
restructuring cost, not size. I would also accept A if you prefer standard tooling over a smaller diff —
that is decision 1 below.

## 3. Proposal (Phase 1)

1. **Span model.** Keep `startRequestSpan/mark/endRequestSpan` signatures. Add a wall-clock anchor at start;
   convert checkpoints to child spans (name, parent = root span id, start, end) at end. Status maps to
   OTLP `STATUS_CODE_OK`/`ERROR`.
2. **Exporter** (`server/otlpExporter.js`). In-memory queue, bounded (e.g. 2,048 spans; drop-oldest and
   count drops), flush every `FINOPS_OTEL_FLUSH_MS` (default 5000) or at a batch size, `POST` to
   `FINOPS_OTEL_EXPORTER_OTLP_ENDPOINT` (`…/v1/traces`) as `application/json`, timeout, bounded retries
   with backoff on `429/502/503/504` only, never on `4xx`. Optional `FINOPS_OTEL_EXPORTER_OTLP_HEADERS`
   for an auth header. Exporter failures are logged at most once per interval and **never** affect a
   request. Stdout lines are unchanged and stay on unless disabled (rollback and migration path).
3. **Resource.** `service.name=finops-mvp` (overridable), `service.version` from `package.json`,
   `deployment.environment` from `NODE_ENV`.
4. **Inbound `traceparent`.** If present and valid (version `00`, 32-hex non-zero trace id, 16-hex non-zero
   parent id), continue that trace: reuse the trace id, set the parent span id. Invalid → start a new trace.
   Respect the sampled flag. Outbound `traceparent` on the provider call is **not** included in Phase 1: it
   changes bytes sent to third-party providers and needs your sign-off.
5. **Shutdown.** Flush the queue on `SIGTERM`. This depends on the graceful-shutdown work in RFC 0001
   phase A; until then, up to one flush interval of spans can be lost on a kill (acceptable for traces).
6. **Privacy.** Span attributes today come from the proxy route. Phase 1 adds a test that no attribute value
   contains a prompt, completion, API key or `Authorization` value. Exporting leaves the process, so this
   is the main risk of the change, not performance.

## 4. Cost and risk

- **Effort:** Phase 1 about 2–3 days including tests. Collector config and backend: not estimable (see §6).
- **Overhead when disabled:** unchanged (one branch per call).
- **Overhead when enabled:** one object and a few `hrtime` calls per request; export is off the request path.
  Not yet measured; I will measure with the existing load test before claiming a number.
- **Memory:** bounded by the queue cap.
- **Failure mode:** collector down → spans dropped and counted, requests unaffected.

## 5. Verification, and what cannot be verified

Verifiable here:
- **Wire format:** build the OTLP/JSON request and validate it against the official protobuf definitions
  (`opentelemetry-proto` 1.45.1, parsed with the protobuf JSON parser in a scratch Python venv). Catches the
  string-vs-number and hex-vs-base64 mistakes.
- **Behaviour against a local receiver:** a test HTTP server that records requests; assert batch size, flush
  on interval and on shutdown, retry on `503`, no retry on `400`, drop-oldest when full, no impact on proxy
  latency when the receiver hangs, and a trace with an inbound `traceparent` keeps its trace id.
- **Red first:** each behaviour test is run against the unfixed code.

**Not verifiable here, stays unverified:** a real OpenTelemetry Collector (its release binary could not be
downloaded in this sandbox; GitHub release downloads return `403`), a real backend (Jaeger, Tempo, vendor),
TLS and auth to a managed endpoint, behaviour under sustained collector backpressure, and real-world
span volume and cost. The final report will list these.

## 6. Decisions needed

1. **Option A (SDK) or B (own exporter)?** I recommend B; A is a defensible alternative.
2. **Where do spans go?** Collector in your cloud, a vendor, or only a local Jaeger for now. Blocks the
   collector config; shares the cloud decision in RFC 0001.
3. **May `traceparent` be sent to providers?** Default no.
4. **Sampling:** keep every proxy request (today), or a ratio? Volume is unknown until measured.

## 7. Rollback

Unset `FINOPS_OTEL_ENABLED` (everything is a no-op) or unset the exporter endpoint (stdout only, as today).
No schema change, no migration, nothing persisted.

## 8. Out of scope

Metrics (item 3 in the P2 list, with logging and a dashboard, needs a destination decision first),
auto-instrumentation of `pg`/`http`, tracing routes other than the proxy, log-trace correlation, and
operating a collector.
