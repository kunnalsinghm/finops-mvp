// passwordHash.js - scrypt password hashing shared by users.js
// (single-tenant dashboard accounts) and tenantUsers.js (multi-tenant
// dashboard accounts). Pulled out of users.js rather than duplicated so a
// future change to the hashing scheme (parameters, algorithm) only has to
// happen in one place for both account systems.

const crypto = require("crypto");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

// Constant-time comparison to avoid timing attacks - same check both
// account systems need after re-hashing a candidate password with the
// stored user's salt.
function passwordMatches(candidateHashHex, storedHashHex) {
  const a = Buffer.from(candidateHashHex, "hex");
  const b = Buffer.from(storedHashHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, passwordMatches };
