// storage/migrator.js - versioned, ordered, recorded schema migrations.
//
// WHY THIS EXISTS. Until now the schema was only ever `CREATE TABLE IF NOT
// EXISTS ...`, which does nothing for a table that already exists, so a new
// column never reached an existing database ("no such column: X" on startup;
// the fix was to delete the database). That is fine for dev and fatal for a
// customer's data. Later, two ad-hoc upgrade hacks (an ensureColumn() helper for
// SQLite and a DO block for Postgres) papered over it for exactly two columns.
//
// THE MODEL.
//   - schema.sqlite.js / schema.postgres.js are the FROZEN BASELINE (version 1):
//     the schema as it stood before migrations existed. Do not edit them again.
//   - Every schema change after that is a numbered file in ./migrations, applied
//     once, in order, and recorded in the schema_migrations table.
//   - A fresh database = baseline + all migrations. An existing database = only
//     the migrations it hasn't seen. Same code path either way.
//
// GUARANTEES (each has a test in test/migrator.test.js).
//   - Atomic: a migration and its bookkeeping row commit together or not at all.
//   - Ordered and exactly-once, including under concurrent startup (Postgres
//     advisory lock; SQLite BEGIN IMMEDIATE).
//   - Tamper-evident: an applied migration's source is checksummed; editing it
//     afterwards is refused (write a NEW migration instead).
//   - Won't run old code against a newer database by accident.
//   - SQLite: a consistent snapshot (VACUUM INTO) is taken before any pending
//     migration touches a database that has data, and is verified restorable.
//
// WRITING A MIGRATION: see migrations/README.md.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASELINE_VERSION = 1;
const MIGRATIONS_TABLE = "schema_migrations";
const KEEP_PRE_MIGRATION_SNAPSHOTS = 5;

class MigrationError extends Error {
  constructor(message, { version = null, cause = null } = {}) {
    super(message);
    this.name = "MigrationError";
    this.version = version;
    if (cause) this.cause = cause;
  }
}

// Line endings differ between a Windows checkout (autocrlf) and Linux CI/Docker;
// the same migration must hash the same everywhere.
function normalizeSource(fn) {
  return String(fn).replace(/\r\n?/g, "\n").trim();
}

function checksum(m) {
  return crypto
    .createHash("sha256")
    .update(`${m.version}|${m.name}|${normalizeSource(m.up.sqlite)}|${normalizeSource(m.up.postgres)}`)
    .digest("hex");
}

function validateMigrations(list) {
  let prev = BASELINE_VERSION;
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version <= BASELINE_VERSION) {
      throw new MigrationError(`Migration '${m.name}' has invalid version ${m.version} (must be an integer > ${BASELINE_VERSION})`);
    }
    if (typeof m.name !== "string" || !/^[a-z0-9_]+$/.test(m.name)) {
      throw new MigrationError(`Migration ${m.version} has an invalid name '${m.name}' (lowercase letters, digits, underscores)`);
    }
    if (typeof m.up?.sqlite !== "function" || typeof m.up?.postgres !== "function") {
      throw new MigrationError(`Migration ${m.version} (${m.name}) must define both up.sqlite and up.postgres`);
    }
    if (m.version <= prev) {
      throw new MigrationError(`Migration versions must be strictly increasing; ${m.version} (${m.name}) follows ${prev}`);
    }
    prev = m.version;
  }
}

