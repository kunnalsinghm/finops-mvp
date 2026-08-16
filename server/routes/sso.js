// routes/sso.js

const express = require("express");
const {
  isConfigured,
  getDiscoveryDocument,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  decodeIdTokenUnsafe,
  validateState,
  loginOrProvisionSsoUser,
} = require("../sso");

const router = express.Router();

router.get("/login", async (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({
      error: "SSO is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI in .env",
    });
  }
  try {
    const doc = await getDiscoveryDocument();
    const url = buildAuthorizationUrl(doc);
    res.redirect(url);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).json({ error: `IdP returned error: ${error}` });
  if (!code || !state) return res.status(400).json({ error: "Missing code or state" });
  if (!validateState(state)) return res.status(400).json({ error: "Invalid or expired state (possible CSRF)" });

  try {
    const doc = await getDiscoveryDocument();
    const tokens = await exchangeCodeForTokens(doc, code);
    const claims = decodeIdTokenUnsafe(tokens.id_token);
    const email = claims.email || claims.preferred_username || claims.sub;

    const sessionToken = loginOrProvisionSsoUser(email);

    // Redirect back to the dashboard with the session token in the URL
    // fragment (not sent to the server on the next request, unlike a query
    // string) - the dashboard JS picks it up and stores it.
    res.redirect(`/#session=${sessionToken}`);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;