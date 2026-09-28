// test/accountRecovery.test.js - P0: self-service forgot-password + email
// verification (users.js/tenantUsers.js, accountEmail.js, and the new
// routes in routes/auth.js).
//
// Single-tenant coverage runs always, using a mocked SMTP transporter (see
// alertDelivery.js's _setTransporterForTesting) to capture what would have
// been emailed and pull the real token out of it - the same technique
// alertDelivery.test.js already uses for the alerts channel. Multi-tenant
// coverage is gated the same way the rest of the multi-tenant suite is (see
// tenants.test.js/multiTenantHardening.test.js) - only under
// FINOPS_DB_DRIVER=postgres, since the control plane requires Postgres.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-acctrecovery-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-acctrecovery-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_acctrecovery_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const authRoute = require("../server/routes/auth");
const { _setTransporterForTesting } = require("../server/alertDelivery");
const { requestPasswordReset } = require("../server/users");

let server;
let capturedMail = null;

test.before(async () => {
  await storage.ready;
  _setTransporterForTesting({
    sendMail: async (mail) => {
      capturedMail = mail;
      return { messageId: "test" };
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});

test.after(async () => {
  _setTransporterForTesting(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[accountRecovery.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

function request(pathName, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: pathName,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractToken(mail) {
  assert.ok(mail, "expected an email to have been captured");
  const match = mail.text.match(/token=([a-f0-9]{64})/);
  assert.ok(match, "expected a token= link in the email body");
  return match[1];
}

// ---- Bootstrap + registration: email is optional ----

test("bootstrap registration works without an email (email is optional, not required)", async () => {
  const res = await request("/api/auth/register", { body: { username: "boss", password: "bosspassword1" } });
  assert.equal(res.status, 201);
  assert.equal(res.json.email, null);
  assert.equal(capturedMail, null, "no email on file -> nothing to verify -> no mail sent");
});

let bossToken;
test("log in as bootstrap admin to create a second user WITH an email", async () => {
  const res = await request("/api/auth/login", { body: { username: "boss", password: "bosspassword1" } });
  assert.equal(res.status, 200);
  bossToken = res.json.token;
});

test("registering a user with a malformed email is rejected; a well-formed one sends a verification email", async () => {
  const bad = await request("/api/auth/register", {
    headers: { "X-Session-Token": bossToken },
    body: { username: "alice", password: "alicepassword1", email: "not-an-email" },
  });
  assert.equal(bad.status, 400);

  capturedMail = null;
  const res = await request("/api/auth/register", {
    headers: { "X-Session-Token": bossToken },
    body: { username: "alice", password: "alicepassword1", email: "alice@example.com" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.email, "alice@example.com");
  assert.ok(capturedMail, "expected a verification email to have been sent on registration");
  assert.equal(capturedMail.to, "alice@example.com");
  assert.match(capturedMail.subject, /verify/i);
  capturedMail = null; // this test's own token is deliberately not used further below
});

// ---- Email verification ----

test("verify-email: a bogus token is refused", async () => {
  const res = await request("/api/auth/verify-email", { body: { token: "not-a-real-token" } });
  assert.equal(res.status, 400);
});

let aliceVerifyToken;
test("resend-verification (still unverified) issues a fresh token and sends a new email", async () => {
  capturedMail = null;
  const res = await request("/api/auth/resend-verification", { body: { username: "alice" } });
  assert.equal(res.status, 200);
  assert.ok(capturedMail, "expected a resend verification email");
  aliceVerifyToken = extractToken(capturedMail);
});

test("verify-email: the real token verifies the account and cannot be reused", async () => {
  const res = await request("/api/auth/verify-email", { body: { token: aliceVerifyToken } });
  assert.equal(res.status, 200);

  const row = await storage.get("SELECT email_verified, verify_token_hash FROM users WHERE username = ?", ["alice"]);
  assert.equal(Number(row.email_verified), 1);
  assert.equal(row.verify_token_hash, null);

  const reuse = await request("/api/auth/verify-email", { body: { token: aliceVerifyToken } });
  assert.equal(reuse.status, 400);
});

test("resend-verification is a silent no-op once already verified - same generic response, no email sent", async () => {
  capturedMail = null;
  const res = await request("/api/auth/resend-verification", { body: { username: "alice" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(capturedMail, null);
});

// ---- Forgot / reset password ----

let aliceResetToken;
test("forgot-password for a known user WITH an email queues a reset email with the generic response", async () => {
  capturedMail = null;
  const res = await request("/api/auth/forgot-password", { body: { username: "alice" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.message, "If an account matching that request exists, an email has been sent.");
  assert.ok(capturedMail);
  assert.equal(capturedMail.to, "alice@example.com");
  aliceResetToken = extractToken(capturedMail);
});

test("forgot-password for an UNKNOWN username returns the EXACT SAME generic response and sends nothing", async () => {
  capturedMail = null;
  const res = await request("/api/auth/forgot-password", { body: { username: "no-such-user" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.message, "If an account matching that request exists, an email has been sent.");
  assert.equal(capturedMail, null, "an unknown username must never trigger an email attempt");
});

test("forgot-password for a user with NO email on file returns the same generic response and sends nothing", async () => {
  capturedMail = null;
  const res = await request("/api/auth/forgot-password", { body: { username: "boss" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(capturedMail, null);
});

test("reset-password: a bogus token is refused with a specific error (no enumeration concern redeeming a token)", async () => {
  const res = await request("/api/auth/reset-password", { body: { token: "not-a-real-token", newPassword: "brandnewpassword1" } });
  assert.equal(res.status, 400);
});

test("reset-password: newPassword under 8 characters is rejected WITHOUT consuming the token", async () => {
  const res = await request("/api/auth/reset-password", { body: { token: aliceResetToken, newPassword: "short" } });
  assert.equal(res.status, 400);
  // The token must still be valid after this - proven by the next test
  // successfully redeeming the very same token.
});

test("reset-password: the real, still-valid token resets the password, invalidates the old one, and can't be reused", async () => {
  const res = await request("/api/auth/reset-password", { body: { token: aliceResetToken, newPassword: "brandnewpassword1" } });
  assert.equal(res.status, 200);

  const loginOld = await request("/api/auth/login", { body: { username: "alice", password: "alicepassword1" } });
  assert.equal(loginOld.status, 401);
  const loginNew = await request("/api/auth/login", { body: { username: "alice", password: "brandnewpassword1" } });
  assert.equal(loginNew.status, 200);

  const reuse = await request("/api/auth/reset-password", { body: { token: aliceResetToken, newPassword: "anotherpassword12" } });
  assert.equal(reuse.status, 400);
});

// Seeded fresh here (after the successful reset above already consumed and
// cleared aliceResetToken) since there is only ever one live reset token per
// user - issuing this one is what the expiry gets manipulated on, not a
// second concurrent token.
test("reset-password: an EXPIRED token is refused (seeded directly, bypassing the rate-limited HTTP endpoint)", async () => {
  const seeded = await requestPasswordReset("alice");
  assert.ok(seeded, "alice has an email on file, so a token should be issued");
  await storage.run("UPDATE users SET reset_token_expires_at = ? WHERE username = ?", [
    new Date(Date.now() - 1000).toISOString(),
    "alice",
  ]);
  const res = await request("/api/auth/reset-password", { body: { token: seeded.token, newPassword: "wontmatterpassword1" } });
  assert.equal(res.status, 400);
});

test("reset-password: an existing dashboard session is invalidated by a self-service reset", async () => {
  const login = await request("/api/auth/login", { body: { username: "alice", password: "brandnewpassword1" } });
  assert.equal(login.status, 200);
  const sessionToken = login.json.token;

  const seeded = await requestPasswordReset("alice");
  const reset = await request("/api/auth/reset-password", { body: { token: seeded.token, newPassword: "yetanotherpassword1" } });
  assert.equal(reset.status, 200);

  // The OLD session token must no longer work. logout() itself always
  // returns ok regardless of whether the token was valid (it's a
  // best-effort destroy), so assert against the session store directly.
  const { getSession } = require("../server/users");
  assert.equal(getSession(sessionToken), null, "the reset must have invalidated every existing session for that user");
});

// ---- Validation + rate limiting, in a FRESH isolated app/limiter ----
//
// The main app above deliberately used its forgot-password/resend-verification
// budget (5 calls total - see loginRateLimit.js's forgotPasswordRateLimit)
// exactly up to real behavioral tests above. Validation-error requests and
// the rate-limit-tripping test itself both also consume that same budget
// just by being received, so they get their own freshly-required app/route
// (a brand new in-memory attempts Map) rather than competing with the tests
// above for the same 5-request window - the same isolation technique
// alertDelivery.test.js uses (delete require.cache, re-require) for
// env/state-dependent modules.
test("isolated: validation errors and the forgot-password rate limit itself", async (t) => {
  delete require.cache[require.resolve("../server/loginRateLimit")];
  delete require.cache[require.resolve("../server/routes/auth")];
  const freshAuthRoute = require("../server/routes/auth");

  const app = express();
  app.use(express.json());
  app.use("/api/auth", freshAuthRoute);
  const freshServer = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  t.after(() => new Promise((resolve) => freshServer.close(resolve)));

  function freshRequest(pathName, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: freshServer.address().port,
          path: pathName,
          method: "POST",
          headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let json;
            try { json = JSON.parse(text); } catch {}
            resolve({ status: res.statusCode, json });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Validation - these still count against the limiter (it runs before the
  // handler), so this is call #1 of this fresh instance's 5-request budget.
  const missingUsername = await freshRequest("/api/auth/forgot-password", { body: {} });
  assert.equal(missingUsername.status, 400);

  const missingToken = await freshRequest("/api/auth/reset-password", { body: { newPassword: "somepassword1" } });
  assert.equal(missingToken.status, 400);
  const missingTokenVerify = await freshRequest("/api/auth/verify-email", { body: {} });
  assert.equal(missingTokenVerify.status, 400);

  // 4 more forgot-password calls (any body shape - doesn't matter, the
  // limiter counts requests, not outcomes) bring this instance to exactly 5.
  for (let i = 0; i < 4; i++) {
    const res = await freshRequest("/api/auth/forgot-password", { body: { username: `nobody-${i}` } });
    assert.equal(res.status, 200, `request ${i + 2} of 5 should still be allowed`);
  }

  // The 6th request in this window must be refused, not silently processed -
  // this is the actual defense against forgot-password being used as a spam
  // cannon or a timing/enumeration oracle at scale.
  const limited = await freshRequest("/api/auth/forgot-password", { body: { username: "one-too-many" } });
  assert.equal(limited.status, 429);
  assert.ok(limited.json.retryAfterSec > 0);
});
