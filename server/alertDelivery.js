// alertDelivery.js - fans out alert messages to whichever channels are
// configured (Slack, a generic webhook, email via SMTP), always logging
// locally first regardless of delivery config. Extracted out of alerts.js
// so new channels can be added here without alerts.js needing to know
// about each one's specific transport details.
//
// Every channel is independently optional. If nothing is configured, this
// behaves exactly like the original Slack-only version: local log only.

const { logAlert } = require("./governance");
const defaultDb = require("./storage");
const logger = require("./logger");

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const GENERIC_WEBHOOK_URL = process.env.FINOPS_WEBHOOK_URL || "";
const SMTP_HOST = process.env.FINOPS_SMTP_HOST || "";
const SMTP_PORT = Number(process.env.FINOPS_SMTP_PORT) || 587;
const SMTP_USER = process.env.FINOPS_SMTP_USER || "";
const SMTP_PASS = process.env.FINOPS_SMTP_PASS || "";
const ALERT_EMAIL_FROM = process.env.FINOPS_ALERT_EMAIL_FROM || "";
const ALERT_EMAIL_TO = process.env.FINOPS_ALERT_EMAIL_TO || "";

// Allows tests to inject a fake transporter instead of hitting a real SMTP
// server. Production code never calls this - getEmailTransporter() builds
// the real one lazily on first use.
let testTransporterOverride = null;
function _setTransporterForTesting(fn) {
  testTransporterOverride = fn;
}

let cachedTransporter = null;
// Transport-level readiness only (SMTP host/user/pass) - shared by every
// email sender in the app, alerts and account emails (password reset, email
// verification - see accountEmail.js) alike, so there's exactly one
// nodemailer transport instance and one place that builds it.
function buildTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (cachedTransporter) return cachedTransporter;
  const nodemailer = require("nodemailer");
  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cachedTransporter;
}

// Used by the alerts channel below: additionally requires a configured
// alert recipient, since alerts always go to one fixed ops address, not to
// an arbitrary "to". Unchanged behavior/contract from before this file
// split transport-readiness out of it.
function getEmailTransporter() {
  if (testTransporterOverride) return testTransporterOverride;
  if (!ALERT_EMAIL_TO) return null;
  return buildTransporter();
}

// Used by account emails (accountEmail.js), which send to the user's OWN
// address rather than the fixed alerts recipient - so this only needs the
// transport itself configured, not ALERT_EMAIL_TO. Shares the same cached
// transporter/test override as getEmailTransporter() above; it's the same
// mailbox sending both kinds of mail.
function getAccountEmailTransporter() {
  if (testTransporterOverride) return testTransporterOverride;
  return buildTransporter();
}

// Note: sendSlack/sendGenericWebhook/sendEmail intentionally let network and
// transport errors propagate (no internal try/catch) - deliverAlert below is
// the single place that decides how to handle a channel failing, so a caller
// (like alerts.js) can tell "not configured" (silent no-op) apart from
// "configured but the send actually failed" (thrown error, safe to retry).

async function sendSlack(message) {
  if (!SLACK_WEBHOOK_URL) return;
  await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
}

async function sendGenericWebhook(message) {
  if (!GENERIC_WEBHOOK_URL) return;
  await fetch(GENERIC_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message, timestamp: new Date().toISOString() }),
  });
}

async function sendEmail(message) {
  const transporter = getEmailTransporter();
  if (!transporter) return;
  await transporter.sendMail({
    from: ALERT_EMAIL_FROM || SMTP_USER,
    to: ALERT_EMAIL_TO,
    subject: "FinOps Alert",
    text: message,
  });
}

// Always logs locally first (alerts_log stays the source of truth regardless
// of delivery config), then fans out to every configured channel in
// parallel. A failure in one channel never blocks the others - but unlike
// the old version, a failure is no longer silently swallowed: if every
// configured channel fails, deliverAlert throws so the caller (alerts.js)
// knows this alert was NOT actually delivered anywhere and can avoid
// marking it as fired, letting the next scheduled check retry it.
// `db` defaults to the single global database (single-tenant mode). In
// multi-tenant mode every caller in the request path passes req.db so the
// local alerts_log entry lands in the right tenant's own schema - Slack/
// webhook/email delivery itself has no tenant concept (those are configured
// per-process via env vars, not per-tenant), only the local log row does.
async function deliverAlert(message, type = "budget", db = defaultDb) {
  await logAlert(type, message, db);

  const channels = [];
  if (SLACK_WEBHOOK_URL) channels.push(["slack", sendSlack(message)]);
  if (GENERIC_WEBHOOK_URL) channels.push(["webhook", sendGenericWebhook(message)]);
  if (getEmailTransporter()) channels.push(["email", sendEmail(message)]);

  if (channels.length === 0) return; // nothing configured - local log only, same as before

  const results = await Promise.allSettled(channels.map(([, p]) => p));
  const failures = channels
    .map(([name], i) => ({ name, result: results[i] }))
    .filter(({ result }) => result.status === "rejected");

  for (const { name, result } of failures) {
    logger.error("Alert channel delivery failed", { channel: name, error: result.reason?.message });
  }

  if (failures.length === channels.length) {
    throw new Error(
      `All configured alert channels failed to deliver: ${failures.map((f) => f.name).join(", ")}`
    );
  }
}

// Shared "from" address for every outbound email this app sends (alerts and
// account emails alike) - one configured mailbox, not a separate one per
// feature.
function getEmailFromAddress() {
  return ALERT_EMAIL_FROM || SMTP_USER;
}

module.exports = {
  deliverAlert,
  sendSlack,
  sendGenericWebhook,
  sendEmail,
  getEmailTransporter,
  getAccountEmailTransporter,
  getEmailFromAddress,
  _setTransporterForTesting,
};
