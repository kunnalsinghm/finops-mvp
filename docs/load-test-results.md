# Proxy load test results (P0 #3)

Run against `POST /api/proxy/openai` with `scripts/loadtest.js`, using
`scripts/mock-provider.js` as the upstream (zero real API cost, repeatable).
**Read "How far to trust these numbers" before quoting any figure below.**

## Headline

| | |
|---|---|
| Errors / 5xx under load | **0** across ~35,000 requests, up to 200 concurrent |
| Dropped billing records | **0** — `usage_events` rows written equalled successful requests in every run; no metering-spool file was ever created |
| Server memory | ~135 MB idle → ~160 MB after 35k requests (no leak visible at this scale) |
| Peak throughput (small table) | **~175–185 req/s** at c=10–100 on the test box |
| Throughput at ~20-25k rows, single burst (worst case: every row is "today") | ~45 req/s → **~78–88 req/s** after the follow-up fix below |
| Throughput at ~20-25k rows, realistic history (only ~1.7% of rows are "today", spread over 60 days — see follow-up) | **~78–88 req/s**, roughly **1.8–2x** the original ~41–49 req/s |
| Postgres, same query, 20k realistic rows | **0.9 ms** (index scan) vs **22.9 ms** (sequential scan) on the unfixed query — **~25x** |
| Monthly budget check (`routes/proxy.js`, every request for a team with a budget) | **~40.0 ms → ~13.6 ms/call** at 100k rows — **~2.9x** — see Finding 2b |
| Default per-key rate limit | **1 req/s sustained** (60 burst) — see Finding 3 |

**The honest one-line conclusion:** the proxy is stable and never lost a billing
event. Finding 2 (throughput decaying with usage history) is now **closed** for
the query shapes this pass found — five hot-path queries fixed with additive
indexes and two rewritten to be sargable — with one remaining, smaller,
inherent cost documented below and a genuine "make it O(1)" option (a
maintained rollup table) still on the table for later if a customer's volume
ever needs it. A follow-up audit (Finding 2b) found the same non-sargable
pattern in the monthly budget/quota checks — the single most expensive query
found anywhere in the codebase — and closed it the same way.

## Test environment

- **1 vCPU, 3.9 GB RAM**, Node v22.22.2, built-in `node:sqlite`, single server process.
- The load generator, the mock provider **and** the server all shared that one core.
  Real hardware (and a load generator on a separate machine) will do better in
  absolute terms.
- Mock provider replies instantly. Real providers hold each connection open for
  0.5–30 s, so in production the number of requests *in flight* will be far higher
  than here for the same req/s.
- SQLite only for the throughput numbers. **Postgres was measured directly for
  Finding 2's query plan/timing proof** (a real Postgres 16 instance, not a
  simulation), but not for an end-to-end throughput run — see "How far to
  trust these numbers."
- First pass: all traffic used one API key and one team, and every row was
  "today" — a worst case for the windowed aggregates in Finding 2, but it also
  hid the specific non-sargable-query problem the follow-up pass found (see
  below), because a benchmark where every row is "today" can't distinguish
  "index bounds the scan" from "the whole table matched anyway." The
  follow-up pass re-measured against a seeded, realistic dataset instead:
  20,000 rows spread across 60 days, with only ~335 (1.7%) actually dated
  "today" — much closer to what a real deployment's table looks like after
  a few months.

## Measured results

Server started with the rate limiter raised (see Finding 3) so the proxy itself was
measured, not the limiter. "Table" = `usage_events` rows at the start of the run.

### After the fixes in this change

| Run | Concurrency | Requests | Table | Throughput | p50 | p99 | Errors |
|---|---|---|---|---|---|---|---|
| D1 | 10 | 1,000 | 0 | 184.6 req/s | 50 ms | 156 ms | 0 |
| D2 | 100 | 1,500 | 1,000 | 173.7 req/s | 555 ms | 659 ms | 0 |
| D3 | 200 | 1,500 | 2,500 | 146.2 req/s | 1,320 ms | 1,960 ms | 0 |
| D4 (streaming/SSE) | 50 | 1,000 | 4,000 | 122.9 req/s | 400 ms | 466 ms | 0 |
| C1 | 50 | 5,000 | 0 | 162.5 req/s | 299 ms | 496 ms | 0 |
| C2 | 50 | 5,000 | 5,000 | 93.0 req/s | 541 ms | 671 ms | 0 |
| C3 | 50 | 5,000 | 10,000 | 67.2 req/s | 744 ms | 872 ms | 0 |
| P1–P3 | 20–50 | 600–3,000 | 15–21k | 41–49 req/s | ~0.5–1.2 s | ~0.7–1.3 s | 0 |

