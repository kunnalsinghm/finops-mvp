// login-limiter.js - brute-force protection for /api/auth/login
//
// In-memory, per-process (resets on restart) - consistent with the rest of
// this codebase's governance.js approach (token buckets, quarantine). If you
// outgrow one process, swap the Map below for Redis, same as governance.js.
//
// Keyed by IP + username together (not just IP, so one bad actor can't lock
// out every user behind a shared NAT/office IP; not just username, so an
// attacker can't lock a legitimate user out by deliberately failing their
// login from elsewhere).

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const attempts = new Map(); // key -> { count, firstAttemptAt, lockedUntil }

function keyFor(ip, username) {
  return `${ip}::${String(username || "").toLowerCase()}`;
}

// Call before verifying credentials. Returns { allowed, retryAfterSec }.
function checkLoginAllowed(ip, username) {
  const key = keyFor(ip, username);
  const entry = attempts.get(key);
  if (!entry) return { allowed: true };

  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
  }

  // Lock has expired (or never set) - reset the window if it's stale.
  if (now - entry.firstAttemptAt > WINDOW_MS) {
    attempts.delete(key);
    return { allowed: true };
  }

  return { allowed: true };
}

// Call after a failed login attempt.
function recordFailure(ip, username) {
  const key = keyFor(ip, username);
  const now = Date.now();
  let entry = attempts.get(key);

  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    entry = { count: 0, firstAttemptAt: now, lockedUntil: null };
  }

  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + WINDOW_MS;
  }
  attempts.set(key, entry);
}

// Call after a successful login to clear the counter for that identity.
function recordSuccess(ip, username) {
  attempts.delete(keyFor(ip, username));
}

// Periodic cleanup so the Map doesn't grow unbounded with one-off attempts.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    const expired = entry.lockedUntil ? now > entry.lockedUntil : now - entry.firstAttemptAt > WINDOW_MS;
    if (expired) attempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = { checkLoginAllowed, recordFailure, recordSuccess, MAX_ATTEMPTS, WINDOW_MS };
