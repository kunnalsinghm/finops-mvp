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
