# Tech-stack migration plan

A13 from the gap analysis: assess the five places this codebase deviates from
the Guard spec's recommended foundation (Node+TypeScript, React, a real
message queue, OpenTelemetry, S3-compatible storage), and decide - per
deviation - whether to migrate now, migrate at a specific trigger point, or
not at all. **This is explicitly not a rewrite plan.** A full migration on
any one of these axes is weeks of work on its own and carries real
regression risk against a codebase with 630+ passing tests that currently
prove correctness. Doing all five "as one more sub-item alongside A10-A12"
would be a bad trade, and this document does not attempt that.

What this pass actually changed, concretely, is scoped to **one** of the
five: a small, reversible, opt-in tracing step (see §4). The other four are
analysis only, by design - see each section for why.

---

## 1. JavaScript, no types (spec: TypeScript)

**Cost of staying as-is, at increasing scale.** This codebase is ~15,000
lines of server code across ~50 modules, already dense with cross-cutting
concerns threaded through shared shapes: a `db`-parameter convention every
storage-touching function follows, a `req.db`/`req.controlPlaneDb` split
that changes meaning between single-tenant and multi-tenant mode, and a
usage-event "row" object assembled in one place (`buildUsageRow` in
`routes/proxy.js`) and consumed in several others. None of that is enforced
by the language today - it's enforced by comments, naming convention, and
630+ tests. That works at the current size because a handful of people can
hold the whole shape in their heads. It stops working smoothly once: (a) a
new contributor changes a shared shape (say, adds a field to the usage-event
row) and has to grep every call site by hand to find what else needs
updating, instead of the compiler telling them; or (b) the team grows past
the size where everyone has read every module. Concretely, this codebase is
already close to that inflection point - `routes/proxy.js` alone is ~800
lines with a dozen-plus early-return branches threading through more than
ten optional fields, exactly the kind of code where "did I update every
caller" is a real, not theoretical, question.

**Realistic migration cost.** Converting ~50 JS modules to TypeScript
incrementally (`allowJs` + `checkJs`, or a `.ts` rename module-by-module) is
plausible without a stop-the-world rewrite - Node can run compiled/
transpiled TS today, and `tsc --checkJs` can be turned on file-by-file. The
real cost isn't the syntax conversion; it's that meaningful type-checking
requires deciding the shapes this codebase currently leaves implicit (the
usage-event row, the `db` parameter's real interface across SQLite/Postgres/
tenant-schema variants, the request-object augmentation `auth.js` does with
`req.apiKey`/`req.db`/`req.tenantId`). Rough estimate: 3-5 focused weeks for
one engineer to convert the storage layer + shared types first (highest
leverage, since almost everything depends on it), then another 4-6 weeks to
work outward through routes/services, run concurrently with normal feature
work rather than as a freeze. Tests do not need to be rewritten - node:test
files can stay .js and import from the newly-typed modules.

**Recommendation: migrate at a trigger point, not now.** The trigger:
**when a second engineer who didn't write this codebase starts contributing
regularly.** Today's actual cost of "no types" is bounded by one thing -
whether the people editing this code already hold its implicit shapes in
their heads - and that's true today. It stops being true the moment someone
new is expected to safely change `buildUsageRow` or the storage
abstraction. Start with the storage layer (`server/storage/*.js`) and
`auth.js`'s request augmentation first if/when that trigger arrives - they're
the highest-leverage, most-depended-on modules, so typing them first catches
the most bugs for the least conversion effort.

---

## 2. Vanilla HTML/CSS/JS + Chart.js dashboard (spec: React)

**Cost of staying as-is, at increasing scale.** The current dashboard
(`public/`) is server-rendered static assets with Chart.js for the charts -
fine for what exists today: read-mostly cost dashboards, a handful of forms
(budgets, keys, region allow-list). The cost shows up specifically when the
UI needs real client-side STATE that multiple components share and react to
- which A1's own gap list already calls out as missing: a logged-in
multi-tenant web UI, role-based UI (showing/hiding controls per RBAC role,
which A9 just added four more roles for), a self-service billing/plan
management screen, an org/settings screen with live-updating seat/usage
counts. Every one of those needs shared, reactive client state - which is
exactly what vanilla JS makes painful (manual DOM diffing, ad hoc event
wiring, state synchronized by hand across whatever elements currently
reflect it) and a component framework makes close to free.

**Realistic migration cost.** Not a rewrite-the-whole-dashboard job if done
incrementally: React can be introduced page-by-page (the budgets page, say)
without touching the rest, using the existing API endpoints unchanged (the
dashboard is already a pure API client - there's no server-side rendering
logic entangled with business logic to untangle). Rough estimate: 1-2 weeks
to stand up the build tooling + one converted page as a template, then
roughly 2-4 days per additional page/section converted after that,
spreadable across many small PRs rather than one migration effort.

