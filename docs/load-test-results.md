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
| Throughput once `usage_events` holds ~20k rows of same-day traffic | **~40–50 req/s** |
| Default per-key rate limit | **1 req/s sustained** (60 burst) — see Finding 3 |

**The honest one-line conclusion:** the proxy is stable and never lost a billing
event, but its throughput **decays with the amount of usage history**, because
per-request anomaly/fraud checks aggregate over `usage_events` (Finding 2). That
must be addressed before a customer with real volume.

## Test environment

- **1 vCPU, 3.9 GB RAM**, Node v22.22.2, built-in `node:sqlite`, single server process.
- The load generator, the mock provider **and** the server all shared that one core.
  Real hardware (and a load generator on a separate machine) will do better in
  absolute terms.
- Mock provider replies instantly. Real providers hold each connection open for
  0.5–30 s, so in production the number of requests *in flight* will be far higher
  than here for the same req/s.
- SQLite only. **Postgres was not measured** (none available in the sandbox).
- All traffic used one API key and one team, and every row was "today" — a worst
  case for the windowed aggregates in Finding 2.

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

### 2. Scalability limit (partly fixed, mostly OPEN): per-request aggregates over usage history
CPU profile at ~20k rows: **77.5% of all CPU was synchronous SQLite `get()`**.
Timed in isolation on a 21k-row table, five queries run on *every* request:

| Query | Cost |
|---|---|
| Team spend today (`date(event_time) = date('now')`) | 4.9 ms |
| Team N-day baseline (SUM + COUNT DISTINCT date) | 4.6 ms |
| Provider/model 30-day average cost | 3.6 ms |
| Fraud: key's requests today | 2.4 ms |
| Fraud: key's 14-day baseline | 2.2 ms |
| **Total** | **17.7 ms → ~56 req/s ceiling per core** |

Each is linear in the rows inside its window, so cost grows with a key's/team's
daily volume. This is why throughput fell from ~185 req/s to ~45 req/s as the
table grew. A customer doing 50k requests/day on one team would pay this on every
call.

**Fixed in this change (safe, additive):**
- Migration `0011` (+ `schema.tenant.js` for multi-tenant): index on
  `usage_events(user_id, event_time)`. `user_id` had *no* index, so the fraud and
  smart-tag queries were full table scans.
- `fraudDetection.js`: two `COUNT(*)` history checks were only compared against
  "≥ 5" / "≥ 20"; now bounded with `LIMIT`, so O(20) instead of O(history).
  Behaviour identical (all fraud tests pass).

**NOT fixed — needs a design decision (recommended next step):** the five
aggregates above still scan their whole window. Options, roughly by effort:
1. Make the `date(event_time)` predicates range-based (sargable) and add
   `(team, event_time)` and `(provider, model, event_time)` indexes. Constant-factor
   win only; dialect/timestamp-format care needed for SQLite vs Postgres.
2. Cache the slow-changing baselines (14/30-day windows) for ~60 s per key/team.
3. Maintain a small daily-rollup table updated on insert and read baselines from
   it. Fixes the asymptotics; the proper fix.

I did not do these unilaterally: they change the anomaly/budget/fraud read paths,
and I could not validate the Postgres dialect here.

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

Run it 2–3 times back to back on the same database: the drop in throughput
between runs *is* Finding 2.

## How far to trust these numbers

- **Trust:** the shape (stable, no errors, no dropped events, throughput decays
  with history) and the relative before/after comparisons — those are same-box,
  same-scenario.
- **Do not quote:** the absolute req/s as production capacity. Re-run on
  hardware and a database (Postgres) that match what you'll deploy, with the load
  generator on a separate machine and a realistic mix of keys/teams.
- **Not covered:** Postgres, multi-tenant mode, many distinct keys/teams, the
  semantic cache and shadow-test paths, real provider latency, sustained
  multi-hour runs (memory growth beyond ~35k requests is unknown).
