// test/accountEmail.test.js - accountEmail.js, and the specific
// alertDelivery.js refactor this P0 fix depended on: account emails
// (password reset, verification) must be sendable whenever SMTP itself is
// configured, WITHOUT also requiring FINOPS_ALERT_EMAIL_TO (the ops alerts
// recipient) to be set - those are two independent concerns that used to be
// wrongly coupled behind one gate. Each test that needs a specific
// combination of SMTP_HOST/USER/PASS/ALERT_EMAIL_TO/ALERT_EMAIL_FROM/APP_URL
// sets the env vars and then deletes+re-requires both modules (they read
// env vars once, at module load) - the same isolation technique
// accountRecovery.test.js and alertDelivery.test.js already use.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-accountEmail-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-accountEmail-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

function freshRequire(envOverrides) {
  const keys = [
    "FINOPS_SMTP_HOST",
    "FINOPS_SMTP_PORT",
    "FINOPS_SMTP_USER",
    "FINOPS_SMTP_PASS",
    "FINOPS_ALERT_EMAIL_FROM",
    "FINOPS_ALERT_EMAIL_TO",
    "FINOPS_APP_URL",
  ];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, envOverrides);
  delete require.cache[require.resolve("../server/alertDelivery")];
  delete require.cache[require.resolve("../server/accountEmail")];
  const alertDelivery = require("../server/alertDelivery");
  const accountEmail = require("../server/accountEmail");
  return { alertDelivery, accountEmail };
}

test("SMTP configured but NO alert recipient: account emails still work, ops alert email still doesn't (they're independent gates)", async () => {
  const { alertDelivery, accountEmail } = freshRequire({
    FINOPS_SMTP_HOST: "smtp.example.com",
    FINOPS_SMTP_USER: "bot@example.com",
    FINOPS_SMTP_PASS: "hunter2",
    // deliberately no FINOPS_ALERT_EMAIL_TO
  });

  assert.equal(alertDelivery.getEmailTransporter(), null, "alerts still require ALERT_EMAIL_TO");
  assert.notEqual(alertDelivery.getAccountEmailTransporter(), null, "account emails don't need an alert recipient at all");

  let sent = null;
  alertDelivery._setTransporterForTesting({ sendMail: async (mail) => { sent = mail; } });
  const ok = await accountEmail.sendPasswordResetEmail("someone@example.com", "abc123token");
  assert.equal(ok, true);
  assert.equal(sent.to, "someone@example.com");
  assert.match(sent.text, /abc123token/);
  alertDelivery._setTransporterForTesting(null);
});

test("nothing configured at all: both transporters are null, and account emails are a silent no-op (not a thrown error)", async () => {
  const { alertDelivery, accountEmail } = freshRequire({});
  assert.equal(alertDelivery.getEmailTransporter(), null);
  assert.equal(alertDelivery.getAccountEmailTransporter(), null);

  const resetOk = await accountEmail.sendPasswordResetEmail("someone@example.com", "tok");
  const verifyOk = await accountEmail.sendVerificationEmail("someone@example.com", "tok");
  assert.equal(resetOk, false);
  assert.equal(verifyOk, false);
});

test("getEmailFromAddress prefers FINOPS_ALERT_EMAIL_FROM, falls back to the SMTP user", async () => {
  const withFrom = freshRequire({
    FINOPS_SMTP_HOST: "smtp.example.com",
    FINOPS_SMTP_USER: "bot@example.com",
    FINOPS_SMTP_PASS: "hunter2",
    FINOPS_ALERT_EMAIL_FROM: "noreply@example.com",
  });
  assert.equal(withFrom.alertDelivery.getEmailFromAddress(), "noreply@example.com");

  const withoutFrom = freshRequire({
    FINOPS_SMTP_HOST: "smtp.example.com",
    FINOPS_SMTP_USER: "bot@example.com",
    FINOPS_SMTP_PASS: "hunter2",
  });
  assert.equal(withoutFrom.alertDelivery.getEmailFromAddress(), "bot@example.com");
});

test("password reset and verification links are relative by default, absolute when FINOPS_APP_URL is set", async () => {
  let sent = null;
  const relative = freshRequire({
    FINOPS_SMTP_HOST: "smtp.example.com",
    FINOPS_SMTP_USER: "bot@example.com",
    FINOPS_SMTP_PASS: "hunter2",
  });
  relative.alertDelivery._setTransporterForTesting({ sendMail: async (mail) => { sent = mail; } });
  await relative.accountEmail.sendPasswordResetEmail("someone@example.com", "reset-tok");
  assert.match(sent.text, /(?<!\/)\/reset-password\.html\?token=reset-tok/);

  sent = null;
  const absolute = freshRequire({
    FINOPS_SMTP_HOST: "smtp.example.com",
    FINOPS_SMTP_USER: "bot@example.com",
    FINOPS_SMTP_PASS: "hunter2",
    FINOPS_APP_URL: "https://app.example.com",
  });
  absolute.alertDelivery._setTransporterForTesting({ sendMail: async (mail) => { sent = mail; } });
  await absolute.accountEmail.sendVerificationEmail("someone@example.com", "verify-tok");
  assert.match(sent.text, /https:\/\/app\.example\.com\/verify-email\.html\?token=verify-tok/);
  assert.match(sent.subject, /verify/i);

  relative.alertDelivery._setTransporterForTesting(null);
  absolute.alertDelivery._setTransporterForTesting(null);
});

test("a trailing slash on FINOPS_APP_URL doesn't produce a double slash in the link", async () => {
  let sent = null;
  const { alertDelivery, accountEmail } = freshRequire({
    FINOPS_SMTP_HOST: "smtp.example.com",
    FINOPS_SMTP_USER: "bot@example.com",
    FINOPS_SMTP_PASS: "hunter2",
    FINOPS_APP_URL: "https://app.example.com/",
  });
  alertDelivery._setTransporterForTesting({ sendMail: async (mail) => { sent = mail; } });
  await accountEmail.sendPasswordResetEmail("someone@example.com", "tok");
  assert.match(sent.text, /https:\/\/app\.example\.com\/reset-password\.html\?token=tok/);
  assert.doesNotMatch(sent.text, /\.com\/\/reset-password/);
  alertDelivery._setTransporterForTesting(null);
});
