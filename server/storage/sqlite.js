// storage/sqlite.js - SQLite backend for the storage adapter interface.
// Wraps node:sqlite's synchronous DatabaseSync in an async-shaped API so
// route/module code can be written once against storage/index.js and work
// unchanged regardless of which backend is actually configured.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.FINOPS_DB_PATH || path.join(DATA_DIR, "finops.db");
const raw = new DatabaseSync(DB_PATH);
raw.exec("PRAGMA journal_mode = WAL;");

const { SCHEMA_SQL } = require("./schema.sqlite");
raw.exec(SCHEMA_SQL);

// CREATE TABLE IF NOT EXISTS silently does nothing for a table that already
// exists, so a column added to the schema later never reaches an existing
// database file - the classic "no such column: X" on startup. This is the
// smallest safe fix for ADDITIVE changes: check the live table, ALTER only if
// the column is missing. It is deliberately NOT a general migration system
// (no ordering, no version table, no destructive changes) - see the
// migrations item in the roadmap.
// Returns true only when it actually added the column, so callers can run a
// one-time backfill on exactly that upgrade and never again.
function ensureColumn(table, column, ddl) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}
ensureColumn("api_keys", "allow_background", "INTEGER NOT NULL DEFAULT 0");

// usage_events.key_id: before it existed the proxy stored the authenticated key
// in user_id, so for existing rows the key can be recovered whenever user_id is
// the id of a real key. Best-effort by design: rows whose user_id isn't a known
// key (ingest events with a client-declared user_id, deleted keys) stay NULL
// rather than being guessed at.
if (ensureColumn("usage_events", "key_id", "TEXT")) {
  raw.exec(
    `UPDATE usage_events SET key_id = user_id
     WHERE key_id IS NULL AND user_id IN (SELECT key_id FROM api_keys)`
  );
}

const dialect = "sqlite";

// SQLite's node:sqlite module happily accepts a trailing "RETURNING id"
// clause (bundled SQLite is >=3.35) - so the same INSERT ... RETURNING id
// pattern used for Postgres also works here, and .lastInsertRowid is used
// as the fallback for any insert that didn't bother adding RETURNING.
async function get(sql, params = []) {
  return raw.prepare(sql).get(...params);
}

async function all(sql, params = []) {
  return raw.prepare(sql).all(...params);
}

async function run(sql, params = []) {
  const info = raw.prepare(sql).run(...params);
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

async function exec(sql) {
  raw.exec(sql);
}

// Runs `fn` inside a single BEGIN/COMMIT/ROLLBACK block. SQLite only ever
// has the one connection (raw), so unlike Postgres there's no risk of
// separate calls landing on different connections - this exists mainly so
// callers can write identical transaction() code against both backends.
// `fn` receives a { get, all, run } object with the same signatures as the
// module-level ones above; using those (not the outer get/all/run) inside
// a transaction isn't required for correctness here, but keeps the calling
// code backend-agnostic, matching the Postgres version where it IS required.
async function transaction(fn) {
  raw.exec("BEGIN");
  try {
    const tx = {
      get: async (sql, params = []) => raw.prepare(sql).get(...params),
      all: async (sql, params = []) => raw.prepare(sql).all(...params),
      run: async (sql, params = []) => {
        const info = raw.prepare(sql).run(...params);
        return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
      },
    };
    const result = await fn(tx);
    raw.exec("COMMIT");
    return result;
  } catch (err) {
    raw.exec("ROLLBACK");
    throw err;
  }
}

module.exports = { dialect, get, all, run, exec, transaction, raw, ready: Promise.resolve() };