Latency is essentially `concurrency ÷ throughput` (a saturated single thread
queuing work), not a sign of individual slow requests.

### Before the fixes (same scenarios, original code)

| Concurrency | Requests | Throughput |
|---|---|---|
| 10 | 2,000 | 189.9 req/s |
| 50 | 5,000 | 125.9 req/s, then **73.4 req/s** on the identical repeat |
| 100 | 5,000 | 54.1 req/s |

### Follow-up pass: realistic historical data (not a single dense burst)

Table pre-seeded with 20,000 rows spread over 60 days (only ~1.7% "today")
before each run below, then more traffic added on top by the load test itself
— unlike the tables above, which were built entirely from the load test's own
same-day burst. This is what actually exposed the non-sargable-query problem
(see Finding 2) and is the more representative test of the two.

| Run | Concurrency | Requests | Table (start → end) | Throughput | p50 | p99 |
|---|---|---|---|---|---|---|
| J1 | 50 | 2,000 | 20,001 → 22,001 | 87.6 req/s | 558 ms | 638 ms |
| J2 | 50 | 2,000 | 22,001 → 24,001 | 78.1 req/s | 629 ms | 712 ms |
| J3 | 100 | 1,500 | 24,001 → 25,501 | 71.4 req/s | 1,375 ms | 1,530 ms |

For comparison, the original (unfixed) code on the same shape of data (P1–P3
above, same 15–21k row range, same single-core box) ran 41–49 req/s — so this
is roughly **1.8–2x**, holding up as the table keeps growing rather than
continuing to decay the way the original code did.

## Findings

### 1. Real bug (fixed): the fraud-signal check never ran on the proxy path
`logUsageEvent` in `server/routes/proxy.js` referenced `req.controlPlaneDb`, but
`req` is not in scope in that function. Every proxied request threw a
`ReferenceError`, which the surrounding advisory `try/catch` downgraded to a
`[WARN] advisory check failed ... req is not defined` log line. **A6's automated
compromised-key response could therefore never trigger from proxied traffic.** It
was invisible because `fraudDetection.test.js` only tests the detector in
isolation. The load test surfaced it as tens of thousands of identical warnings.

Fixed (one word: use the already-destructured `controlPlaneDb`), with a
proxy-level regression test that fails on the old code and passes on the new.

### 2. Scalability limit (CLOSED, this follow-up pass): per-request aggregates over usage history

**Original finding, first pass:** CPU profile at ~20k rows showed 77.5% of all
CPU in synchronous SQLite `get()`. Five queries ran on *every* request, each
linear in the rows inside its window, so cost grew with a key's/team's/model's
*entire history*, not just the window the query actually needed — the reason
throughput fell from ~185 req/s to ~45 req/s as the table grew. First pass
fixed one of the five (migration `0011`: index on `usage_events(user_id,
event_time)`, plus bounding two unbounded `COUNT(*)` history checks with
`LIMIT`) and left the rest open with three documented options.

**This pass closed the rest**, using option 1 from that list (composite/sargable
indexes) rather than option 3 (a maintained rollup table) — see "Why not the
rollup table" below for the reasoning. What was actually wrong, one query at a
time, measured on a *realistic* dataset (20,000 rows spread over 60 days, only
~1.7% "today" — the first pass's benchmark had every row dated "today," which
hid this):

| Query (file) | Problem | Before | After |
|---|---|---|---|
| Team spend today (`anomaly.js`) | `date(event_time) = date('now')` wraps the column in a function — **not sargable**, no index can bound it | 4.9 ms | **0.4 ms** (rewritten to a plain range: `event_time >= start-of-day AND < start-of-tomorrow`, new `idx_usage_team_time`) |
| Fraud: key's requests today (`fraudDetection.js`) | Same non-sargable pattern | 2.4 ms | **0.3 ms** (same rewrite, `idx_usage_user_time` from 0011) |
| Team 14-day baseline (`anomaly.js`) | Range predicate was already sargable, but no `(team, event_time)` index existed — scanned the team's *entire* history, not just 14 days | 4.6 ms | **~1.9 ms** (new `idx_usage_team_time`) |
| Model 30-day average cost (`anomaly.js`) | Same shape, scanned that model's entire history | 3.6 ms | **~2.6 ms** (new `idx_usage_provider_model_time`) |
| "Has this key used this model before" (`fraudDetection.js`) | No index covered `(user_id, provider, model)` together — fell back to the provider+model index and scanned every row with that model org-wide looking for a matching key | **6.1 ms** | **0.003 ms** (new covering `idx_usage_user_provider_model`) — **~2,000x** |
| "Has this key used this region before" (`fraudDetection.js`) | Same shape for `(user_id, client_region)` | not separately timed | fixed the same way, new `idx_usage_user_region` |
| Org-wide history count (`anomaly.js`) | Two identical unfiltered `COUNT(*)` per request (once per org-wide check) for the same value | 2x calls | **1x call** (shared `Promise`, same result reused) |
| Fraud: key's 14-day baseline (`fraudDetection.js`) | `COUNT(DISTINCT date(event_time))` — genuinely needs `date()` evaluated per matching row, range predicate already sargable | 6.6 ms | **not changed** — already bounded to one key's 14-day window by 0011's index, which is the difference that actually matters. See "still open" below. |

