// routes/billingWebhook.js - the Stripe webhook receiver.
//
// Exported as a plain Express handler function (not a router mounted via
// app.use("/api/billing", ...)) because it MUST run with express.raw(),
// not express.json() - see index.js, where this is registered as its own
// app.post("/api/billing/webhook", express.raw(...), stripeWebhookHandler)
// BEFORE the app.use(express.json()) call that every other route sits
// behind. Getting this ordering wrong doesn't fail loudly: express.json()
// would silently parse-then-reserialize the body, changing its exact byte
// representation, and Stripe's signature check would then fail on every
// single event with no obvious cause.
//
// Deliberately unauthenticated via requireAuth (Stripe, not a logged-in
// user, is the caller) - verifyWebhookEvent's signature check against
// STRIPE_WEBHOOK_SECRET is the entire trust boundary for this route.

const logger = require("../logger");
const { isConfigured, verifyWebhookEvent, applyWebhookEvent } = require("../billing");

async function stripeWebhookHandler(req, res) {
  if (!isConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(501).json({ error: "Stripe webhooks are not configured on this deployment" });
  }

  const signature = req.headers["stripe-signature"];
  let event;
  try {
    // req.body is a raw Buffer here (see express.raw() in index.js), which
    // is exactly what stripe.webhooks.constructEvent needs - passing an
    // already-parsed object would fail signature verification.
    event = verifyWebhookEvent(req.body, signature);
  } catch (err) {
    logger.warn("Stripe webhook signature verification failed", { error: err.message });
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    await applyWebhookEvent(event);
  } catch (err) {
    logger.error("Stripe webhook event handling failed", { type: event.type, error: err.message });
    // Still 200 - Stripe retries on non-2xx, and a bug in our own handling
    // of a well-formed, correctly-signed event shouldn't cause Stripe to
    // hammer this endpoint with retries of an event we already logged and
    // will need to fix in code, not by receiving the same webhook again.
  }

  res.status(200).json({ received: true });
}

module.exports = { stripeWebhookHandler };
