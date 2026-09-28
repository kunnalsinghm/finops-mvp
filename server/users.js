// users.js - human user accounts + session tokens (for dashboard login).
//
// Distinct from api_keys (used by services/the proxy for programmatic auth).
// Passwords hashed with Node's built-in scrypt (no bcrypt dependency needed -
// stays true to the "zero extra native deps" goal). Sessions are in-memory
// (reset on server restart, which is fine for a self-hosted single-process
// deployment) with a 24-hour expiry.
//
// Self-service password reset and email verification (below) are DB-only
// logic - this file never sends mail itself (see accountEmail.js for that);
// every function here returns the raw token so routes/auth.js can decide
// whether/how to email it. That split keeps this file testable without SMTP
// and keeps "what a token unlocks" separate from "how it gets delivered".

const crypto = require("crypto");
const db = require("./storage");
const { hashPassword, passwordMatches } = require("./passwordHash");
const { generateToken, hashToken } = require("./tokenHash");

const sessions = new Map(); // token -> { username, role, expiresAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour - short-lived, emailed link
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours - less sensitive than a password reset

async function createUser({ username, password, role = "viewer", email = null }) {
  const { hash, salt } = hashPassword(password);
  await db.run("INSERT INTO users (username, password_hash, salt, role, email) VALUES (?, ?, ?, ?, ?)", [
    username,
    hash,
    salt,
    role,
    email || null,
  ]);
  // A verification token is issued whenever an email was given, so the
  // caller (routes/auth.js) can send it via accountEmail.js. No email given
  // -> nothing to verify, email_verified just stays its default (0/false)
  // and is simply not meaningful for that account.
  if (email) {
    return { verifyToken: await issueEmailVerificationToken(username) };
  }
  return {};
}

async function verifyLogin(username, password) {
  const user = await db.get("SELECT * FROM users WHERE username = ?", [username]);
  if (!user) return null;
  const { hash } = hashPassword(password, user.salt);
  if (!passwordMatches(hash, user.password_hash)) return null;
  return user;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    username: user.username,
    role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  sessions.delete(token);
}

function invalidateAllSessionsFor(username) {
  for (const [token, session] of sessions.entries()) {
    if (session.username === username) sessions.delete(token);
  }
}

// Admin-triggered password reset (unchanged) - an admin sets a temporary
// password directly and shares it with the user out of band. Distinct from
// requestPasswordReset/resetPasswordWithToken below, which is the
// self-service, no-admin-involved flow email makes possible. All existing
// sessions for that user are invalidated either way, so a compromised
// session doesn't survive a reset.
async function resetPassword(username, newPassword) {
  const user = await db.get("SELECT * FROM users WHERE username = ?", [username]);
  if (!user) throw new Error("User not found");
  const { hash, salt } = hashPassword(newPassword);
  await db.run("UPDATE users SET password_hash = ?, salt = ? WHERE username = ?", [hash, salt, username]);
  invalidateAllSessionsFor(username);
}

// Step 1 of self-service reset: issue a token if (and only if) this username
// exists AND has an email on file - returns null otherwise. Deliberately
// returns null rather than throwing for "doesn't exist"/"no email" so the
// caller can give the exact same generic response either way (see
// routes/auth.js's POST /forgot-password) - telling an anonymous caller
// which usernames exist, or which ones have an email attached, is exactly
// the account-enumeration hole this flow must not open.
async function requestPasswordReset(username) {
  const user = await db.get("SELECT * FROM users WHERE username = ?", [username]);
  if (!user || !user.email) return null;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await db.run("UPDATE users SET reset_token_hash = ?, reset_token_expires_at = ? WHERE username = ?", [
    hashToken(token),
    expiresAt,
    username,
  ]);
  return { token, email: user.email, username: user.username };
}

// Step 2: redeem the token from the emailed link. Throws (caller turns this
// into a 400) rather than returning null, unlike requestPasswordReset -
// there's no enumeration concern on this side, the caller already has
// whatever token they have.
async function resetPasswordWithToken(token, newPassword) {
  const user = await db.get("SELECT * FROM users WHERE reset_token_hash = ?", [hashToken(token)]);
  if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at).getTime() < Date.now()) {
    throw new Error("This reset link is invalid or has expired");
  }
  const { hash, salt } = hashPassword(newPassword);
  await db.run(
    "UPDATE users SET password_hash = ?, salt = ?, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE username = ?",
    [hash, salt, user.username]
  );
  invalidateAllSessionsFor(user.username);
  return user.username;
}

async function issueEmailVerificationToken(username) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  await db.run("UPDATE users SET verify_token_hash = ?, verify_token_expires_at = ? WHERE username = ?", [
    hashToken(token),
    expiresAt,
    username,
  ]);
  return token;
}

// Used by a "resend verification email" action - same enumeration-safe
// null-if-nothing-to-do shape as requestPasswordReset, plus a no-op if the
// account is already verified (re-verifying is meaningless, and silently
// treating it the same as "unknown account" on the response side means a
// caller learns nothing new either way).
async function requestEmailVerification(username) {
  const user = await db.get("SELECT * FROM users WHERE username = ?", [username]);
  if (!user || !user.email || user.email_verified) return null;
  const token = await issueEmailVerificationToken(username);
  return { token, email: user.email, username: user.username };
}

async function verifyEmailToken(token) {
  const user = await db.get("SELECT * FROM users WHERE verify_token_hash = ?", [hashToken(token)]);
  if (!user || !user.verify_token_expires_at || new Date(user.verify_token_expires_at).getTime() < Date.now()) {
    throw new Error("This verification link is invalid or has expired");
  }
  await db.run(
    "UPDATE users SET email_verified = 1, verify_token_hash = NULL, verify_token_expires_at = NULL WHERE username = ?",
    [user.username]
  );
  return user.username;
}

module.exports = {
  createUser,
  verifyLogin,
  createSession,
  getSession,
  destroySession,
  resetPassword,
  requestPasswordReset,
  resetPasswordWithToken,
  requestEmailVerification,
  verifyEmailToken,
};
