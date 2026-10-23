// jobLock.js - run a periodic job on ONE instance per tick (RFC 0001, phase A4).
//
// Every instance runs the same setInterval jobs, so with N instances each tick ran N
// times: N budget-alert passes, N weekly briefings, N Postgres dumps. On Postgres
// runExclusive() takes a SESSION-level advisory lock keyed by the job name around
// the job. The instance that gets it runs the job; the others skip this tick (a
// debug log line) and try again on the next one. SQLite is single-instance by
// nature (one file, one process), so there the job simply runs.
//
// How it is built, and why:
//  - pg_try_advisory_lock, never the blocking pg_advisory_lock: a skipped tick must
//    cost nothing, and a blocked statement is an open transaction (the same trap that
//    deadlocked CREATE INDEX CONCURRENTLY; see storage/migrator.js).
//  - The lock lives on a DEDICATED connection checked out for the whole job: a session
//    lock belongs to one connection, so it must be unlocked on that connection and only
//    then handed back to the pool.
//  - The lock is released when the job finishes OR throws (finally). If the unlock
//    itself fails the connection is destroyed instead of pooled, which also frees the
//    lock; a process that dies loses its connection and so its locks.
//  - drain() is for graceful shutdown: it refuses new jobs, waits for running ones (up to
//    a timeout), and past the timeout destroys the lock connections so a stuck job cannot
//    block the pool from closing. Without that, pool.end() waits forever for the checked-out
//    lock connection and the process hangs until the orchestrator kills it.
//
// Not a distributed scheduler: if the holder dies mid-job the others take the next tick;
// there is no leader election and no catch-up. Jobs must be safe to repeat (the fire-once
// alerts are; see fireOnce.js).

const storage = require("./storage");
const logger = require("./logger");

const inflight = new Map(); // id -> { name, promise, entry|null }
let draining = false;
let seq = 0;

const lockKey = (name) => `finops_job:${name}`;

function release(entry, destroy) {
  if (!entry || entry.released) return;
  entry.released = true;
  try {
    entry.client.release(destroy ? true : undefined);
  } catch { /* already gone */ }
}

// Returns { ran: true, value } or { ran: false, reason: "locked" | "shutting-down" }.
// If the job throws, the error propagates (after the lock is released).
async function runExclusive(name, fn) {
  if (draining) return { ran: false, reason: "shutting-down" };

  if (storage.dialect !== "postgres") {
    const id = ++seq;
    const promise = Promise.resolve().then(fn);
    inflight.set(id, { name, promise, entry: null });
    try {
      return { ran: true, value: await promise };
    } finally {
      inflight.delete(id);
    }
  }

  const client = await storage.pool.connect();
  const entry = { client, released: false };
  let got;
  try {
    const r = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [lockKey(name)]);
    got = r.rows[0].got;
  } catch (err) {
    release(entry, true);
    throw err;
  }
  if (!got) {
    release(entry, false);
    logger.debug("Skipping job this tick: another instance holds its lock", { job: name });
    return { ran: false, reason: "locked" };
  }

  const id = ++seq;
  const promise = Promise.resolve().then(fn);
  inflight.set(id, { name, promise, entry });
  try {
    return { ran: true, value: await promise };
  } finally {
    inflight.delete(id);
    if (!entry.released) {
      let healthy = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey(name)]);
      } catch {
        healthy = false; // destroying the connection frees the lock too
      }
      release(entry, !healthy);
    }
  }
}

// Graceful shutdown: no new jobs, wait for running ones, never hang the pool.
async function drain({ timeoutMs = 10000 } = {}) {
  draining = true;
  const running = [...inflight.values()];
  if (running.length === 0) return { timedOut: false };
  let timer;
  const timedOut = await Promise.race([
    Promise.allSettled(running.map((r) => r.promise)).then(() => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    logger.warn("Shutdown: periodic job(s) did not finish in time; releasing their locks", { jobs: running.map((r) => r.name) });
    for (const r of inflight.values()) release(r.entry, true);
  }
  return { timedOut };
}

function _reset() {
  draining = false;
  inflight.clear();
}

module.exports = { runExclusive, drain, _reset };
