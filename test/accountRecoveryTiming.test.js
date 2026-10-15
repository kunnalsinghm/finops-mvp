// test/accountRecoveryTiming.test.js - forgot-password / resend-verification
// must not be a TIMING oracle for account existence (single-tenant).
//
// routes/auth.js already returns byte-identical bodies for "no such user",
// "no email on file" and "email queued" (see its header). That is not enough
// on its own: if the match branch awaits the SMTP round-trip and the no-match
// branch doesn't, an anonymous caller can tell the two apart by response time
// alone (measured on the pre-fix code: ~4 ms for an unknown username vs
// ~310 ms for a real one with a 300 ms SMTP delay). These tests pin that the
// response no longer waits on the mail transport.
//
// Multi-tenant has its own routes and its own file:
// accountRecoveryMultiTenant.test.js (Postgres only).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-recoverytiming-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-recoverytiming-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_recoverytiming_${process.pid}`;

const legacyDb = require("../server/db");
const storage = require("../server/storage");
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
let smtpDelayMs = 0; // small fixed latency for the "SMTP outage" test only
let smtpFails = false;
const delivered = []; // mails whose simulated SMTP round-trip has COMPLETED

test.before(async () => {
  await storage.ready;
  _setTransporterForTesting({
    sendMail: async (mail) => {
      if (gate) await gate.promise;
      if (smtpDelayMs) await new Promise((r) => setTimeout(r, smtpDelayMs));
      if (smtpFails) throw new Error("simulated SMTP outage");
      delivered.push(mail);
      return { messageId: "t" };
    },
  });
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

// A fresh router + fresh rate-limiter per test: the forgot-password limiter
// allows 5 requests / 15 min / IP and is shared with resend-verification, so
// reusing one instance would make these tests depend on each other's budget.
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
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: pathName,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
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

test("setup: bootstrap an admin WITH an email (unverified)", async (t) => {
  const post = await freshServer(t);
  const res = await post("/api/auth/register", { username: "alice", password: "correct-horse-1", email: "alice@example.com" });
  assert.equal(res.status, 201, res.text);
  await waitFor(() => delivered.length >= 1); // the verification mail
  delivered.length = 0;
});

for (const [route, label] of [
  ["/api/auth/forgot-password", "forgot-password"],
  ["/api/auth/resend-verification", "resend-verification"],
]) {
  test(`${label}: a REAL account's response does not wait on SMTP (no timing oracle), and the mail is still delivered`, async (t) => {
    // Registered BEFORE freshServer so the gate opens before the server is
    // closed on teardown (a broken route would otherwise leave a request
    // hanging and make server.close() wait forever).
    const g = holdSmtp();
    t.after(() => { gate = null; g.open(); });
    const post = await freshServer(t);
    smtpFails = false;
    delivered.length = 0;

    const hit = await withTimeout(post(route, { username: "alice" }), RESPONSE_TIMEOUT_MS, BLOCKED_MSG);
    const miss = await post(route, { username: "no-such-user" });

    assert.equal(hit.status, 200);
    assert.equal(hit.text, miss.text, "bodies must stay byte-identical");
    assert.equal(delivered.length, 0, "the mail must still be in flight when the response arrives");

    // Not fire-and-FORGET-the-feature: once SMTP is unblocked the email must still go out.
    g.open();
    assert.ok(await waitFor(() => delivered.length === 1), "the mail was never delivered after the response");
    assert.equal(delivered[0].to, "alice@example.com");
  });
}

test("a failing SMTP transport after the response never changes the response or crashes the process", async (t) => {
  const post = await freshServer(t);
  smtpDelayMs = 50;
  smtpFails = true;
  t.after(() => { smtpDelayMs = 0; smtpFails = false; });

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const res = await post("/api/auth/forgot-password", { username: "alice" });
  assert.equal(res.status, 200);
  assert.match(res.text, /If an account matching that request exists/);

  await new Promise((r) => setTimeout(r, 300)); // let the detached send reject
  assert.equal(unhandled, null, `detached send leaked an unhandled rejection: ${unhandled && unhandled.message}`);
});
