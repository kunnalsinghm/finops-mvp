// accountEmail.js - sends the two account-lifecycle emails (password reset,
// email verification) to a USER'S OWN address, as opposed to alertDelivery.js
// which sends operational alerts to one fixed ops recipient. Deliberately a
// separate module rather than more functions bolted onto alertDelivery.js -
// alerts and account emails are different concerns that happen to share a
// transport, same reasoning users.js/tenantUsers.js are kept separate
// despite both being "human account" code.
//
// Reuses alertDelivery.js's SMTP transport (getAccountEmailTransporter) and
// "from" address (getEmailFromAddress) rather than opening a second
// connection - there is one configured mailbox for the whole app. If SMTP
// isn't configured, every function here is a silent no-op: this mirrors
// sendEmail's existing "not configured -> no-op, not an error" contract, and
// matters a lot here specifically because a self-hosted deployment with no
// SMTP configured must NOT have forgot-password or registration fail loudly
// just because there's nowhere to actually send the email - see
// routes/auth.js, which always returns its generic success response
// regardless of whether an email was actually sent.

const { getAccountEmailTransporter, getEmailFromAddress } = require("./alertDelivery");

// No FINOPS_APP_URL configured -> falls back to a relative path. That still
// produces a usable, correct link for the common case of the dashboard and
// API being served from the same origin (see server/index.js) - it just
// won't be a clickable absolute URL in an email client that doesn't resolve
// relative links against anything. Operators serving the dashboard from a
// different origin than the API should set FINOPS_APP_URL.
function appUrl(path) {
  const base = (process.env.FINOPS_APP_URL || "").replace(/\/$/, "");
  return `${base}${path}`;
}

async function sendPasswordResetEmail(toEmail, token) {
  const transporter = getAccountEmailTransporter();
  if (!transporter) return false;
  const link = appUrl(`/reset-password.html?token=${token}`);
  await transporter.sendMail({
    from: getEmailFromAddress(),
    to: toEmail,
    subject: "Reset your FinOps password",
    text:
      `A password reset was requested for your FinOps account.\n\n` +
      `Reset your password: ${link}\n\n` +
      `This link expires in 1 hour. If you didn't request this, you can safely ignore this email - your password will not be changed.`,
  });
  return true;
}

async function sendVerificationEmail(toEmail, token) {
  const transporter = getAccountEmailTransporter();
  if (!transporter) return false;
  const link = appUrl(`/verify-email.html?token=${token}`);
  await transporter.sendMail({
    from: getEmailFromAddress(),
    to: toEmail,
    subject: "Verify your FinOps email address",
    text: `Verify your email address to finish setting up your FinOps account: ${link}\n\nThis link expires in 24 hours.`,
  });
  return true;
}

module.exports = { sendPasswordResetEmail, sendVerificationEmail };
