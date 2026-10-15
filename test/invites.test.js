// test/invites.test.js - "invite a teammate" (single-tenant), driven through
// the REAL routes. Runs on both SQLite and Postgres.
//
// Rules under test (see server/invites.js and routes/invites.js for the why):
//   * the raw token is emailed, never returned by the API and never stored -
//     only its hash is;
//   * a token redeems exactly once, even under concurrent accepts;
//   * unknown / used / revoked / expired tokens are indistinguishable;
//   * request-shape errors never consume or reveal anything about the token;
//   * "username taken" gives the invitee their link back;
//   * an inviter can only grant roles whose permissions they hold;
//   * only admins can invite/list/revoke; re-inviting supersedes; bounded pending.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-invites-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-invites-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_invites_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const users = require("../server/users");
const invites = require("../server/invites");
const { _setTransporterForTesting } = require("../server/alertDelivery");

const delivered = [];
let smtpDown = false;
let adminToken;
let viewerToken;

test.before(async () => {
  await storage.ready;
  _setTransporterForTesting({
    sendMail: async (mail) => {
      if (smtpDown) throw new Error("smtp down");
      delivered.push(mail);
      return { messageId: "t" };
    },
  });
  await users.createUser({ username: "boss", password: "correct-horse-1", role: "admin" });
  await users.createUser({ username: "vera", password: "correct-horse-1", role: "viewer" });
  adminToken = users.createSession({ username: "boss", role: "admin" });
  viewerToken = users.createSession({ username: "vera", role: "viewer" });
});

