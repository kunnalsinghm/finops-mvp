// routes/billing.js - checkout + status endpoints (normal JSON body,
// mounted through the app's regular express.json() middleware).
//
// The Stripe WEBHOOK route is deliberately NOT here - it needs the raw,
// unparsed request body for signature verification (see billing.js's
// verifyWebhookEvent), which is incompatible with the global
// express.json() middleware already applied to every other route in this
// app. It's registered directly in index.js, before express.json() runs,
// as its own app.post(...) with express.raw() - see index.js and
// routes/billingWebhook.js.

const express = require("express");
const { requireAuth } = require("../auth");
const { logAudit } = require("../audit");
const { PLANS, isConfigured, createCheckoutSession, getCurrentSubscription } = require("../billing");

const router = express.Router();

router.get("/plans", requireAuth("read"), (req, res) => {
  res.json({ configured: isConfigured(), plans: PLANS });
});

// "read" or "audit_read" (A9 auditor role) - subscription/billing status is
// named explicitly as audit-relevant evidence in the RBAC gap analysis (A9).
router.get("/status", requireAuth(["read", "audit_read"]), async (req, res) => {
  const subscription = await getCurrentSubscription();
  res.json(subscription || { status: "none" });
});

// manage_keys is deliberately used here as the "admin-only" gate - it's the
// one permission in ROLE_PERMISSIONS exclusive to the admin role (see
// auth.js), and starting/managing the platform's own paid subscription is
// exactly the kind of action that shouldn't be available to a
// budget-manager/developer/viewer key even though none of those roles have
// anything more directly billing-shaped to reuse instead.
router.post("/checkout-session", requireAuth("manage_keys"), async (req, res) => {
  if (!isConfigured()) {
    return res.status(501).json({ error: "Stripe is not configured on this deployment (STRIPE_SECRET_KEY unset)" });
  }
  const { plan, success_url, cancel_url } = req.body || {};
  if (!plan || !success_url || !cancel_url) {
    return res.status(400).json({ error: "plan, success_url, and cancel_url are required" });
  }
  try {
    const session = await createCheckoutSession({ plan, successUrl: success_url, cancelUrl: cancel_url });
    await logAudit(req.apiKey.key_id, "billing.checkout_session.create", plan, {});
    res.status(201).json({ checkout_url: session.url });
  } catch (err) {
    const status = err.code === "INVALID_PLAN" ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
