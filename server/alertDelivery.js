// alertDelivery.js - fans out alert messages to whichever channels are
// configured (Slack, a generic webhook, email via SMTP), always logging
// locally first regardless of delivery config. Extracted out of alerts.js
// so new channels can be added here without alerts.js needing to know
// about each one's specific transport details.
//
// Every channel is independently optional. If nothing is configured, this
// behaves exactly like the original Slack-only version: local log only.

const { logAlert } = require("./governance");

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
function getEmailTransporter() {
  if (testTransporterOverride) return testTransporterOverride;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL_TO) return null;
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

async function sendSlack(message) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error("Failed to deliver Slack alert:", err.message);
  }
}

async function sendGenericWebhook(message) {
  if (!GENERIC_WEBHOOK_URL) return;
  try {
    await fetch(GENERIC_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, timestamp: new Date().toISOString() }),
    });
  } catch (err) {
    console.error("Failed to deliver webhook alert:", err.message);
  }
}

async function sendEmail(message) {
  const transporter = getEmailTransporter();
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: ALERT_EMAIL_FROM || SMTP_USER,
      to: ALERT_EMAIL_TO,
      subject: "FinOps Alert",
      text: message,
    });
  } catch (err) {
    console.error("Failed to deliver email alert:", err.message);
  }
}

// Always logs locally first (alerts_log stays the source of truth regardless
// of delivery config), then fans out to every configured channel in
// parallel. A failure in one channel does not block the others.
async function deliverAlert(message, type = "budget") {
  logAlert(type, message);
  await Promise.all([sendSlack(message), sendGenericWebhook(message), sendEmail(message)]);
}

module.exports = {
  deliverAlert,
  sendSlack,
  sendGenericWebhook,
  sendEmail,
  getEmailTransporter,
  _setTransporterForTesting,
};
