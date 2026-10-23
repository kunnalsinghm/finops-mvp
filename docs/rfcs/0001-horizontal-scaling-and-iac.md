# RFC 0001 — Horizontal scaling and infrastructure-as-code

- **Status:** proposal, not started. **Verdict: IaC itself is not ready to write; a cloud-independent
  "scaling-readiness" slice is ready, once four decisions below are made.**
- **Scope:** P2 item 1 (infra-as-code + horizontal scaling).
- **Baseline:** `main` at `3adbea3` (SQLite 683 tests, Postgres 784 tests, both green).
- **Reads first:** `docs/tech-stack-migration-plan.md` §3.

## 1. Why this was deferred, and what changed

The migration plan (§3) already assessed the metering spool and deliberately deferred it. Its reasoning:
the spool is a last-resort path (it writes nothing when the database is healthy), so building a queue for
it means operating new infrastructure for a rarely-used path. It named one trigger: **before a second
proxy instance goes behind a load balancer**, and called it the only deviation with a real correctness
cliff (silent data loss when an instance's local disk disappears).

That trigger is now the work. But reading the code for this RFC shows the spool is **one of ten** things
that are per-process today. Fixing only the spool would let a second instance start and still break
logins. The honest scope of "horizontal scaling" is the table below.

## 2. What is per-instance today (verified against `main`)

Severity: **Loss** = data silently lost; **Break** = a user-visible feature fails; **Dup** = a side effect
happens more than once; **Drift** = behaviour changes but nothing is lost.

| # | Where | What happens with 2+ instances | Sev. |
|---|---|---|---|
| 1 | `meteringSpool.js` writes `data/metering-spool.jsonl` on local disk | Spooled spend is lost if that instance's disk is recycled before `npm run replay-spool` runs on it. | **Loss** |
| 2 | No `SIGTERM` handler (`server/index.js`; only the dev supervisor handles `SIGINT`) | A scale-down or rolling deploy kills the process mid-request. The proxy calls the provider **first** and meters **after**, so a kill in between loses billed spend *without even reaching the spool*. **Verified by experiment** (§5): `SIGTERM` during an in-flight provider call gave the client `ECONNRESET`, 0 usage rows and 0 spooled lines; the no-signal control recorded the row. | **Loss** |
| 3 | `users.js` `sessions` and `tenantUsers.js` `tenantSessions` are in-memory `Map`s | Log in on instance A, next request lands on B: `401`. | **Break** |
| 4 | `sso.js` `pendingStates` is an in-memory `Map` (OIDC CSRF state) | The IdP callback lands on a different instance than the one that started the login: SSO fails. | **Break** |
| 5 | No `trust proxy` setting anywhere. Verified: Express then reports the socket peer, ignoring `X-Forwarded-For` | Behind any load balancer, every client has the LB's IP. `loginRateLimit.js` (10 attempts / 15 min / IP) and the forgot-password limiter (5 / 15 min) become **global**: ten failed logins from anyone lock out everyone. Applies to a *single* instance behind a proxy too. | **Break** |
| 6 | `index.js` `setInterval` (every 5 min): budget/burn-rate/commitment/briefing checks, tenant jobs, lifecycle sweep, backups | Every instance runs every job. Alert dedupe is DB-backed (`budget_alert_state`, `anomaly_alert_state`, primary key on the tier) but is check-then-insert, so two instances can both pass the check and both deliver. | **Dup** |
| 7 | `governance.js` token buckets and quarantine allowance are in-memory | Effective rate limit is `N ×` the configured one. Documented in the file as single-process. | Drift |
| 8 | `cache.js`, `semanticCache.js` are in-memory per tenant | Lower hit rate; an admin cache-clear affects only the instance that served the call (inferred from the design, not tested). | Drift |
| 9 | `tenancy.js` opens a pool of up to 3 connections per active tenant, per instance | Postgres connections grow as `instances × active tenants × 3`. Needs a `max_connections` budget or a pooler. | Ops |
| 10 | SQLite backend (`data/finops.db`) | Single-writer file. Horizontal scaling means Postgres only. | Scope |

Items 1–2 are the correctness cliff. Items 3–5 stop a second instance from being usable. Items 6–10 are
real but survivable at small N.

One more fact that shapes the spool design: **`usage_events` has no idempotency key**, and
`replaySpool()` inserts then rewrites the file. A crash between the two replays a row twice, and a metering
write that timed out *after* committing would be spooled and then inserted again. At-least-once is
tolerable only if duplicates can be detected.

## 3. Proposal

Four phases. Phases A–C need **no cloud decision** and are fully testable locally. Phase D needs the
decisions in §6.

### Phase A — make a second process safe (no new infrastructure)

1. **Graceful shutdown.** On `SIGTERM`: stop accepting, let in-flight requests finish (bounded by a
   `FINOPS_SHUTDOWN_GRACE_MS`), flush the spool, close pools, then exit. Readiness (`/health/ready`)
   should start failing at the same moment so the load balancer drains first. Fixes #2.
2. **`FINOPS_TRUST_PROXY`.** Opt-in setting passed to Express `trust proxy` (hop count or CIDR list; unset
   keeps today's behaviour). Document that setting it blindly makes `X-Forwarded-For` spoofable. Fixes #5.
3. **Idempotency key on usage events.** New `event_id` (UUID) column written at insert and at spool time;
   unique index; replay uses insert-if-absent. Needs migration 14 (both dialects) and the same column in
   `schema.tenant.js`. Prerequisite for any at-least-once spool design.
4. **Run periodic jobs once.** Take a Postgres advisory lock per job tick (`pg_try_advisory_lock`); the
   instance that wins runs it, the rest skip. Under SQLite, behaviour is unchanged. Fixes #6.
   **Status: done** (`server/jobLock.js`, `server/scheduler.js`; alert-dedupe race closed in `server/fireOnce.js`).

### Phase B — shared auth state

Sessions (#3) and SSO state (#4) need to survive instance boundaries. Options:

| Option | For | Against |
|---|---|---|
| **B1. `sessions` table in Postgres** (hashed token, expiry) | No new infrastructure; revocation and "log out everywhere" are trivial; matches how reset/invite tokens already work. | One DB read per authenticated request on top of the existing key/session lookup. |
| B2. Signed stateless tokens (HMAC/JWT) | No lookup. | Cannot revoke before expiry without a deny-list, which reintroduces state. `destroyAllSessionsForTenant` (used by `purgeTenant`) would stop working. |
| B3. Redis | Fast; also usable for rate limits. | New infrastructure for a small problem. |

**Recommend B1.** SSO `state` goes in the same table with a short expiry. Rate-limit counters (#7) stay
per-instance, with the semantics documented ("effective limit is N× per instance") rather than adding a
dependency; revisit if that matters in practice.

### Phase C — the spool (#1)

The spool exists for when the **database is down**, so a spool *table* in that database is the wrong
answer. Options:

| Option | Survives instance loss? | Verdict |
|---|---|---|
| C1. Shared network filesystem (NFS/EFS) with the current append | Yes | **Reject.** `O_APPEND` is not atomic across hosts on NFS; interleaved lines corrupt rows. Fixable with one file per instance, which then needs a stable instance identity. |
| C2. Per-instance durable volume + replay on boot | Only if the volume outlives the instance | Fits StatefulSet-style deployments only. |
| **C3. Object storage, one object per event** (unique key = `event_id`) | Yes | Atomic, no append contention, independent of the DB. Replay lists a prefix, inserts idempotently, then deletes. Cost is a PUT on a rare path. |
| C4. A real queue (SQS / Redis Streams / NATS) | Yes | What the migration plan imagined. Heavier to operate; justified only if a queue is wanted for other reasons. |

**Recommend C3**, behind a small `spool` interface whose first implementation is today's file (so
single-instance deployments change nothing). The local-file implementation stays as the fallback when the
object store is also unreachable. Which object store depends on the cloud decision (§6).

### Phase D — infrastructure-as-code

Only after §6 is answered. Target shape: network + load balancer with health check on `/health/ready`,
container service running N instances of the existing `Dockerfile`, managed Postgres, object-storage
bucket (spool, and the S3 backup destination `tech-stack-migration-plan.md` §5 recommends), secret
injection (see the secrets item), and an OTLP collector (RFC 0002). Tool choice (Terraform vs Pulumi) and
cloud are open. I will not write modules for a cloud nobody has chosen.

## 4. What it costs

Engineering estimates are mine and unmeasured. Infrastructure running cost cannot be estimated until a
cloud and instance sizes are chosen.

| Phase | Estimate | Main risk |
|---|---|---|
| A (shutdown, trust proxy, event_id, job lock) | 3–5 days | The migration touches `usage_events`, the hottest table; needs care on large Postgres tables (a nullable column plus a concurrent index, not a table rewrite). |
| B (sessions table, SSO state) | 2–3 days | Added latency on every session-authenticated request; measure it. |
| C (spool interface + object-store implementation + idempotent replay) | 3–5 days | Needs a real or emulated object store to test; failure semantics (partial replay) must be explicit. |
| D (IaC) | 1–2 weeks for one cloud, plus review | Not testable without a cloud account; see §5. |

## 5. How each phase will be verified (and what cannot be)

**Already run for this RFC** (throwaway script, not committed): a real `server/index.js` on SQLite against a
mock provider that takes 2.5 s. Control, no signal: `HTTP 200`, 1 usage row, cost `$0.00075`, 0 spooled.
`SIGTERM` at t = 1 s: client `ECONNRESET`, 0 rows, `$0` recorded, 0 spooled. This is the red test for
phase A's graceful shutdown; it becomes a committed test with that change.


- **A–C are testable locally**, which is the main reason to do them first. The key new test is a
  **two-process harness**: start two real `server/index.js` processes against one Postgres, then assert
  (a) a session created on one works on the other, (b) a periodic job runs once per tick, (c) `SIGTERM`
  during an in-flight proxy call lets it finish and meters it, (d) spooled events replay exactly once
  after a simulated instance loss, (e) a trusted `X-Forwarded-For` gives per-client rate limiting.
  Each is run red on the unfixed code first.
- **D is not verifiable by a test suite.** What I *can* run without credentials: `terraform fmt -check`,
  `terraform validate` (needs provider schemas downloaded), and `plan` against a mock/localstack backend if
  one is available. What stays unverified until a real deployment: IAM permissions, security groups,
  health-check timing, the load balancer's idle timeout against streaming responses, and cost. The final
  report will list these explicitly rather than implying coverage.

## 6. Decisions needed

1. **Cloud and IaC tool** (AWS / GCP / Azure; Terraform or Pulumi). Blocks phase D and the choice of object
   store in C.
2. **Is a second instance actually planned**, and roughly when? If not soon, phases A and B still remove
   latent bugs (shutdown loss, `trust proxy`), but C and D can wait.
3. **Sessions: Postgres (B1) acceptable?** Or is Redis already part of the target stack?
4. **Spool durability target.** Is "survives instance loss while the DB is down" the requirement
   (→ C3/C4), or is "survives a restart on the same volume" enough (→ C2)?

## 7. Rollback

- **A:** each item is independently revertible. `FINOPS_TRUST_PROXY` unset and no change to SQLite mean
  the old behaviour is the default. Migration 14 is additive (a nullable column and an index), so an older
  build keeps working against the new schema, per the migrations README's rule.
- **B:** keep the in-memory map as a read-through fallback behind a flag for one release; reverting is
  the flag.
- **C:** the file implementation remains the default and the fallback; switching back is configuration.
  Objects already in the bucket would need one replay pass before turning it off.
- **D:** infrastructure is created from code, so rollback is `destroy` of a stack that nothing else
  depends on yet; data lives in Postgres and the bucket, which should have deletion protection.

## 8. Out of scope

Autoscaling policy, multi-region, a service mesh, replacing the in-memory caches, TypeScript (migration
plan §1), and moving rate limits to a shared store (see B).
