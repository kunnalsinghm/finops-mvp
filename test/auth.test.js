// test/auth.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-auth-*.db* files from a PREVIOUS run of this
// file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-auth-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-auth-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise. This file doesn't
// actually touch the database beyond teardown, but the isolation is added
// consistently across every test file regardless, so none of them are an
// exception that could later be missed if the file grows DB-touching tests.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_auth_${process.pid}`;
}

const db = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    // storage.ready is a background schema-creation promise kicked off the
    // moment ../server/storage was required above, regardless of whether
    // this file's tests ever actually query anything. Files that DO query
    // (via storage.get/all/run) always end up awaiting this internally
    // before their first query, so by teardown time it's long since
    // resolved. This file never queries anything, so without this explicit
    // await, pool.end() below could run WHILE that background query is
    // still in flight, producing "Cannot use a pool after calling end on
    // the pool" as an unhandled rejection after the test already finished.
    try {
      await storage.ready;
    } catch {
      // If schema init itself failed, there's nothing further to await -
      // proceed to drop/end below regardless.
    }
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[auth.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const { hasPermission, ROLE_PERMISSIONS } = require("../server/auth");

test("admin has every defined permission", () => {
  const allPermissions = new Set(Object.values(ROLE_PERMISSIONS).flat());
  for (const perm of allPermissions) {
    assert.equal(hasPermission("admin", perm), true, `admin should have '${perm}'`);
  }
});

test("viewer only has read permission", () => {
  assert.equal(hasPermission("viewer", "read"), true);
  assert.equal(hasPermission("viewer", "write"), false);
  assert.equal(hasPermission("viewer", "manage_keys"), false);
  assert.equal(hasPermission("viewer", "manage_budgets"), false);
  assert.equal(hasPermission("viewer", "approve_quarantine"), false);
});

test("developer can read and write but not manage keys or budgets", () => {
  assert.equal(hasPermission("developer", "read"), true);
  assert.equal(hasPermission("developer", "write"), true);
  assert.equal(hasPermission("developer", "manage_keys"), false);
  assert.equal(hasPermission("developer", "manage_budgets"), false);
});

test("budget-manager can manage budgets but not keys", () => {
  assert.equal(hasPermission("budget-manager", "manage_budgets"), true);
  assert.equal(hasPermission("budget-manager", "manage_keys"), false);
  assert.equal(hasPermission("budget-manager", "write"), false);
});

test("hasPermission returns false for an unknown role rather than throwing", () => {
  assert.equal(hasPermission("nonexistent-role", "read"), false);
});
