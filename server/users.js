// users.js - human user accounts + session tokens (for dashboard login).
//
// Distinct from api_keys (used by services/the proxy for programmatic auth).
// Passwords hashed with Node's built-in scrypt (no bcrypt dependency needed -
// stays true to the "zero extra native deps" goal). Sessions are in-memory
// (reset on server restart, which is fine for a self-hosted single-process
// deployment) with a 24-hour expiry.

const crypto = require("crypto");
const db = require("./storage");
const { hashPassword, passwordMatches } = require("./passwordHash");

const sessions = new Map(); // token -> { username, role, expiresAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

async function createUser({ username, password, role = "viewer" }) {
  const { hash, salt } = hashPassword(password);
  await db.run("INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)", [
    username,
    hash,
    salt,
    role,
  ]);
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

// Admin-triggered password reset. No email/SMTP dependency for a self-hosted
// personal tool - the admin sets a temporary password directly and shares it
// with the user out of band. All existing sessions for that user are
// invalidated so a compromised session doesn't survive the reset.
async function resetPassword(username, newPassword) {
  const user = await db.get("SELECT * FROM users WHERE username = ?", [username]);
  if (!user) throw new Error("User not found");
  const { hash, salt } = hashPassword(newPassword);
  await db.run("UPDATE users SET password_hash = ?, salt = ? WHERE username = ?", [hash, salt, username]);

  for (const [token, session] of sessions.entries()) {
    if (session.username === username) sessions.delete(token);
  }
}

module.exports = { createUser, verifyLogin, createSession, getSession, destroySession, resetPassword };