Net effect measured end-to-end (same realistic dataset, `scripts/loadtest.js`,
c=50): **~60 req/s → ~78–88 req/s**, roughly **1.8–2x** the original unfixed
baseline (~41–49 req/s) at a comparable table size. On Postgres, isolated
`EXPLAIN ANALYZE` on the worst offender (team-spend-today) went from a
**sequential scan discarding 19,666 of 20,000 rows (22.9 ms)** to an **index
scan with every condition pushed into the index lookup itself (0.9 ms)** —
**~25x**, and the cleanest single proof that the fix works as intended, not
just "fewer milliseconds in one sandbox."

**Still open, by design:** the key's-14-day-baseline query's `COUNT(DISTINCT
date(event_time))` can't be made sargable — computing a distinct-date count
genuinely requires evaluating `date()` on every row in the window. It's
already bounded to *one key's own 14-day volume* (not org-wide, not that
key's whole history) by 0011's index, which is the difference that matters in
practice: a key doing even a few thousand requests/day costs a few thousand
function evaluations here, not tens of thousands. Making this O(1) instead of
O(one key's 14-day volume) needs the rollup table below.

**Why not the rollup table:** a maintained daily-rollup table (update a
per-day/team/model/key summary row on every insert, read baselines from it
instead of aggregating `usage_events` directly) would make every one of these
queries O(1) regardless of history size — the asymptotically correct fix. It
was deliberately not built in either pass: it has to stay in sync on every
`usage_events` INSERT *and* DELETE (`purgeUsageEvents` in `dataExport.js`),
across two dialects and two schema modes (single- and multi-tenant), and a
drift bug in that sync would silently corrupt every anomaly/fraud/budget
check that reads from it — a much larger correctness surface than an additive
index, which can only ever make a query faster or be a no-op. The composite-
index approach closes the actual problem found (unbounded growth with total
history) at a fraction of the risk. If a customer's per-key or per-team daily
volume ever gets large enough that the remaining `COUNT(DISTINCT date())`
query becomes the bottleneck again, the rollup table is the next step, and
this pass's benchmarking methodology (seed realistic historical data, not a
single dense burst) is how to prove it's needed and prove it works.

### 2b. Follow-up pass: the same non-sargable pattern in the monthly budget/quota checks (CLOSED)

Found during a later audit, not this pass's original load test — worth
recording here because it's the same root cause as Finding 2 and the single
most expensive query found in the whole codebase, bigger than anything fixed
above.

`routes/proxy.js`'s monthly budget check wrapped `event_time` in
`strftime('%Y-%m', event_time) = ?` / `TO_CHAR(...) = ?` (`yearMonthExpr()`)
instead of a sargable range — the exact mistake already fixed everywhere else
in Finding 2, just missed on this one query. It runs on **every proxied
request for any team with a budget configured**, which is a core feature, not
an edge case.

Measured directly (not estimated) on a 100k-row/6-month single-team dataset:

| | Query plan | Cost |
|---|---|---|
| Before (`yearMonthExpr`) | `SEARCH ... USING INDEX idx_usage_team_time (team=?)` | **~40.0 ms/call** |
| After (sargable range) | `SEARCH ... USING INDEX idx_usage_team_time (team=? AND event_time>? AND event_time<?)` | **~13.6 ms/call** |

~2.9x, and the index now bounds the scan to the current month instead of the
team's entire history. Grepping for the same `yearMonthExpr`/`thisMonthClause`
pattern found four more call sites with the identical bug, two of them on the
same per-request hot path as the one above:

| Location | Hot path? |
|---|---|
| `routes/proxy.js` — team budget check | **Yes, every request** |
| `tenantQuota.js` — monthly event quota | **Yes, every multi-tenant request** |
| `alerts.js` — `checkBudgetAlerts` | No, scheduled job |
| `alerts.js` — `checkBurnRate` | No, scheduled job |
| `routes/budgets.js` — `GET /status` | No, dashboard read |

