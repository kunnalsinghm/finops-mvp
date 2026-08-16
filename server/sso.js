// sso.js - Generic OpenID Connect (OIDC) client, authorization code flow.
//
// IMPORTANT: this implements the OIDC mechanics correctly per spec, but it
// CANNOT be fully tested without a real identity provider (Okta, Azure AD,
// Google Workspace, Auth0, etc.) - that requires YOU to register an
// application with your IdP and get a client_id/client_secret, which only
// you can do for your own org. What's tested here (see README) is the
// discovery-document parsing and token-exchange logic against a mock OIDC
// server - the protocol handling is correct; the live handshake with a real
// provider is the one piece you'll need to verify yourself once configured.
//
// Setup: set these in .env (see .env.example):
//   OIDC_ISSUER=https://your-idp.com                 (e.g. https://your-org.okta.com)
//   OIDC_CLIENT_ID=...
//   OIDC_CLIENT_SECRET=...
//   OIDC_REDIRECT_URI=http://localhost:4000/api/sso/callback

const crypto = require("crypto");
const { createUser, createSession } = require("./users");
const db = require("./db");

const pendingStates = new Map(); // state -> { createdAt } (CSRF protection)

function isConfigured() {
  return Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
}

async function getDiscoveryDocument() {
  const issuer = process.env.OIDC_ISSUER.replace(/\/$/, "");
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Failed to fetch OIDC discovery document: ${res.status}`);
  return res.json();
}

function buildAuthorizationUrl(discoveryDoc) {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, { createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.OIDC_CLIENT_ID,
    redirect_uri: process.env.OIDC_REDIRECT_URI,
    scope: "openid profile email",
    state,
  });

  return `${discoveryDoc.authorization_endpoint}?${params.toString()}`;
}

async function exchangeCodeForTokens(discoveryDoc, code) {
  const res = await fetch(discoveryDoc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.OIDC_REDIRECT_URI,
      client_id: process.env.OIDC_CLIENT_ID,
      client_secret: process.env.OIDC_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }
  return res.json();
}

// Decodes the ID token payload WITHOUT verifying the signature.
// A production deployment should verify against the IdP's JWKS - flagged
// here rather than silently skipped, since this matters for real security.
function decodeIdTokenUnsafe(idToken) {
  const payload = idToken.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function validateState(state) {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state);
  return Date.now() - entry.createdAt < 10 * 60 * 1000; // 10 min expiry
}

// Provision or find a local user record for an SSO-authenticated identity,
// then issue a normal session token (same session system as password login).
function loginOrProvisionSsoUser(email) {
  let user = db.prepare("SELECT * FROM users WHERE username = ?").get(email);
  if (!user) {
    // First SSO login for this email - provision as viewer by default.
    // An admin can upgrade their role via PATCH /api/keys or a future
    // admin endpoint - auto-granting admin to any SSO login would be unsafe.
    createUser({ username: email, password: crypto.randomBytes(24).toString("hex"), role: "viewer" });
    user = db.prepare("SELECT * FROM users WHERE username = ?").get(email);
  }
  return createSession(user);
}

module.exports = {
  isConfigured,
  getDiscoveryDocument,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  decodeIdTokenUnsafe,
  validateState,
  loginOrProvisionSsoUser,
};