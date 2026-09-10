// test/users.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-users-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const {
  createUser,
  verifyLogin,
  createSession,
  getSession,
  destroySession,
  resetPassword,
} = require("../server/users");

test("createUser inserts a new user with a hashed password, not plaintext", async () => {
  await createUser({ username: "alice", password: "correct-horse-battery", role: "viewer" });
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get("alice");
  assert.ok(row, "expected the user row to exist");
  assert.equal(row.role, "viewer");
  assert.notEqual(row.password_hash, "correct-horse-battery");
  assert.ok(row.salt, "expected a salt to be stored");
});

test("createUser defaults to the viewer role when none is given", async () => {
  await createUser({ username: "bob", password: "whatever123" });
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get("bob");
  assert.equal(row.role, "viewer");
});

test("verifyLogin returns the user on correct credentials", async () => {
  const user = await verifyLogin("alice", "correct-horse-battery");
  assert.ok(user);
  assert.equal(user.username, "alice");
});

test("verifyLogin returns null on wrong password", async () => {
  const user = await verifyLogin("alice", "wrong-password");
  assert.equal(user, null);
});

test("verifyLogin returns null for a username that doesn't exist", async () => {
  const user = await verifyLogin("nobody", "anything");
  assert.equal(user, null);
});

test("createSession/getSession round-trip a valid, non-expired session", async () => {
  const user = await verifyLogin("alice", "correct-horse-battery");
  const token = createSession(user);
  const session = getSession(token);
  assert.ok(session);
  assert.equal(session.username, "alice");
  assert.equal(session.role, "viewer");
});

test("getSession returns null for an unknown token", () => {
  assert.equal(getSession("not-a-real-token"), null);
});

test("destroySession invalidates a session immediately", async () => {
  const user = await verifyLogin("alice", "correct-horse-battery");
  const token = createSession(user);
  assert.ok(getSession(token));
  destroySession(token);
  assert.equal(getSession(token), null);
});

test("resetPassword changes the password - old password stops working, new one works", async () => {
  await createUser({ username: "carol", password: "old-password-1", role: "developer" });
  const initial = await verifyLogin("carol", "old-password-1");
  assert.ok(initial);

  await resetPassword("carol", "new-password-2");

  const failedOld = await verifyLogin("carol", "old-password-1");
  assert.equal(failedOld, null, "old password should no longer work");

  const succeededNew = await verifyLogin("carol", "new-password-2");
  assert.ok(succeededNew, "new password should work");
});

test("resetPassword invalidates all existing sessions for that user", async () => {
  await createUser({ username: "dave", password: "pw-one", role: "viewer" });
  const user = await verifyLogin("dave", "pw-one");
  const token = createSession(user);
  assert.ok(getSession(token));

  await resetPassword("dave", "pw-two");

  assert.equal(getSession(token), null, "old session should be invalidated by password reset");
});

test("resetPassword throws for a user that doesn't exist", async () => {
  await assert.rejects(resetPassword("ghost-user", "whatever"), /User not found/);
});
