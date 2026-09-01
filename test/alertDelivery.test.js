// test/alertDelivery.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-alertDelivery-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

let db;
test.after(() => {
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

  const before = db.prepare("SELECT COUNT(*) AS n FROM alerts_log").get().n;
  await deliverAlert("test message", "budget");
  const after = db.prepare("SELECT COUNT(*) AS n FROM alerts_log").get().n;

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
