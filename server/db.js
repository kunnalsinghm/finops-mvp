// db.js - DEPRECATED. Kept only for test files that still import it for
// low-level SQLite handle access (raw .close()) during teardown/cleanup.
// All actual schema/query logic has moved to storage/index.js + the
// storage/schema.*.js files - this file used to carry its OWN independent
// copy of the full schema, which had drifted out of sync with
// schema.sqlite.js (missing columns added there never made it here). That's
// exactly the kind of bug this file exists to NOT cause: several test files
// require this BEFORE requiring server/storage, so if this module creates
// the SQLite file first with a stale schema, storage/sqlite.js's later
// `CREATE TABLE IF NOT EXISTS` becomes a silent no-op against the
// already-existing (stale) table, and any `CREATE INDEX` on a newly-added
// column then fails with "no such column" - a real incident, not
// hypothetical, that motivated this fix. Requiring SCHEMA_SQL from
// schema.sqlite.js here instead of hardcoding a duplicate means the two can
// never drift apart again - there's only one schema definition now.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA_SQL } = require("./storage/schema.sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.FINOPS_DB_PATH || path.join(DATA_DIR, "finops.db");
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");
db.exec(SCHEMA_SQL);

module.exports = db;