// Pure decision function: given what's known and what's recorded, what runs?
// Throws on anything that means "do not touch this database".
function planMigrations(migrations, appliedRows, { allowNewer = false } = {}) {
  const known = new Map(migrations.map((m) => [m.version, m]));
  const applied = new Map(appliedRows.map((r) => [Number(r.version), r]));
  const maxKnown = migrations.length ? migrations[migrations.length - 1].version : BASELINE_VERSION;

  const newer = [...applied.keys()].filter((v) => v > maxKnown);
  if (newer.length && !allowNewer) {
    throw new MigrationError(
      `This database is at schema version ${Math.max(...newer)} but this build only knows up to ${maxKnown}. ` +
        `Refusing to start an older build against a newer database. Upgrade the application, or set ` +
        `FINOPS_ALLOW_NEWER_SCHEMA=true if you are certain the newer changes are backward-compatible.`
    );
  }

  for (const [v, row] of applied) {
    if (v === BASELINE_VERSION || !known.has(v)) continue;
    const expected = checksum(known.get(v));
    if (row.checksum !== expected) {
      throw new MigrationError(
        `Migration ${v} (${row.name}) was modified after it was applied to this database ` +
          `(recorded checksum ${String(row.checksum).slice(0, 8)}, current ${expected.slice(0, 8)}). ` +
          `Applied migrations are immutable - revert the edit and add a new migration instead.`,
        { version: v }
      );
    }
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  const appliedHighest = Math.max(BASELINE_VERSION, ...[...applied.keys()].filter((v) => known.has(v)));
  const skipped = pending.filter((m) => m.version < appliedHighest);
  if (skipped.length) {
    throw new MigrationError(
      `Migration ${skipped[0].version} (${skipped[0].name}) is not applied, but a later one is. ` +
        `Migrations must be applied in order; this database's history has a gap.`,
      { version: skipped[0].version }
    );
  }
  return { pending, applied };
}

function loadDefaultMigrations() {
  return require("./migrations");
}

// ------------------------------------------------------------------ SQLite ---
// Synchronous on purpose: node:sqlite is synchronous, and storage/sqlite.js
// exposes `ready: Promise.resolve()` - anything that touches the database right
// after require() must already see the fully migrated schema.

function sqliteCtx(raw) {
  return {
    dialect: "sqlite",
    exec: (sql) => raw.exec(sql),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    tableExists: (t) => Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t)),
    columnExists: (t, c) => raw.prepare(`PRAGMA table_info(${t})`).all().some((col) => col.name === c),
  };
}

function sqlQuote(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

function hasUserData(raw) {
  for (const t of ["usage_events", "api_keys", "budgets", "users"]) {
    const exists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    if (exists && raw.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()) return true;
  }
  return false;
}

function takePreMigrationSnapshot(raw, { dbPath, backupDir, fromVersion, toVersion, now }) {
  const dir = backupDir || path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `pre-migration-v${fromVersion}-to-v${toVersion}-${stamp}.db`);
  // VACUUM INTO writes a complete, consistent, WAL-free copy even while other
  // connections are writing - a plain file copy of a WAL-mode database is not.
  raw.exec(`VACUUM INTO ${sqlQuote(file)}`);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith("pre-migration-") && f.endsWith(".db")).sort().reverse();
  for (const old of kept.slice(KEEP_PRE_MIGRATION_SNAPSHOTS)) {
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* best effort */ }
  }
  return file;
}

function runSqlite(raw, opts = {}) {
  const {
    migrations = loadDefaultMigrations(),
    dbPath = null,
    backupDir = null,
    allowNewer = process.env.FINOPS_ALLOW_NEWER_SCHEMA === "true",
    snapshot = process.env.FINOPS_SKIP_PREMIGRATION_BACKUP !== "true",
    log = { info() {}, warn() {} },
    now = () => new Date(),
    hooks = {}, // test seam: hooks.afterPlan() runs once pending work is decided, before any of it is applied
  } = opts;

  validateMigrations(migrations);
  raw.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  raw
    .prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, 'baseline', 'baseline', ?)`)
    .run(BASELINE_VERSION, now().toISOString());

  const readApplied = () => raw.prepare(`SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`).all();
  const { pending } = planMigrations(migrations, readApplied(), { allowNewer });
  if (pending.length === 0) return { applied: [], snapshot: null, version: Math.max(...readApplied().map((r) => r.version)) };

  let snapshotFile = null;
  if (snapshot && dbPath && dbPath !== ":memory:" && hasUserData(raw)) {
    const fromVersion = Math.max(...readApplied().map((r) => Number(r.version)));
    try {
      snapshotFile = takePreMigrationSnapshot(raw, { dbPath, backupDir, fromVersion, toVersion: pending[pending.length - 1].version, now });
      log.info("Pre-migration snapshot written", { snapshotFile });
    } catch (err) {
      throw new MigrationError(
        `Could not write the pre-migration safety snapshot (${err.message}). Refusing to migrate without it. ` +
          `Free disk space, or set FINOPS_SKIP_PREMIGRATION_BACKUP=true to proceed at your own risk.`,
        { cause: err }
      );
    }
  }

  if (typeof hooks.afterPlan === "function") hooks.afterPlan();

  const ctx = sqliteCtx(raw);
  const applied = [];
  for (const m of pending) {
    // IMMEDIATE takes the write lock up front, so two processes starting at once
    // serialize here; the second re-checks inside the lock and skips.
    raw.exec("BEGIN IMMEDIATE");
    try {
      if (!raw.prepare(`SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE version = ?`).get(m.version)) {
        m.up.sqlite(ctx);
        raw
          .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`)
          .run(m.version, m.name, checksum(m), now().toISOString());
        applied.push({ version: m.version, name: m.name });
      }
      raw.exec("COMMIT");
    } catch (err) {
      try { raw.exec("ROLLBACK"); } catch { /* connection may already be gone */ }
      throw new MigrationError(`Migration ${m.version} (${m.name}) failed and was rolled back: ${err.message}`, { version: m.version, cause: err });
    }
    log.info("Applied migration", { version: m.version, name: m.name });
  }
  return { applied, snapshot: snapshotFile, version: pending[pending.length - 1].version };
}

