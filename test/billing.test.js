// test/billing.test.js
//
// No real Stripe account/keys exist in this test environment (correctly -
// nothing should require live third-party credentials just to run `npm
// test`). This file verifies: (1) the "not configured" path is a clean 501
// everywhere, never a crash, since that's the state every fresh install and
// this CI environment is actually in; (2) applyWebhookEvent's DB-side
// effects, called directly with a hand-built event object shaped like a
// real Stripe webhook payload, without needing a live signature.
// Signature verification itself (verifyWebhookEvent) is a thin wrapper
// around the `stripe` SDK's own constructEvent - trusting Stripe's SDK to
// correctly implement HMAC verification is reasonable; re-testing that
// logic here would just be re-testing a well-tested third-party library.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-billing-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
delete process.env.STRIPE_SECRET_KEY; // ensure "not configured" is really the state under test here

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_billing_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const billingRoute = require("../server/routes/billing");
const { stripeWebhookHandler } = require("../server/routes/billingWebhook");
const { isConfigured, applyWebhookEvent } = require("../server/billing");

let server;

test.before(async () => {
  await storage.ready;
  const app = express();
  app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);
  app.use(express.json());
  app.use("/api/billing", billingRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[billing.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

function request(pathName, { method = "GET", headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: pathName,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let keyCounter = 0;
async function makeApiKey(role = "admin") {
  keyCounter++;
  const key_id = `fk_test_billing_${role}_${keyCounter}`;
  await storage.run("INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')", [
    key_id,
    `test key ${keyCounter}`,
    role,
  ]);
  return key_id;
}

test("isConfigured is false with no STRIPE_SECRET_KEY set", () => {
  assert.equal(isConfigured(), false);
});

test("GET /plans reports configured: false and lists the two flat-fee tiers", async () => {
  const key_id = await makeApiKey("viewer");
  const res = await request("/api/billing/plans", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.configured, false);
  assert.ok(res.json.plans.guard_flat_5);
  assert.ok(res.json.plans.guard_flat_unlimited);
  assert.equal(res.json.plans.guard_flat_5.monthly_usd, 999);
  assert.equal(res.json.plans.guard_flat_unlimited.monthly_usd, 2500);
});

test("GET /status returns { status: 'none' } when no subscription exists yet", async () => {
  const key_id = await makeApiKey("viewer");
  const res = await request("/api/billing/status", { headers: { "X-API-Key": key_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "none");
});

test("POST /checkout-session returns 501 when Stripe is not configured", async () => {
  const key_id = await makeApiKey("admin");
  const res = await request("/api/billing/checkout-session", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { plan: "guard_flat_5", success_url: "https://example.com/ok", cancel_url: "https://example.com/cancel" },
  });
  assert.equal(res.status, 501);
});

test("POST /checkout-session is forbidden for a non-admin role even if Stripe were configured", async () => {
  const key_id = await makeApiKey("developer");
  const res = await request("/api/billing/checkout-session", {
    method: "POST",
    headers: { "X-API-Key": key_id },
    body: { plan: "guard_flat_5", success_url: "https://example.com/ok", cancel_url: "https://example.com/cancel" },
  });
  assert.equal(res.status, 403);
});

test("POST /webhook returns 501 when Stripe/webhook secret is not configured", async () => {
  const res = await request("/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": "irrelevant-when-unconfigured" },
    raw: JSON.stringify({ type: "checkout.session.completed" }),
  });
  assert.equal(res.status, 501);
});

test("applyWebhookEvent(checkout.session.completed) activates the matching pending subscription", async () => {
  await storage.run("INSERT INTO subscriptions (plan, status) VALUES (?, 'incomplete')", ["guard_flat_5"]);

  await applyWebhookEvent({
    type: "checkout.session.completed",
    data: {
      object: {
        subscription: "sub_test_123",
        customer: "cus_test_123",
        metadata: { plan: "guard_flat_5" },
      },
    },
  });

  const row = await storage.get("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?", ["sub_test_123"]);
  assert.ok(row, "expected the subscription row to be updated with the Stripe subscription id");
  assert.equal(row.status, "active");
  assert.equal(row.stripe_customer_id, "cus_test_123");
});

test("applyWebhookEvent(customer.subscription.deleted) marks the subscription canceled", async () => {
  await storage.run(
    "INSERT INTO subscriptions (plan, status, stripe_subscription_id) VALUES (?, 'active', ?)",
    ["guard_flat_unlimited", "sub_test_456"]
  );

  await applyWebhookEvent({
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_test_456", status: "canceled" } },
  });

  const row = await storage.get("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?", ["sub_test_456"]);
  assert.equal(row.status, "canceled");
});

test("applyWebhookEvent silently no-ops on an event type this codebase doesn't handle", async () => {
  await assert.doesNotReject(() =>
    applyWebhookEvent({ type: "invoice.paid", data: { object: {} } })
  );
});
