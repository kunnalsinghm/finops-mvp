// test/auth.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-auth-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
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