All five now use a new shared `currentMonthBounds()` helper in `dialectSql.js`
(a plain `[start, end)` range, no dialect branching needed — unlike
`startOfTodayExpr()`/`startOfTomorrowExpr()`, a month boundary needs no
SQL-side date arithmetic at all, just two values computed once in JS).

One adjacent, genuinely pre-existing bug was found and fixed as a byproduct,
not part of this query fix: a test
(`"POST /check-now fires a 50% budget alert exactly once..."`) failed, and
turned out to fail identically on the **unmodified original code** too, given
certain dates. `/check-now` runs `checkBudgetAlerts` and `checkBurnRate`
together, and early in any calendar month `checkBurnRate`'s naive
extrapolation (`spend ÷ dayOfMonth × daysInMonth`) makes a small charge look
like a large projected overrun, firing a second, unrelated alert the test
didn't account for. This was very likely the "mystery flaky test" an earlier
session lost track of — not flaky, just date-dependent, and would have kept
failing in the first few days of every month. Fixed by scoping the test's
assertion to the specific tier it's actually testing, not by changing
`checkBurnRate`'s own (separate, out of scope) extrapolation logic.

### 3. Default per-key rate limit is 1 request/sec
The first run returned 439 × HTTP 429 out of 500. That is the per-key token
bucket working as coded (capacity 60, refill 1/s, previously hard-coded), not a
capacity problem: 61 successes = 60 burst + ~1 refill in the 1.4 s run. Any real
backend funnelling through one key will be throttled almost immediately.

Now configurable via `FINOPS_RATE_LIMIT_CAPACITY` / `FINOPS_RATE_LIMIT_REFILL_PER_SEC`
(defaults **unchanged**, invalid values fall back rather than disabling the
limiter). Whether the *default* should be higher is a product decision I left
alone.

### 4. Tooling notes
`scripts/loadtest.js` auto-provisions its key via bootstrap mode, which only works
once per fresh database. It now says so, and prints an explanation when it sees
429s. To re-run, pass the printed key as `FINOPS_LOAD_TEST_API_KEY`.

## How to reproduce

```bash
# terminal 1
node scripts/mock-provider.js

# terminal 2  (raised limiter so the proxy, not the limiter, is measured)
FINOPS_DB_PATH=/tmp/lt.db PORT=4000 \
OPENAI_BASE_URL=http://localhost:5001/v1/chat/completions \
ANTHROPIC_BASE_URL=http://localhost:5001/v1/messages \
FINOPS_RATE_LIMIT_CAPACITY=1000000 FINOPS_RATE_LIMIT_REFILL_PER_SEC=1000000 \
node server/index.js

# terminal 3
FINOPS_LOAD_TEST_CONCURRENCY=50 FINOPS_LOAD_TEST_TOTAL=5000 node scripts/loadtest.js
# add FINOPS_LOAD_TEST_STREAMING=true for the SSE path
```

Run it 2–3 times back to back on the same database and watch throughput hold
steady rather than keep dropping — that used to be Finding 2, now much smaller
(see above for what's still open).

For the realistic-history scenario specifically (recommended — a same-day
burst alone won't reproduce the non-sargable-query problem this pass fixed),
seed historical rows directly before running the load test:

```js
// run once against the same FINOPS_DB_PATH, after the server has started at
// least once (so migrations have created the schema)
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/tmp/lt.db");
const insert = db.prepare("INSERT INTO usage_events (event_time, provider, model, user_id, cost_usd, team) VALUES (?, ?, ?, ?, ?, ?)");
db.exec("BEGIN");
for (let i = 0; i < 20000; i++) {
  const daysAgo = i % 60;
  const ts = new Date(Date.now() - daysAgo * 86400000 - Math.floor(Math.random() * 3600000)).toISOString();
  insert.run(ts, "openai", "gpt-4o-mini", "seed-key", 0.01, "load-test");
}
db.exec("COMMIT");
```

## How far to trust these numbers

- **Trust:** the shape (stable, no errors, no dropped events, the specific
  query-plan proof on Postgres) and the relative before/after comparisons —
  those are same-box, same-scenario, and the Postgres `EXPLAIN ANALYZE` numbers
  are from a real Postgres 16 instance with real seeded data, not estimated.
- **Do not quote:** the absolute req/s as production capacity. Re-run on
  hardware that matches what you'll deploy, with the load generator on a
  separate machine, a realistic mix of keys/teams (not one of each), and
  Postgres end-to-end (not just the isolated query-plan check this pass did).
- **Not covered:** an end-to-end Postgres throughput run (only the specific
  query fix was verified against real Postgres, not the full request
  pipeline), multi-tenant mode, many distinct keys/teams, the semantic cache
  and shadow-test paths, real provider latency, sustained multi-hour runs
  (memory growth beyond ~35k requests is unknown).
