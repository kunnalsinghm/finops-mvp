// loginRateLimit.js - stricter rate limiting specifically for the login
// endpoint, separate from the per-API-key limiter in governance.js.
//
// Login is the one endpoint an attacker can hit with NO valid credentials at
// all (unlike everything else, which requires a key/session first) - so it
// needs its own, tighter limit keyed by IP rather than by API key.

const { logAudit } = require("./audit");

const attempts = new Map(); // ip -> { count, windowStart, logged }

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10; // per window, per IP

async function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();

  let entry = attempts.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { count: 0, windowStart: now, logged: false };
    attempts.set(ip, entry);
  }

  entry.count++;

  if (entry.count > MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);

    // Log once per lockout window, not on every blocked request while
    // locked - otherwise a persistent attacker fills audit_log with
    // thousands of near-identical rows for a single lockout event.
    // Express 4 doesn't auto-catch async middleware rejections, so this is
    // wrapped in try/catch - a failed audit write should never prevent the
    // actual rate-limit response from going out.
    if (!entry.logged) {
      try {
        await logAudit("system", "auth.login_rate_limited", ip, {
          attempts: entry.count,
          windowMinutes: WINDOW_MS / 60000,
        });
      } catch (err) {
        console.error("Failed to write login-rate-limit audit entry:", err.message);
      }
      entry.logged = true;
    }

    return res.status(429).json({
      error: "Too many login attempts. Try again later.",
      retryAfterSec,
    });
  }

  next();
}

function resetLoginAttempts(req) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  attempts.delete(ip);
}

module.exports = { loginRateLimit, resetLoginAttempts };
