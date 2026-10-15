// test/alertDelivery.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-alertDelivery-*.db* files from a PREVIOUS run of
// this file that never got a chance to clean up (e.g. Ctrl+C, a crashed
// process, a killed terminal) - test.after() below only runs on a normal
// exit, so an interrupted run leaves orphaned temp DB files behind
// indefinitely otherwise. Doing this at startup, not just teardown, means
// the next run cleans up after the last one even if that one never got the
// chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-alertDelivery-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-alertDelivery-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_alertdelivery_${process.pid}`;
}

let db;
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    // storage.ready is a background schema-creation promise kicked off the
    // moment ../server/storage was required above. Some tests in this file
    // may never happen to await it internally before this teardown runs -
    // without this explicit await, pool.end() below could run WHILE that
    // background query is still in flight, producing "Cannot use a pool
    // after calling end on the pool" as an unhandled rejection after the
    // test already finished.
    try {
      await storage.ready;
    } catch {
      // If schema init itself failed, there's nothing further to await -
      // proceed to drop/end below regardless.
    }
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[alertDelivery.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

db = require("../server/db");

test("deliverAlert always logs locally even when no channels are configured", async (t) => {
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.FINOPS_WEBHOOK_URL;
  delete require.cache[require.resolve("../server/alertDelivery")];
  const { deliverAlert } = require("../server/alertDelivery");

  const before = (await storage.get("SELECT COUNT(*) AS n FROM alerts_log")).n;
  await deliverAlert("test message", "budget");
  const after = (await storage.get("SELECT COUNT(*) AS n FROM alerts_log")).n;

  assert.equal(after, before + 1, "expected exactly one new alerts_log row");
});

test("sendSlack posts to the configured webhook URL with the message as text", async (t) => {
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/fake";
  delete require.cache[require.resolve("../server/alertDelivery")];
  const { sendSlack } = require("../server/alertDelivery");

  let calledUrl = null;
  let calledBody = null;
  t.mock.method(global, "fetch", async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    return { ok: true };
  });

  await sendSlack("hello slack");

  assert.equal(calledUrl, "https://hooks.slack.test/fake");
  assert.equal(calledBody.text, "hello slack");

  delete process.env.SLACK_WEBHOOK_URL;
});

test("sendSlack is a no-op when SLACK_WEBHOOK_URL is not set", async (t) => {
  delete process.env.SLACK_WEBHOOK_URL;
  delete require.cache[require.resolve("../server/alertDelivery")];
  const { sendSlack } = require("../server/alertDelivery");

  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true };
  });

  await sendSlack("should not send");
  assert.equal(fetchCalled, false);
});

test("sendGenericWebhook posts message and a timestamp when configured", async (t) => {
  process.env.FINOPS_WEBHOOK_URL = "https://example.test/webhook";
  delete require.cache[require.resolve("../server/alertDelivery")];
  const { sendGenericWebhook } = require("../server/alertDelivery");

  let calledUrl = null;
  let calledBody = null;
  t.mock.method(global, "fetch", async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    return { ok: true };
  });

  await sendGenericWebhook("hello webhook");

  assert.equal(calledUrl, "https://example.test/webhook");
  assert.equal(calledBody.text, "hello webhook");
  assert.ok(calledBody.timestamp, "expected a timestamp field");

  delete process.env.FINOPS_WEBHOOK_URL;
});

test("sendGenericWebhook is a no-op when FINOPS_WEBHOOK_URL is not set", async (t) => {
  delete process.env.FINOPS_WEBHOOK_URL;
  delete require.cache[require.resolve("../server/alertDelivery")];
  const { sendGenericWebhook } = require("../server/alertDelivery");

  let fetchCalled = false;
  t.mock.method(global, "fetch", async () => {
    fetchCalled = true;
    return { ok: true };
  });

  await sendGenericWebhook("should not send");
  assert.equal(fetchCalled, false);
});

test("sendEmail uses the injected test transporter and sends the expected fields", async () => {
  delete require.cache[require.resolve("../server/alertDelivery")];
  const { sendEmail, _setTransporterForTesting } = require("../server/alertDelivery");

  let sentMail = null;
  _setTransporterForTesting({
    sendMail: async (mail) => {
      sentMail = mail;
      return { messageId: "fake-id" };
    },
  });

  await sendEmail("hello email");

  assert.ok(sentMail, "expected sendMail to have been called");
  assert.equal(sentMail.text, "hello email");
  assert.equal(sentMail.subject, "FinOps Alert");

  _setTransporterForTesting(null);
});

test("sendEmail is a no-op when SMTP is not configured and no test transporter is injected", async (t) => {
  delete require.cache[require.resolve("../server/alertDelivery")];
  const { sendEmail } = require("../server/alertDelivery");
  // No _setTransporterForTesting call, no SMTP env vars - should just return.
  await assert.doesNotReject(sendEmail("should not throw"));
});

