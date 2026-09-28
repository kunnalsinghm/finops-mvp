// loginRateLimit.js - stricter rate limiting specifically for endpoints an
// attacker can hit with NO valid credentials at all (login, and now
// forgot-password/resend-verification - see routes/auth.js), separate from
// the per-API-key limiter in governance.js. Keyed by IP, not by account,
// since the whole point is these endpoints are reachable before any
// account-level identity is established.
//
// createRateLimit() is the shared factory (pulled out so forgot-password and
// resend-verification get their own independent budget and their own audit
// action name, rather than sharing login's counter and silently either
// starving real login attempts or masking a password-reset abuse pattern as
// a login one). loginRateLimit/resetLoginAttempts below are the original
// login-specific instance, preserved with their exact original behavior and
// names so nothing that already depends on them has to change.

const { logAudit } = require("./audit");

function createRateLimit({ windowMs = 15 * 60 * 1000, maxAttempts = 10, auditAction = "rate_limited" } = {}) {
  const attempts = new Map(); // ip -> { count, windowStart, logged }

  async function rateLimit(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();

    let entry = attempts.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now, logged: false };
      attempts.set(ip, entry);
    }

    entry.count++;

    if (entry.count > maxAttempts) {
      const retryAfterSec = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);

      // Log once per lockout window, not on every blocked request while
      // locked - otherwise a persistent attacker fills audit_log with
      // thousands of near-identical rows for a single lockout event.
      // Express 4 doesn't auto-catch async middleware rejections, so this is
      // wrapped in try/catch - a failed audit write should never prevent the
      // actual rate-limit response from going out.
      if (!entry.logged) {
        try {
          await logAudit("system", auditAction, ip, {
            attempts: entry.count,
            windowMinutes: windowMs / 60000,
          });
        } catch (err) {
          console.error(`Failed to write ${auditAction} audit entry:`, err.message);
        }
        entry.logged = true;
      }

      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        retryAfterSec,
      });
    }

    next();
  }

  function reset(req) {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    attempts.delete(ip);
  }

  return { rateLimit, reset };
}

const loginLimiter = createRateLimit({ auditAction: "auth.login_rate_limited" });
const loginRateLimit = loginLimiter.rateLimit;
const resetLoginAttempts = loginLimiter.reset;

// Forgot-password and resend-verification: a real limit for these because
// unlike login, a wrong guess costs the attacker nothing and can't even be
// detected as "wrong" by them (the response is identical either way - see
// routes/auth.js) - so this endpoint's real defense against being used as a
// spam cannon or an enumeration oracle is the rate limit itself, tighter
// than login's, and its own audit trail.
const forgotPasswordLimiter = createRateLimit({ windowMs: 15 * 60 * 1000, maxAttempts: 5, auditAction: "auth.forgot_password_rate_limited" });
const forgotPasswordRateLimit = forgotPasswordLimiter.rateLimit;

// Redeeming a reset/verification token (POST /reset-password,
// POST /verify-email): not an enumeration risk the way forgot-password is
// (the response doesn't reveal anything about accounts, and the token space
// is 256 bits - not brute-forceable at any rate this limiter would matter
// for), so this is deliberately more generous. It exists mainly so a
// misbehaving client retry-looping a bad request doesn't go unnoticed, and
// as basic defense-in-depth against scripted abuse.
const tokenRedeemLimiter = createRateLimit({ windowMs: 15 * 60 * 1000, maxAttempts: 20, auditAction: "auth.token_redeem_rate_limited" });
const tokenRedeemRateLimit = tokenRedeemLimiter.rateLimit;

module.exports = { createRateLimit, loginRateLimit, resetLoginAttempts, forgotPasswordRateLimit, tokenRedeemRateLimit };
