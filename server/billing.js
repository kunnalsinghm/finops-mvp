// billing.js - Stripe subscription billing for Guard's flat-fee tiers.
//
// Entirely OFF by default: every function here checks for STRIPE_SECRET_KEY
// before doing anything, and the routes return a clear 501 (not a crash,
// not a silent no-op) when it's unset - same pattern as sso.js/reconcile.js
// disabling themselves cleanly when their own required config is absent.
// `stripe` is a real npm dependency (unlike nodemailer, which this
// codebase also treats as "always installed, conditionally used") because
// there's no zero-dependency way to talk to Stripe's API, but requiring it
// is still deferred to first actual use rather than at module load time -
// so a deployment that never touches billing never pays even the require()
// cost, and there's nothing to break if the module is present but
// misconfigured.
//
// This tracks the *platform's own* subscription to a customer's account
// (Guard's $999/$2,500 flat-fee tiers from the product plan) - completely
// separate from the AI-provider spend this whole product otherwise tracks.
// Getting those two ledgers confused would be a serious bug, hence the
// separate `subscriptions` table rather than reusing anything spend-shaped.

const db = require("./storage");
const logger = require("./logger");

const PLANS = {
  guard_flat_5: { label: "FinOps Guard - up to 5 members", monthly_usd: 999 },
  guard_flat_unlimited: { label: "FinOps Guard - unlimited members", monthly_usd: 2500 },
};

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

let cachedStripe = null;
function getStripeClient() {
  if (!isConfigured()) return null;
  if (!cachedStripe) {
    const Stripe = require("stripe");
    cachedStripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return cachedStripe;
}

async function createCheckoutSession({ plan, successUrl, cancelUrl }) {
  const stripe = getStripeClient();
  if (!stripe) throw Object.assign(new Error("Stripe is not configured (STRIPE_SECRET_KEY unset)"), { code: "NOT_CONFIGURED" });

  const planConfig = PLANS[plan];
  if (!planConfig) throw Object.assign(new Error(`Unknown plan '${plan}'`), { code: "INVALID_PLAN" });

  // Uses Stripe's inline price_data rather than a pre-created Price object
  // in the Stripe dashboard - keeps the two flat-fee tiers fully defined in
  // this file (single source of truth for the price the product plan
  // specifies) instead of split between code and dashboard configuration
  // that could silently drift apart.
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: planConfig.label },
          unit_amount: planConfig.monthly_usd * 100,
          recurring: { interval: "month" },
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { plan },
  });

  await db.run(
    "INSERT INTO subscriptions (stripe_customer_id, plan, status) VALUES (?, ?, 'incomplete')",
    [session.customer || null, plan]
  );

  return session;
}

async function getCurrentSubscription() {
  return db.get("SELECT * FROM subscriptions ORDER BY id DESC LIMIT 1");
}

// Verifies the Stripe signature BEFORE trusting anything in the payload -
// webhook endpoints are unauthenticated by necessity (Stripe, not your own
// logged-in user, is the caller), so signature verification is the entire
// security boundary here, not a nice-to-have.
function verifyWebhookEvent(rawBody, signatureHeader) {
  const stripe = getStripeClient();
  if (!stripe) throw Object.assign(new Error("Stripe is not configured"), { code: "NOT_CONFIGURED" });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET is not configured"), { code: "NOT_CONFIGURED" });

  return stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

async function applyWebhookEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      await db.run(
        "UPDATE subscriptions SET stripe_subscription_id = ?, stripe_customer_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE plan = ? AND stripe_subscription_id IS NULL",
        [obj.subscription || null, obj.customer || null, obj.metadata?.plan || null]
      );
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const status = event.type === "customer.subscription.deleted" ? "canceled" : obj.status;
      const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
      await db.run(
        "UPDATE subscriptions SET status = ?, current_period_end = ?, updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = ?",
        [status, periodEnd, obj.id]
      );
      break;
    }
    default:
      logger.info("Unhandled Stripe webhook event type (no-op)", { type: event.type });
  }
}

module.exports = { PLANS, isConfigured, createCheckoutSession, getCurrentSubscription, verifyWebhookEvent, applyWebhookEvent };