// ---- Webhook HMAC signing (X-FinOps-Signature) ----
// The receiver-side contract being tested: header is `t=<unix seconds>,v1=<hex>`
// where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Tests recompute the HMAC
// independently with node:crypto rather than calling the module's own signer,
// so a bug shared by signer and verifier can't make the test pass vacuously.
const crypto = require("node:crypto");

function loadAlertDelivery() {
  delete require.cache[require.resolve("../server/alertDelivery")];
  return require("../server/alertDelivery");
}

test("sendGenericWebhook signs the exact body bytes when FINOPS_WEBHOOK_SECRET is set", async (t) => {
  process.env.FINOPS_WEBHOOK_URL = "https://example.test/webhook";
  process.env.FINOPS_WEBHOOK_SECRET = "whsec_test_secret";
  const { sendGenericWebhook } = loadAlertDelivery();

  let captured = null;
  t.mock.method(global, "fetch", async (url, opts) => {
    captured = opts;
    return { ok: true };
  });

  const before = Math.floor(Date.now() / 1000);
  await sendGenericWebhook("hello signed webhook");
  const after = Math.floor(Date.now() / 1000);

  const header = captured.headers["X-FinOps-Signature"];
  assert.ok(header, "expected an X-FinOps-Signature header");
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  assert.ok(m, `header must match t=<unix>,v1=<64 hex>, got: ${header}`);

  const ts = Number(m[1]);
  assert.ok(ts >= before && ts <= after, "t must be the current unix time in seconds");

  const expected = crypto
    .createHmac("sha256", "whsec_test_secret")
    .update(`${m[1]}.${captured.body}`)
    .digest("hex");
  assert.equal(m[2], expected, "v1 must be HMAC-SHA256(secret, `t.body`) over the exact body sent");

  delete process.env.FINOPS_WEBHOOK_URL;
  delete process.env.FINOPS_WEBHOOK_SECRET;
});

test("sendGenericWebhook stays unsigned (current behavior) when FINOPS_WEBHOOK_SECRET is not set", async (t) => {
  // Deliberate backward-compat choice: existing deployments that configured
  // FINOPS_WEBHOOK_URL before signing existed must keep working unchanged.
  process.env.FINOPS_WEBHOOK_URL = "https://example.test/webhook";
  delete process.env.FINOPS_WEBHOOK_SECRET;
  const { sendGenericWebhook } = loadAlertDelivery();

  let captured = null;
  t.mock.method(global, "fetch", async (url, opts) => {
    captured = opts;
    return { ok: true };
  });

  await sendGenericWebhook("hello unsigned webhook");

  assert.equal(captured.headers["X-FinOps-Signature"], undefined);
  assert.equal(captured.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(captured.body).text, "hello unsigned webhook");

  delete process.env.FINOPS_WEBHOOK_URL;
});

test("signature does not validate under a different secret or a tampered body", async (t) => {
  process.env.FINOPS_WEBHOOK_URL = "https://example.test/webhook";
  process.env.FINOPS_WEBHOOK_SECRET = "right_secret";
  const { sendGenericWebhook } = loadAlertDelivery();

  let captured = null;
  t.mock.method(global, "fetch", async (url, opts) => {
    captured = opts;
    return { ok: true };
  });
  await sendGenericWebhook("integrity check");

  const header = captured.headers["X-FinOps-Signature"];
  assert.ok(header, "expected a signature to check against");
  const { verifyWebhookSignature } = loadAlertDelivery();

  assert.equal(verifyWebhookSignature(captured.body, header, "right_secret"), true);
  assert.equal(verifyWebhookSignature(captured.body, header, "wrong_secret"), false);
  assert.equal(verifyWebhookSignature(captured.body + " ", header, "right_secret"), false);
  assert.equal(
    verifyWebhookSignature(captured.body.replace("integrity", "tampered"), header, "right_secret"),
    false
  );

  delete process.env.FINOPS_WEBHOOK_URL;
  delete process.env.FINOPS_WEBHOOK_SECRET;
});

test("verifyWebhookSignature rejects stale timestamps (replay) and malformed headers", () => {
  const { verifyWebhookSignature } = loadAlertDelivery();
  const secret = "s3cret";
  const body = '{"text":"x"}';
  const mk = (ts) =>
    `t=${ts},v1=${crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyWebhookSignature(body, mk(now), secret), true);
  // 10 minutes old: valid HMAC, but outside the default 5-minute tolerance.
  assert.equal(verifyWebhookSignature(body, mk(now - 600), secret), false);
  // Tolerance is adjustable by the caller.
  assert.equal(verifyWebhookSignature(body, mk(now - 600), secret, { toleranceSeconds: 900 }), true);

  for (const bad of [undefined, "", "garbage", "t=abc,v1=zz", `t=${now}`, `v1=${"0".repeat(64)}`]) {
    assert.equal(verifyWebhookSignature(body, bad, secret), false, `must reject malformed header: ${bad}`);
  }
});
