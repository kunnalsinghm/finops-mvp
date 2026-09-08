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

module.exports = { dialect, get, all, run, exec, raw, ready: Promise.resolve() };
