// routes/auth.js - human user registration + login (session-based)

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../auth");
const { createUser, verifyLogin, createSession, destroySession } = require("../users");
const { logAudit } = require("../audit");
const router = express.Router();


// Bootstrap: first user can self-register as admin if NO users AND no API keys
// exist yet. After that, only an admin can create more users.
router.post("/register", (req, res) => {
  const { username, password, role = "viewer" } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const anyUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  const anyKeys = db.prepare("SELECT COUNT(*) AS n FROM api_keys").get();
  const isBootstrap = anyUsers.n === 0 && anyKeys.n === 0;

  if (!isBootstrap) {
    // Not the very first account - require an authenticated admin to create users
    return requireAuth("manage_keys")(req, res, () => {
      try {
        createUser({ username, password, role });
        res.status(201).json({ ok: true, username, role });
      } catch (err) {
        res.status(400).json({ error: err.message.includes("UNIQUE") ? "username already exists" : err.message });
      }
    });
  }

  try {
    createUser({ username, password, role: "admin" }); // bootstrap user is always admin
    res.status(201).json({ ok: true, username, role: "admin", note: "bootstrap admin account created" });
  } catch (err) {
    res.status(400).json({ error: err.message.includes("UNIQUE") ? "username already exists" : err.message });
  }
});

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const user = verifyLogin(username, password);
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = createSession(user);
  res.json({ token, username: user.username, role: user.role });
});

router.post("/logout", (req, res) => {
  const token = req.header("X-Session-Token");
  if (token) destroySession(token);
  res.json({ ok: true });
});

module.exports = router;