**Recommendation: migrate at a trigger point, not now.** The trigger:
**the first screen that genuinely needs shared reactive state** - which,
per A1's own gap list, is likely the multi-tenant admin/RBAC-aware UI work
already flagged as missing. Don't convert the existing read-mostly cost
dashboards preemptively; they work fine as they are and converting them
first would be paying the migration cost before getting the payoff. Convert
opportunistically, page-by-page, starting with whichever new screen is
built first that actually needs the reactivity.

---

## 3. Flat-file spool, not a message queue (spec: Redis Streams/NATS/Kafka)

**Cost of staying as-is, at increasing scale.** `data/metering-spool.jsonl`
(see `server/meteringSpool.js`) is local disk, appended to when a metering
write fails after a provider call already succeeded and was billed - a
last-resort durability mechanism, not a queue with delivery guarantees (the
module's own header comment says so). The concrete failure mode: the moment
you run **more than one proxy instance behind a load balancer** (the
obvious next scaling step for the actual proxy hot path), each instance has
its OWN local spool file. A metering failure on instance A writes to
instance A's disk; if instance A's disk is lost (container recycled,
autoscaling scale-down, a crash before the volume is flushed) before
`npm run replay-spool` runs against THAT instance specifically, that spend
record is gone - not delayed, gone. This is a real, not theoretical, data-
loss risk the moment horizontal scaling of the proxy path happens, and
horizontal scaling of exactly that path is the first thing a real production
deployment under load would need.

**Realistic migration cost.** The expensive part isn't writing to Redis
Streams/NATS/Kafka instead of a file - it's operating that infrastructure
(a redis/NATS/Kafka cluster, its own HA story, its own monitoring) for what
is currently a LAST-RESORT path that, when the DB is healthy, writes nothing
at all. Rough estimate: 1-2 weeks for the client-side swap once the
abstraction boundary exists (see §4 - not built this pass, but designed
for), plus however long standing up and operating the chosen queue
technology takes at your organization (highly variable - could be near-zero
if a shared Redis cluster already exists for other reasons, or weeks if this
would be the first piece of message-queue infrastructure the team operates).

**Recommendation: migrate at a trigger point - specifically, before running
more than one proxy instance.** This is the one deviation on this list with
a genuine correctness cliff (silent data loss), not just a maintainability
cost, so the trigger is concrete and worth stating precisely: **the day a
second concurrent proxy instance goes behind a load balancer, this needs to
already be solved** - either a real queue, or, as a cheaper interim step,
the spool pointed at shared network storage instead of local disk (still not
a real queue, but at least removes the "lost with the instance" failure
mode without new infrastructure). This pass does not build the swap itself,
but the interface boundary that would make the swap a drop-in later rather
than a rewrite of every call site is real, separate work not attempted in
this pass - see the note in "What this pass deliberately did NOT touch"
below for why tracing was chosen instead.

---

## 4. Structured JSON logs only, no tracing (spec: OpenTelemetry) - **this pass's contained step**

**Cost of staying as-is, at increasing scale.** `logger.js` gives good
structured JSON logs per event (a usage row logged, an alert fired, a
migration applied), but nothing connects the individual log lines that
belong to ONE request into a single traceable unit as that request crosses
module boundaries: ingest → attribution → policy checks → pricing → the
actual provider call. Today, debugging "why did this specific request cost
what it did, and where did the time go" means manually correlating log
lines by eye (matching on key_id/team/timestamp) rather than following one
trace_id through a queryable trace. That's a real but currently tolerable
cost - request volume and module count are both small enough to eyeball.
It stops being tolerable at real production request volume, or once the
request path touches more services than one process (a real message queue
per §3 would ADD a hop that needs tracing across, not remove the need).

**Realistic migration cost, to the REAL OpenTelemetry SDK** (distinct from
what this pass built - see below): adopting `@opentelemetry/sdk-trace-node`
properly needs (a) context propagation across this codebase's many
`async`/`await` boundaries, which Node's `AsyncLocalStorage` handles but
needs threading through correctly everywhere a span should nest; (b) an
actual OTLP exporter and a collector (or hosted vendor) to send spans to -
new operational infrastructure, unlike this pass's console-only step; and
(c) instrumenting more than the one route this pass covers - the ingest
route, the reconciliation/reporting paths, the background jobs (alert
checker, commitment-balance checker) all currently have zero tracing.
Rough estimate: 1 week to wire the real SDK + exporter + collector choice
for the proxy route alone (reusing this pass's checkpoint locations as the
instrumentation points), then 2-3 more weeks to extend coverage to the rest
of the request-handling surface.

**What THIS pass actually built** (`server/tracing.js`, wired into
`routes/proxy.js`, opt-in via `FINOPS_OTEL_ENABLED=true`): a minimal,
dependency-free, OTel-COMPATIBLE span emitter - trace_id/span_id in the same
bit-width OTel/W3C trace-context uses, one structured JSON line per request
to stdout, with named checkpoints (`ingest.identity_resolved`,
`attribution.tag_rules_applied`, `policy.checks_passed`, `pricing.checked`,
`provider.call_start`/`call_end`) along the ingest/pricing/attribution/
policy/provider-call path the gap analysis specifically asked about. See
`server/tracing.js`'s own header comment for the full reasoning, in
particular: (1) why checkpoints rather than nested try/finally spans per
stage - the route has a dozen-plus early-return exit points, and wrapping
each stage would mean touching every one of them, which is exactly the kind
of restructuring risk this pass is scoped to avoid; and (2) why
`res.on("finish")` is what actually closes the span regardless of which
exit path a request took, without duplicating cleanup logic at each one.
Zero new npm dependencies; disabled by default; a single boolean check when
disabled (no allocation, no timestamp calls). Tests: `test/tracing.test.js`
(9 tests: the emitter itself, and end-to-end - a real proxy request with
tracing on emits exactly one span with the expected checkpoints, tracing off
emits nothing, and an early-blocked request still closes its span via
`res.on("finish")`).

**Recommendation for the REST of the OTel gap: migrate to the real SDK at
a trigger point** - specifically, **when there's an actual second
destination for spans to go to** (a collector, a vendor, even just "the ops
team wants to look at traces in a UI, not grep stdout"). Until that trigger,
this pass's console-only step is a reasonable, low-cost placeholder that
happens to already be shaped for that future swap (same trace_id/span_id
semantics), not a dead end that needs unwinding.

---

## 5. Local filesystem only, no S3-compatible storage (spec: S3-compatible object storage for backups/exports)

**Cost of staying as-is, at increasing scale.** Backups (`data/backups/`,
and as of A10, `data/backups-postgres/`) and data exports both write to
local disk. The concrete risk: a backup that never leaves the machine it was
taken on does not protect against losing that machine - the exact failure
mode a backup exists to protect against. This is already flagged as a "copy
these off the machine yourself" manual step in
`docs/backup-restore-runbook.md`; today that's a real, live gap, not a
hypothetical one.

**Realistic migration cost.** Genuinely small relative to the other four -
this is closer to "point an existing operation at a different destination"
than a framework migration. `pruneOldBackups`/`listBackups`/`runBackup` in
both `backup.js` (SQLite) and `backupPostgres.js` (Postgres, A10) already
isolate "where backups live" behind a small set of functions; swapping the
destination for an S3-compatible bucket (via the AWS SDK or a lighter
S3-compatible client) touches those functions and not much else. Rough
estimate: 2-4 days per backend (SQLite, Postgres) - dominated by picking a
client library and getting credentials/bucket-policy right, not by code
complexity.

**Recommendation: migrate now, or as the very next backup-related work** -
this is the cheapest of the five migrations by a wide margin, has a real
correctness/DR benefit (not just a maintainability one), and the code is
already structured in a way that makes it low-risk. It wasn't picked as
THIS pass's one contained step only because A10 (Postgres backup/DR) was
the higher-priority item already in this pass's scope, and doing both
Postgres backup automation AND S3 shipping in the same pass would have
been over budget for "one contained, reversible step" per A13's own
instructions. This is the natural next increment after A10, not a
someday-maybe.

---

## What this pass deliberately did NOT touch

Per A13's own scope: the JS-vs-TypeScript question, the vanilla-JS-vs-React
dashboard question, and the S3 migration are analysis only in this pass (§1,
§2, §5 above) - no code changes, by design. The message-queue abstraction
boundary described in §3 (an interface `meteringSpool.js` conforms to, so a
future Redis-Streams-backed implementation is a drop-in swap) was the OTHER
candidate "smallest contained step" A13's brief offered alongside tracing;
**tracing was chosen instead** (§4) because it required zero new npm
dependencies and touched exactly one route with a clean, low-risk
instrumentation point (checkpoints + `res.on("finish")`), where the queue-
interface option would have meant carefully re-deriving `meteringSpool.js`'s
existing failure-handling contract (see its own header comment: "not a queue
with delivery guarantees" is a deliberate property, not an oversight) into
an abstract interface without accidentally changing that contract - a
higher-risk edit for a codebase-safety pass whose explicit goal was "every
existing test must still pass unchanged." The queue-interface abstraction
remains a reasonable next contained step, scoped by itself in a future pass.
