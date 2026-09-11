// storage/postgres.js - Postgres backend for the storage adapter interface.
//
// Two structural differences from SQLite that this file exists specifically
// to paper over, so calling code never has to know which backend is active:
//
//   1. Placeholder syntax: SQLite uses positional `?`, Postgres requires
//      `$1, $2, $3...`. toPositional() below translates every query
//      automatically - this is why the SQL text at call sites doesn't need
//      to change between backends, only the SQLite-specific date/string
//      functions do (see the migration plan's Phase B notes on that).
//
//   2. No native "last inserted id": Postgres has no equivalent of SQLite's
//      .lastInsertRowid. Any INSERT that needs the new row's id must add
//      `RETURNING id` itself (harmless no-op for the SQLite backend, since
//      node:sqlite's .run() silently ignores a RETURNING clause and still
//      populates lastInsertRowid its own way - see sqlite.js).
//
// Optional per-process schema isolation: set FINOPS_POSTGRES_SCHEMA to run
// every query against a dedicated schema instead of "public". This exists
// so test files (or anything else that wants a disposable namespace) can
// get the same kind of isolated environment SQLite gets for free via a
// unique file per test - without it, every test file sharing one Postgres
// database collides on UNIQUE constraints and leftover rows between runs.
// The schema name is lowercased and validated as a plain identifier before
// use - Postgres folds unquoted identifiers to lowercase per standard SQL
// rules, so a mixed-case name passed via `-c search_path=...` would
// silently point at a different (lowercase) schema than one created via a
// quoted CREATE SCHEMA "MixedCase" - lowercasing here up front avoids that
// mismatch entirely rather than relying on both sides happening to agree.

const { Pool } = require("pg");

// By default, node-postgres returns BIGINT/COUNT(*) results as STRINGS, not
// numbers - to avoid silent precision loss for values beyond
// Number.MAX_SAFE_INTEGER. But this codebase relies on strict equality
// against plain numbers in several places (e.g. auth.js's bootstrap check
// `anyKeys.n === 0`), which would silently and permanently break under
// Postgres if left as-is ("0" === 0 is false in JS). None of this app's
// counts are anywhere near that precision ceiling, so parsing them as plain
// numbers here - once, globally - is the right tradeoff, and it means every
// call site behaves identically regardless of which backend is active.
const { types } = require("pg");
types.setTypeParser(20 /* int8/bigint */, (val) => parseInt(val, 10));

const dialect = "postgres";

function assertSafeSchemaName(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`FINOPS_POSTGRES_SCHEMA must be a lowercase identifier (letters, digits, underscore, not starting with a digit), got '${name}'`);
  }
  return name;
}

const rawSchema = process.env.FINOPS_POSTGRES_SCHEMA;
const schemaName = rawSchema ? assertSafeSchemaName(String(rawSchema).toLowerCase()) : null;

const poolConfig = { connectionString: process.env.FINOPS_POSTGRES_URL };
if (schemaName) {
  // Sets search_path at connection startup for every connection this pool
  // ever opens - simpler and more reliable than setting it per-query.
  poolConfig.options = `-c search_path=${schemaName},public`;
}
const pool = new Pool(poolConfig);

// Converts a `?`-placeholder query into Postgres's `$1, $2, ...` form.
// Deliberately naive (doesn't try to parse string literals containing a
// literal '?' character) - none of this codebase's queries do that, and a
// full SQL tokenizer is overkill for an internal translation layer.
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const { SCHEMA_SQL } = require("./schema.postgres");
const ready = (async () => {
  if (schemaName) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  }
  await pool.query(SCHEMA_SQL);
})().catch((err) => {
  throw new Error(`Postgres schema initialization failed: ${err.message}`);
});

// CRITICAL: every query-running function below awaits `ready` FIRST, before
// touching the pool. Without this, any caller that queries before the
// server's own startup sequence (server/index.js's `await storage.ready`)
// has had a chance to run - which is every test file, every one-off script,
// anything that isn't server/index.js itself - races the schema-creation
// query and hits "relation does not exist" on tables that haven't been
// created yet.

async function get(sql, params = []) {
  await ready;
  const result = await pool.query(toPositional(sql), params);
  return result.rows[0];
}

async function all(sql, params = []) {
  await ready;
  const result = await pool.query(toPositional(sql), params);
  return result.rows;
}

async function run(sql, params = []) {
  await ready;
  const result = await pool.query(toPositional(sql), params);
  // If the caller's INSERT included "RETURNING id", result.rows[0].id is the
  // new row's id - otherwise there's nothing to report (matches SQLite's
  // behavior of lastInsertRowid being 0/undefined for non-INSERT statements).
  const lastInsertRowid = result.rows[0]?.id;
  return { lastInsertRowid, changes: result.rowCount };
}

async function exec(sql) {
  await ready;
  await pool.query(sql);
}

// Runs `fn` inside a single BEGIN/COMMIT/ROLLBACK block on ONE checked-out
// client (pool.connect()), not the pool's own .query() - this is the whole
// point. Separate pool.query() calls can silently land on different
// physical connections, so a naive port of reconcile.js/seed.js's old
// db.exec("BEGIN"/"COMMIT") pattern would let a transaction partially
// commit with no real rollback on error. `fn` receives a { get, all, run }
// object scoped to this one client so every statement inside the callback
// is guaranteed to run on the same connection. Since search_path is set at
// the pool/connection level (poolConfig.options above), a checked-out
// client automatically inherits it too - no extra handling needed here.
async function transaction(fn) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = {
      get: async (sql, params = []) => {
        const result = await client.query(toPositional(sql), params);
        return result.rows[0];
      },
      all: async (sql, params = []) => {
        const result = await client.query(toPositional(sql), params);
        return result.rows;
      },
      run: async (sql, params = []) => {
        const result = await client.query(toPositional(sql), params);
        const lastInsertRowid = result.rows[0]?.id;
        return { lastInsertRowid, changes: result.rowCount };
      },
    };
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failing (e.g. connection already dropped) shouldn't mask
      // the original error that triggered it.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { dialect, get, all, run, exec, transaction, pool, ready, schemaName };