// Open a database FILE, migrate it, close it. Used to prove a backup is usable
// by the current code (verify/restore) without touching a live database.
function migrateSqliteFile(file, opts = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    return runSqlite(db, { snapshot: false, ...opts });
  } finally {
    db.close();
  }
}

// ----------------------------------------------------------------- Postgres ---

function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function postgresCtx(client) {
  return {
    dialect: "postgres",
    exec: (sql) => client.query(sql),
    all: async (sql, params = []) => (await client.query(toPositional(sql), params)).rows,
    get: async (sql, params = []) => (await client.query(toPositional(sql), params)).rows[0],
    run: async (sql, params = []) => {
      const r = await client.query(toPositional(sql), params);
      return { changes: r.rowCount };
    },
    tableExists: async (t) =>
      (await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1", [t])).rowCount > 0,
    columnExists: async (t, c) =>
      (await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
        [t, c]
      )).rowCount > 0,
  };
}

async function runPostgres(pool, opts = {}) {
  const {
    migrations = loadDefaultMigrations(),
    allowNewer = process.env.FINOPS_ALLOW_NEWER_SCHEMA === "true",
    log = { info() {}, warn() {} },
    now = () => new Date(),
  } = opts;
  validateMigrations(migrations);

  const client = await pool.connect();
  const lockSql = "SELECT pg_advisory_lock(hashtext('finops_migrations:' || current_schema()))";
  const unlockSql = "SELECT pg_advisory_unlock(hashtext('finops_migrations:' || current_schema()))";
  try {
    // Held for the whole run, per schema: two instances booting together
    // serialize here, and the second finds nothing pending.
    await client.query(lockSql);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`
      );
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES ($1, 'baseline', 'baseline', $2) ON CONFLICT (version) DO NOTHING`,
        [BASELINE_VERSION, now().toISOString()]
      );
      const readApplied = async () => (await client.query(`SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`)).rows;
      const { pending } = planMigrations(migrations, await readApplied(), { allowNewer });
      if (pending.length === 0) return { applied: [], version: Math.max(...(await readApplied()).map((r) => r.version)) };

      log.warn("Applying Postgres migrations - take a pg_dump / snapshot BEFORE deploying schema changes; there is no automatic snapshot on Postgres", {
        pending: pending.map((m) => m.version),
      });
      const ctx = postgresCtx(client);
      const applied = [];
      for (const m of pending) {
        await client.query("BEGIN");
        try {
          await m.up.postgres(ctx);
          await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)`, [
            m.version, m.name, checksum(m), now().toISOString(),
          ]);
          await client.query("COMMIT");
        } catch (err) {
          try { await client.query("ROLLBACK"); } catch { /* connection may already be gone */ }
          throw new MigrationError(`Migration ${m.version} (${m.name}) failed and was rolled back: ${err.message}`, { version: m.version, cause: err });
        }
        applied.push({ version: m.version, name: m.name });
        log.info("Applied migration", { version: m.version, name: m.name });
      }
      return { applied, version: pending[pending.length - 1].version };
    } finally {
      try { await client.query(unlockSql); } catch { /* released with the session anyway */ }
    }
  } finally {
    client.release();
  }
}

module.exports = {
  BASELINE_VERSION,
  MIGRATIONS_TABLE,
  MigrationError,
  checksum,
  validateMigrations,
  planMigrations,
  runSqlite,
  runPostgres,
  migrateSqliteFile,
  loadDefaultMigrations,
};
