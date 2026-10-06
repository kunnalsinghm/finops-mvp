// emailLookup.js - shared by users.js and tenantUsers.js for the
// "forgot password by EMAIL" lookup, so single- and multi-tenant mode apply
// exactly the same matching and fan-out rules.

// users.email has no UNIQUE constraint (and never did), so one address can
// legitimately sit on several accounts - a person with an admin and a viewer
// login, or a shared team mailbox. A reset-by-email request therefore fans out
// to every matching account, but only up to this many per request: the
// endpoint is anonymous, and an uncapped fan-out would let one request send an
// arbitrary number of emails to a victim's inbox.
const MAX_ACCOUNTS_PER_EMAIL_RESET = 5;

// Stored addresses are kept exactly as typed at registration (case and
// all), so matching is done on a normalised form on BOTH sides: the DB side
// uses LOWER(TRIM(email)) and this is the application side of that comparison.
// Note SQLite's LOWER() only folds ASCII while Postgres folds Unicode, so a
// non-ASCII upper-case address could fail to match on SQLite; ordinary ASCII
// addresses behave identically on both.
function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

module.exports = { MAX_ACCOUNTS_PER_EMAIL_RESET, normalizeEmail };