test.after(async () => {
  _setTransporterForTesting(null);
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// Fresh router + limiter per test (the redeem limiter is 20 / 15 min / IP).
async function freshServer(t) {
  delete require.cache[require.resolve("../server/loginRateLimit")];
  delete require.cache[require.resolve("../server/routes/invites")];
  const route = require("../server/routes/invites");
  const app = express();
  app.use(express.json());
  app.use("/api/invites", route);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return function call(method, pathName, body, sessionToken) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      if (sessionToken) headers["X-Session-Token"] = sessionToken;
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers }, (r) => {
        let text = "";
        r.on("data", (c) => (text += c));
        r.on("end", () => resolve({ status: r.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
}

const tokenFrom = (mail) => /token=([0-9a-f]{64})/.exec(mail.text)[1];
const rowFor = (email) => storage.get("SELECT * FROM invites WHERE email = ? ORDER BY id DESC", [email]);

async function invite(call, email, role = "viewer") {
  delivered.length = 0;
  const res = await call("POST", "/api/invites", { email, role }, adminToken);
  assert.equal(res.status, 201, res.text);
  return { res, token: tokenFrom(delivered[0]) };
}

test("creating an invite emails a link; the token is never returned and only its hash is stored", async (t) => {
  const call = await freshServer(t);
  const { res, token } = await invite(call, "  Newbie@Example.COM ", "developer");
  assert.equal(res.json.email, "newbie@example.com", "address is stored normalised");
  assert.equal(res.json.email_sent, true);
  assert.equal(delivered[0].to, "newbie@example.com");
  assert.match(delivered[0].text, /accept-invite\.html\?token=[0-9a-f]{64}/);
  assert.ok(!res.text.includes(token), "the API response must not contain the raw token");
  const row = await rowFor("newbie@example.com");
  assert.ok(!JSON.stringify(row).includes(token), "the raw token must not be stored");
  assert.equal(row.token_hash, require("../server/tokenHash").hashToken(token));
  const listed = await call("GET", "/api/invites", undefined, adminToken);
  assert.equal(listed.status, 200);
  assert.ok(listed.json.some((i) => i.email === "newbie@example.com"));
  assert.ok(!listed.text.includes(token) && !listed.text.includes(row.token_hash), "list must expose neither token nor hash");
});

test("accepting creates the account with the invited email and role, verified, and the token is single use", async (t) => {
  const call = await freshServer(t);
  const { token } = await invite(call, "ann@example.com", "developer");
  const ok = await call("POST", "/api/invites/accept", { token, username: "ann", password: "correct-horse-2" });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.role, "developer");
  const user = await storage.get("SELECT * FROM users WHERE username = ?", ["ann"]);
  assert.equal(user.email, "ann@example.com");
  assert.equal(user.role, "developer");
  assert.equal(Number(user.email_verified), 1, "the invite link proved control of the address");
  assert.ok(await users.verifyLogin("ann", "correct-horse-2"), "the chosen password works");

  const again = await call("POST", "/api/invites/accept", { token, username: "ann2", password: "correct-horse-2" });
  assert.equal(again.status, 400);
  assert.equal(await storage.get("SELECT 1 AS x FROM users WHERE username = ?", ["ann2"]), undefined);
});

test("unknown, used, revoked and expired tokens all get the SAME response", async (t) => {
  const call = await freshServer(t);
  const body = (token) => ({ token, username: "zed", password: "correct-horse-2" });

  const unknown = await call("POST", "/api/invites/accept", body("f".repeat(64)));

  const used = await invite(call, "used@example.com");
  await call("POST", "/api/invites/accept", { token: used.token, username: "used1", password: "correct-horse-2" });
  const usedRes = await call("POST", "/api/invites/accept", body(used.token));

  const revoked = await invite(call, "revoked@example.com");
  const rid = (await rowFor("revoked@example.com")).id;
  assert.equal((await call("DELETE", `/api/invites/${rid}`, undefined, adminToken)).status, 200);
  const revokedRes = await call("POST", "/api/invites/accept", body(revoked.token));

  const expired = await invite(call, "expired@example.com");
  await storage.run("UPDATE invites SET expires_at = ? WHERE email = ?", ["2000-01-01T00:00:00.000Z", "expired@example.com"]);
  const expiredRes = await call("POST", "/api/invites/accept", body(expired.token));

  for (const r of [unknown, usedRes, revokedRes, expiredRes]) assert.equal(r.status, 400);
  for (const r of [usedRes, revokedRes, expiredRes]) assert.equal(r.text, unknown.text);
  assert.equal(await storage.get("SELECT 1 AS x FROM users WHERE username = ?", ["zed"]), undefined);
});

test("shape errors are decided before the token and do not consume it", async (t) => {
  const call = await freshServer(t);
  const { token } = await invite(call, "shape@example.com");
  const short = await call("POST", "/api/invites/accept", { token, username: "shape", password: "short" });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /8 characters/);
  const same = await call("POST", "/api/invites/accept", { token: "nope", username: "shape", password: "short" });
  assert.equal(same.text, short.text, "a bad password gets the same answer whatever the token");
  const ok = await call("POST", "/api/invites/accept", { token, username: "shape", password: "correct-horse-2" });
  assert.equal(ok.status, 201, "the token was not burned by the failed attempts");
  const missing = await call("POST", "/api/invites/accept", { username: "x", password: "correct-horse-2" });
  assert.equal(missing.status, 400);
});

test("a taken username returns 409 and gives the invitee their link back", async (t) => {
  const call = await freshServer(t);
  const { token } = await invite(call, "dup@example.com");
  const taken = await call("POST", "/api/invites/accept", { token, username: "boss", password: "correct-horse-2" });
  assert.equal(taken.status, 409);
  const retry = await call("POST", "/api/invites/accept", { token, username: "dup-user", password: "correct-horse-2" });
  assert.equal(retry.status, 201, "the same link still works with a different username");
});

test("concurrent accepts of one token: exactly one wins", async (t) => {
  const call = await freshServer(t);
  const { token } = await invite(call, "race@example.com", "developer");
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => call("POST", "/api/invites/accept", { token, username: `racer${i}`, password: "correct-horse-2" }))
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(","));
  assert.equal(results.filter((r) => r.status === 400).length, 5);
  const made = await storage.all("SELECT username FROM users WHERE email = ?", ["race@example.com"]);
  assert.equal(made.length, 1, "exactly one account created from one invite");
});

test("expiry is enforced atomically at consume time, not just when peeked", async () => {
  const sharedDb = storage;
  const store = invites.singleTenantInvites(sharedDb);
  const created = await store.create({ email: "late@example.com", role: "viewer", invitedBy: "t", inviterRole: "admin" });
  const row = await invites.peek(sharedDb, created.token);
  assert.ok(row, "valid at peek time");
  await storage.run("UPDATE invites SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", row.id]);
  assert.equal(await invites.consume(sharedDb, row), false, "expired between peek and consume -> refused");
});

test("consume succeeds for exactly one caller even when both hold a stale 'redeemable' row", async () => {
  // Both callers peeked before either consumed - the situation two concurrent
  // accepts are in. The conditional UPDATE, not peek(), is what stops the second.
  const store = invites.singleTenantInvites(storage);
  const created = await store.create({ email: "twice@example.com", role: "viewer", invitedBy: "t", inviterRole: "admin" });
  const a = await invites.peek(storage, created.token);
  const b = await invites.peek(storage, created.token);
  assert.ok(a && b);
  assert.equal(await invites.consume(storage, a), true);
  assert.equal(await invites.consume(storage, b), false, "second consume of the same invite must be refused");
  await invites.restore(storage, a);
  assert.equal(await invites.consume(storage, b), true, "restore() makes it redeemable again");
});

