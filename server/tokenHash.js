// tokenHash.js - shared by users.js and tenantUsers.js for password-reset
// and email-verification tokens.
//
// Deliberately a plain SHA-256 hash, not scrypt like passwordHash.js:
// scrypt's whole point is to make brute-forcing a LOW-entropy, human-chosen
// secret (a password) expensive. These tokens are 32 bytes of
// crypto.randomBytes - already far too high-entropy to brute-force - so a
// slow hash buys nothing here and would only add needless CPU cost on every
// reset-link click. The hash still matters: it means a DB dump alone can't
// be used to redeem a still-valid reset/verification link, same reasoning
// session tokens would want if they were ever persisted to disk.

const crypto = require("crypto");

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

module.exports = { generateToken, hashToken };
