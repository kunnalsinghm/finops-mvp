// test/forgotPasswordByEmail.test.js - POST /api/auth/forgot-password accepts
// { email } as an alternative to { username } (single-tenant).
//
// Rules under test (see users.js requestPasswordResetByEmail for the why):
//   * the generic response is byte-identical for EVERY outcome - match,
//     unknown email, unverified email;
//   * only a VERIFIED email address can trigger a reset by email;
//   * matching ignores case and surrounding whitespace;
//   * one address on several accounts -> one email per account (capped),
//     each with its own token and naming its own account;
//   * username and email are mutually exclusive; bad input is a 400, never 500;
//   * like the username path, the response never waits on SMTP.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-forgotbyemail-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-forgotbyemail-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_forgotbyemail_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const users = require("../server/users");
const { _setTransporterForTesting } = require("../server/alertDelivery");

// DETERMINISTIC - no clock. While a gate is held the simulated SMTP send is
// blocked, so a route that AWAITED the send could not respond until the test
// opens the gate. A response arriving while the gate is still shut proves the
// route did not wait on SMTP. (An earlier version asserted "responds in under
// 300 ms"; that is a wall-clock threshold and false-failed on a loaded machine
// running the whole suite in parallel.)
let gate = null;
function holdSmtp() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  gate = { promise, open };
  return gate;
}
const RESPONSE_TIMEOUT_MS = 8000; // only ever waited out when the route is broken
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
const BLOCKED_MSG =
  "no response while the SMTP send was blocked - the route is awaiting the mail send, " +
  "which lets an anonymous caller enumerate accounts by response time";
const delivered = [];

test.before(async () => {
  await storage.ready;
  _setTransporterForTesting({
    sendMail: async (mail) => {
      if (gate) await gate.promise;
      delivered.push(mail);
      return { messageId: "t" };
    },
  });
  // Created through the real functions; "verified" via the real verify path.
  await mkUser("alice", "alice@example.com", { verified: true });
  await mkUser("unverified-una", "una@example.com", { verified: false });
  await mkUser("noemail", null);
  // One address, several accounts (email has no UNIQUE constraint).
  await mkUser("shared-one", "team@example.com", { verified: true });
  await mkUser("shared-two", "Team@Example.com", { verified: true }); // different case on purpose
  // Seven accounts on one address - exceeds the per-request fan-out cap.
  for (let i = 1; i <= 7; i++) await mkUser(`crowd-${i}`, "crowd@example.com", { verified: true });
  delivered.length = 0;
});

async function mkUser(username, email, { verified = false } = {}) {
  const { verifyToken } = await users.createUser({ username, password: "correct-horse-1", role: "viewer", email });
  if (email && verified) await users.verifyEmailToken(verifyToken);
}

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