test("canGrantRole: an inviter can only grant roles whose permissions they already hold", () => {
  const { canGrantRole } = invites;
  for (const r of ["admin", "budget-manager", "developer", "viewer", "auditor"]) {
    assert.equal(canGrantRole("admin", r), true, `admin -> ${r}`);
  }
  assert.equal(canGrantRole("admin", "agent"), false, "machine role is never a dashboard role");
  assert.equal(canGrantRole("viewer", "admin"), false);
  assert.equal(canGrantRole("developer", "budget-manager"), false);
  assert.equal(canGrantRole("budget-manager", "viewer"), true, "read is a subset of budget-manager's permissions");
  assert.equal(canGrantRole("developer", "auditor"), false);
  assert.equal(canGrantRole("nonexistent", "viewer"), false);
  assert.equal(canGrantRole("admin", "superuser"), false);
});

test("roles: unknown/machine roles are refused and non-admins cannot invite, list or revoke", async (t) => {
  const call = await freshServer(t);
  delivered.length = 0;
  const agent = await call("POST", "/api/invites", { email: "a1@example.com", role: "agent" }, adminToken);
  assert.equal(agent.status, 403);
  const bogus = await call("POST", "/api/invites", { email: "a2@example.com", role: "superuser" }, adminToken);
  assert.equal(bogus.status, 403);
  assert.equal(delivered.length, 0, "nothing is mailed for a refused invite");

  assert.equal((await call("POST", "/api/invites", { email: "v@example.com" }, viewerToken)).status, 403);
  assert.equal((await call("GET", "/api/invites", undefined, viewerToken)).status, 403);
  assert.equal((await call("DELETE", "/api/invites/1", undefined, viewerToken)).status, 403);
  assert.equal((await call("POST", "/api/invites", { email: "anon@example.com" })).status, 401, "anonymous cannot invite");
  assert.equal((await call("POST", "/api/invites", { email: "not-an-email" }, adminToken)).status, 400);
});

test("revoke: works once, then 404s; unknown ids 404 too", async (t) => {
  const call = await freshServer(t);
  await invite(call, "rev@example.com");
  const id = (await rowFor("rev@example.com")).id;
  assert.equal((await call("DELETE", `/api/invites/${id}`, undefined, adminToken)).status, 200);
  assert.equal((await call("DELETE", `/api/invites/${id}`, undefined, adminToken)).status, 404);
  assert.equal((await call("DELETE", "/api/invites/99999999", undefined, adminToken)).status, 404);
  assert.equal((await call("DELETE", "/api/invites/abc", undefined, adminToken)).status, 404);
  const listed = await call("GET", "/api/invites", undefined, adminToken);
  assert.ok(!listed.json.some((i) => i.id === id), "revoked invites are not listed");
});

test("re-inviting an address supersedes the older link", async (t) => {
  const call = await freshServer(t);
  const first = await invite(call, "again@example.com");
  const second = await invite(call, "AGAIN@example.com");
  const old = await call("POST", "/api/invites/accept", { token: first.token, username: "again1", password: "correct-horse-2" });
  assert.equal(old.status, 400, "the older link no longer works");
  const fresh = await call("POST", "/api/invites/accept", { token: second.token, username: "again2", password: "correct-horse-2" });
  assert.equal(fresh.status, 201);
});

test("pending invites are capped", async (t) => {
  const call = await freshServer(t);
  await storage.run("DELETE FROM invites");
  const store = invites.singleTenantInvites(storage);
  for (let i = 0; i < invites.MAX_PENDING_INVITES; i++) {
    await store.create({ email: `cap${i}@example.com`, role: "viewer", invitedBy: "t", inviterRole: "admin" });
  }
  delivered.length = 0;
  const over = await call("POST", "/api/invites", { email: "overflow@example.com" }, adminToken);
  assert.equal(over.status, 429);
  assert.equal(delivered.length, 0);
  // Re-inviting an address that already has a pending invite swaps it, so it is still allowed.
  const swap = await call("POST", "/api/invites", { email: "cap0@example.com" }, adminToken);
  assert.equal(swap.status, 201);
  await storage.run("DELETE FROM invites");
});

test("a failing mail transport does not fail the request; the admin is told", async (t) => {
  const call = await freshServer(t);
  smtpDown = true;
  try {
    const res = await call("POST", "/api/invites", { email: "nosmtp@example.com" }, adminToken);
    assert.equal(res.status, 201);
    assert.equal(res.json.email_sent, false);
    assert.ok(await rowFor("nosmtp@example.com"), "the invite still exists");
  } finally {
    smtpDown = false;
  }
});
