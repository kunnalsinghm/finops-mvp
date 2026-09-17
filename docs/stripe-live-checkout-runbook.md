# Stripe live-checkout verification runbook

`server/billing.js` and the automated tests in `test/billing.test.js` cover everything that can be verified WITHOUT real Stripe credentials: the "not configured" paths, permission checks, and `applyWebhookEvent`'s database effects given a hand-built event payload.

What those tests deliberately do NOT cover - because it requires a real Stripe account and real browser interaction, neither of which belongs in an automated test suite - is an actual end-to-end checkout: does clicking "Pay" in a real Stripe Checkout page really result in this app's `subscriptions` table showing `status: 'active'`. This runbook is that missing manual step. Do this once before considering Guard's billing integration production-ready, and again any time `server/billing.js` or `server/routes/billingWebhook.js` changes.

## Prerequisites

- A free Stripe account (test mode - no real card processing, no real money moves)
- The [Stripe CLI](https://stripe.com/docs/stripe-cli) installed (`stripe` command available)
- This server running locally

## Step 1 - Get test-mode API keys

1. Log into the [Stripe Dashboard](https://dashboard.stripe.com), make sure you're in **Test mode** (toggle top-right)
2. Go to **Developers -> API keys**
3. Copy the **Secret key** (starts `sk_test_...`)

## Step 2 - Start the webhook forwarder

The Stripe CLI forwards real Stripe webhook events to your local server, and prints a webhook signing secret you'll need next:

```bash
stripe listen --forward-to localhost:4000/api/billing/webhook
```

Leave this running. It prints something like:

```
Ready! Your webhook signing secret is whsec_XXXXXXXXXXXXXXXX (^C to quit)
```

Copy that `whsec_...` value.

## Step 3 - Start the server with Stripe configured

```bash
STRIPE_SECRET_KEY=sk_test_your_key_here \
STRIPE_WEBHOOK_SECRET=whsec_the_value_from_step_2 \
npm start
```

Confirm it's picked up:

```bash
curl -s http://localhost:4000/api/billing/plans -H "X-API-Key: your-admin-key" | grep '"configured":true'
```

If this still says `"configured":false`, the env vars weren't actually passed through - check for typos before continuing.

## Step 4 - Create a real checkout session

```bash
curl -s -X POST http://localhost:4000/api/billing/checkout-session \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-admin-key" \
  -d '{
    "plan": "guard_flat_5",
    "success_url": "https://example.com/success",
    "cancel_url": "https://example.com/cancel"
  }'
```

You should get back `{"checkout_url": "https://checkout.stripe.com/..."}`. Open that URL in a browser.

## Step 5 - Complete checkout with a Stripe test card

On the Stripe-hosted checkout page, use one of [Stripe's official test cards](https://stripe.com/docs/testing#cards) - the standard one that always succeeds:

- Card number: `4242 4242 4242 4242`
- Expiry: any future date
- CVC: any 3 digits
- Any name/ZIP

Complete the checkout.

## Step 6 - Verify the webhook actually landed

Watch the terminal running `stripe listen` - you should see `checkout.session.completed` (and shortly after, likely `customer.subscription.created`/`updated`) get forwarded, each followed by a `200` response from your server. A non-200 here means `applyWebhookEvent` threw - check your server logs.

## Step 7 - Verify the database actually updated

```bash
curl -s http://localhost:4000/api/billing/status -H "X-API-Key: your-admin-key"
```

Expect:

```json
{
  "plan": "guard_flat_5",
  "status": "active",
  "stripe_customer_id": "cus_...",
  "stripe_subscription_id": "sub_...",
  ...
}
```

**If `status` is still `incomplete`**, the webhook either didn't fire, didn't reach the server, or `applyWebhookEvent`'s `UPDATE ... WHERE stripe_subscription_id IS NULL` match failed to find the row created in Step 4 - work backward from Step 6's logs.

## Step 8 - Verify cancellation also flows through

In the Stripe Dashboard (test mode), find the subscription you just created and cancel it. Watch for `customer.subscription.deleted` in the `stripe listen` output, then re-check:

```bash
curl -s http://localhost:4000/api/billing/status -H "X-API-Key: your-admin-key"
```

`status` should now read `canceled`.

## What "done" looks like

All of Steps 4 through 8 completing with the expected results, using YOUR real (test-mode) Stripe account, is the actual bar for calling this integration verified - not just the automated tests passing. Re-run this whenever `billing.js`/`billingWebhook.js` changes, and definitely once more against a real Stripe LIVE key (with an actual dollar, refunded immediately after) before taking a real customer's card.