// Fresh router + limiter per test (5 req / 15 min / IP budget otherwise shared).
async function freshServer(t) {
  delete require.cache[require.resolve("../server/loginRateLimit")];
  delete require.cache[require.resolve("../server/routes/auth")];
  const authRoute = require("../server/routes/auth");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoute);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async function post(pathName, body) {
    const started = process.hrtime.bigint();
    const res = await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { hostname: "127.0.0.1", port: server.address().port, path: pathName, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (r) => {
          let text = "";
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve({ status: r.statusCode, text }));
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    return { ...res, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const tokenFrom = (mail) => /token=([0-9a-f]{64})/.exec(mail.text)[1];

test("a verified email triggers a reset email to that address", async (t) => {
  const post = await freshServer(t);
  delivered.length = 0;
  const res = await post("/api/auth/forgot-password", { email: "alice@example.com" });
  assert.equal(res.status, 200, res.text);
  assert.ok(await waitFor(() => delivered.length === 1), "expected exactly one reset email");
  assert.equal(delivered[0].to, "alice@example.com");
  assert.match(delivered[0].text, /reset-password\.html\?token=[0-9a-f]{64}/);
  assert.match(delivered[0].text, /alice/, "the email must name the account it is for");
});

test("generic response is BYTE-IDENTICAL for match, unknown email, and unverified email - and only the match sends mail", async (t) => {
  const post = await freshServer(t);
  delivered.length = 0;
  const match = await post("/api/auth/forgot-password", { email: "alice@example.com" });
  await waitFor(() => delivered.length === 1);
  delivered.length = 0;

  const unknown = await post("/api/auth/forgot-password", { email: "nobody@example.com" });
  const unverified = await post("/api/auth/forgot-password", { email: "una@example.com" });
  for (const r of [match, unknown, unverified]) assert.equal(r.status, 200, r.text);
  assert.equal(unknown.text, match.text);
  assert.equal(unverified.text, match.text);

  // ...and identical to what the USERNAME path says, so a caller can't even
  // tell which lookup path was used.
  const byUsername = await post("/api/auth/forgot-password", { username: "ghost" });
  assert.equal(byUsername.text, match.text);

  await settle();
  assert.equal(delivered.length, 0, "unknown and unverified addresses must not receive mail");
});

test("matching ignores case and surrounding whitespace in the supplied address", async (t) => {
  const post = await freshServer(t);
  delivered.length = 0;
  const res = await post("/api/auth/forgot-password", { email: "  ALICE@Example.COM \t" });
  assert.equal(res.status, 200, res.text);
  assert.ok(await waitFor(() => delivered.length === 1), "case/whitespace variant should still match");
  assert.equal(delivered[0].to, "alice@example.com");
});

test("one address on several accounts: one email per account, each with its own token naming its own account", async (t) => {
  const post = await freshServer(t);
  delivered.length = 0;
  await post("/api/auth/forgot-password", { email: "team@example.com" });
  assert.ok(await waitFor(() => delivered.length === 2), `expected 2 emails, got ${delivered.length}`);
  await settle();
  assert.equal(delivered.length, 2);

  const byAccount = {};
  for (const mail of delivered) {
    const name = /shared-(one|two)/.exec(mail.text)?.[0];
    assert.ok(name, `each mail must name its account: ${mail.text}`);
    byAccount[name] = tokenFrom(mail);
  }
  assert.notEqual(byAccount["shared-one"], byAccount["shared-two"], "each account needs its own token");

  // Each token resets ONLY its own account.
  const who1 = await users.resetPasswordWithToken(byAccount["shared-one"], "fresh-pass-one-1");
  assert.equal(who1, "shared-one");
  assert.ok(await users.verifyLogin("shared-one", "fresh-pass-one-1"));
  assert.equal(await users.verifyLogin("shared-two", "fresh-pass-one-1"), null, "other account must be untouched");
  assert.ok(await users.verifyLogin("shared-two", "correct-horse-1"));
});

test("fan-out is capped: an address on 7 accounts yields at most 5 emails per request", async (t) => {
  const post = await freshServer(t);
  delivered.length = 0;
  await post("/api/auth/forgot-password", { email: "crowd@example.com" });
  await waitFor(() => delivered.length >= 5);
  await settle(300);
  assert.equal(delivered.length, 5);
});

test("end-to-end: token from an email-initiated reset sets the password, old one stops working, token is single-use", async (t) => {
  const post = await freshServer(t);
  delivered.length = 0;
  await post("/api/auth/forgot-password", { email: "alice@example.com" });
  assert.ok(await waitFor(() => delivered.length === 1));
  const token = tokenFrom(delivered[0]);

  const reset = await post("/api/auth/reset-password", { token, newPassword: "brand-new-pass-9" });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(await users.verifyLogin("alice", "correct-horse-1"), null);
  assert.ok(await users.verifyLogin("alice", "brand-new-pass-9"));
  const reuse = await post("/api/auth/reset-password", { token, newPassword: "another-pass-77" });
  assert.equal(reuse.status, 400);
});

test("input validation: neither / both / malformed / non-string are 400s, never 500s, and send nothing", async (t) => {
  const post = await freshServer(t);
  delivered.length = 0;
  // 5 requests = exactly this fresh limiter's whole budget.
  const cases = [
    {},
    { username: "alice", email: "alice@example.com" },
    { email: "not-an-email" },
    { email: { $ne: "x" } },
    { email: ["alice@example.com"] },
  ];
  for (const body of cases) {
    const r = await post("/api/auth/forgot-password", body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${r.status}: ${r.text}`);
  }
  await settle();
  assert.equal(delivered.length, 0);
});

test("the email path never waits on SMTP either (no timing oracle on the new lookup)", async (t) => {
  const g = holdSmtp(); // before freshServer: the gate must open before the server closes
  t.after(() => { gate = null; g.open(); });
  const post = await freshServer(t);
  delivered.length = 0;

  const hit = await withTimeout(post("/api/auth/forgot-password", { email: "alice@example.com" }), RESPONSE_TIMEOUT_MS, BLOCKED_MSG);
  const miss = await post("/api/auth/forgot-password", { email: "nobody@example.com" });
  assert.equal(hit.text, miss.text);
  assert.equal(delivered.length, 0, "the mail must still be in flight when the response arrives");
  g.open();
  assert.ok(await waitFor(() => delivered.length === 1));
});

test("an email-initiated request is audited as such, without recording the address", async (t) => {
  const post = await freshServer(t);
  await post("/api/auth/forgot-password", { email: "alice@example.com" });
  const row = await storage.get(
    "SELECT * FROM audit_log WHERE action = 'user.password_reset_requested' AND target = 'alice' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(row, "expected an audit row");
  assert.match(row.details, /"via":\s*"email"/);
  assert.doesNotMatch(row.details, /example\.com/, "audit details must not store the email address");
});

test("requestPasswordResetByEmail returns [] (not null/throw) when nothing matches or the address is unverified", async () => {
  assert.deepEqual(await users.requestPasswordResetByEmail("nobody@example.com"), []);
  assert.deepEqual(await users.requestPasswordResetByEmail("una@example.com"), []);
});
