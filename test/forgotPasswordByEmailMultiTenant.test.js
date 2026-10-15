// test/forgotPasswordByEmailMultiTenant.test.js - POST /api/auth/forgot-password
// by EMAIL in multi-tenant mode, driven through the REAL route.
//
// Postgres-only (multi-tenancy doesn't exist on SQLite). The single-tenant
// behaviour is in forgotPasswordByEmail.test.js; this file exists for the one
// property that file cannot test: users.email is not unique, so the SAME
// address can sit on accounts in DIFFERENT tenants, and a reset request that
// names tenant A must never touch, email, or reveal anything about tenant B's
// account - even when the username and the address are identical in both.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("multi-tenant forgot-password-by-email tests skipped - multi-tenancy requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_fpbyemail_mt_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const { createTenantUser } = require("../server/tenantUsers");
  const { _setTransporterForTesting } = require("../server/alertDelivery");

  const delivered = [];
  const createdSchemas = [];
  let tenantA;
  let tenantB;
  let cp; // control-plane db

  async function verifyEmail(tenant_id, username) {
    await cp.run("UPDATE users SET email_verified = 1 WHERE tenant_id = ? AND username = ?", [tenant_id, username]);
  }
  async function resetHash(tenant_id, username) {
    const row = await cp.get("SELECT reset_token_hash FROM users WHERE tenant_id = ? AND username = ?", [tenant_id, username]);
    return row.reset_token_hash;
  }

  test.before(async () => {
    _setTransporterForTesting({
      sendMail: async (mail) => {
        delivered.push(mail);
        return { messageId: "t" };
      },
    });
    tenantA = await tenancy.createTenant({ name: `FpEmailA-${process.pid}` });
    tenantB = await tenancy.createTenant({ name: `FpEmailB-${process.pid}` });
    createdSchemas.push(tenantA.schema_name, tenantB.schema_name);
    cp = tenancy.initControlPlane().controlPlaneDb;

    // Deliberately nasty: SAME username and SAME address in both tenants.
    for (const t of [tenantA, tenantB]) {
      await createTenantUser({ tenant_id: t.id, username: "pat", password: "correct-horse-1", role: "admin", email: "pat@shared.example", db: cp });
      await verifyEmail(t.id, "pat");
    }
    // Only in tenant B.
    await createTenantUser({ tenant_id: tenantB.id, username: "bonly", password: "correct-horse-1", role: "admin", email: "only-in-b@example.com", db: cp });
    await verifyEmail(tenantB.id, "bonly");
    // Tenant A, address on file but NEVER verified.
    await createTenantUser({ tenant_id: tenantA.id, username: "unver", password: "correct-horse-1", role: "viewer", email: "unverified@example.com", db: cp });
  });

  test.after(async () => {
    _setTransporterForTesting(null);
    const { controlPlanePool } = tenancy.initControlPlane();
    for (const schema of createdSchemas) {
      try { await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch {}
    }
    try { await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`); } catch {}
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
  });

  // Fresh router + fresh limiter per test (5 req / 15 min / IP).
  async function freshServer(t) {
    delete require.cache[require.resolve("../server/loginRateLimit")];
    delete require.cache[require.resolve("../server/routes/auth")];
    const authRoute = require("../server/routes/auth");
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRoute);
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return (pathName, body) =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
          { hostname: "127.0.0.1", port: server.address().port, path: pathName, method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
          (r) => {
            let text = "";
            r.on("data", (c) => (text += c));
            r.on("end", () => resolve({ status: r.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
          }
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
  }

  async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return predicate();
  }
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const tokenFrom = (mail) => /token=([0-9a-f]{64})/.exec(mail.text)[1];

  test("MT by-email: match, unknown address, unverified address, other-tenant address and unknown tenant all get the SAME generic response; only the match sends mail", async (t) => {
    const post = await freshServer(t);
    delivered.length = 0;
    const real = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, email: "pat@shared.example" });
    assert.ok(await waitFor(() => delivered.length === 1), "verified address should get a reset email");
    assert.equal(delivered[0].to, "pat@shared.example");
    delivered.length = 0;

    const unknown = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, email: "nobody@example.com" });
    const unverified = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, email: "unverified@example.com" });
    const otherTenantOnly = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, email: "only-in-b@example.com" });
    const unknownTenant = await post("/api/auth/forgot-password", { tenant_id: 987654321, email: "pat@shared.example" });

    for (const r of [real, unknown, unverified, otherTenantOnly, unknownTenant]) assert.equal(r.status, 200);
    for (const r of [unknown, unverified, otherTenantOnly, unknownTenant]) assert.equal(r.text, real.text);
    await settle();
    assert.equal(delivered.length, 0, "no email may be sent for any non-matching request");
  });

  test("MT by-email CROSS-TENANT ISOLATION: same username + same address in tenants A and B - naming A resets ONLY A", async (t) => {
    const post = await freshServer(t);
    delivered.length = 0;
    // The previous test already issued A a token, so capture A's current value
    // and assert it CHANGES; B has never been named by any request, so it must
    // be (and stay) null.
    const aBefore = await resetHash(tenantA.id, "pat");
    assert.equal(await resetHash(tenantB.id, "pat"), null);

    const res = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, email: "pat@shared.example" });
    assert.equal(res.status, 200);
    assert.ok(await waitFor(() => delivered.length >= 1));
    await settle();
    assert.equal(delivered.length, 1, "exactly one email: B's account must not get one just because the address matches");

    assert.notEqual(await resetHash(tenantA.id, "pat"), aBefore, "tenant A's account should have been issued a fresh reset token");
    assert.equal(await resetHash(tenantB.id, "pat"), null, "tenant B's account must NOT have been issued a reset token");

    // Redeem it: A's password changes, B's identically-named account is untouched.
    const reset = await post("/api/auth/reset-password", { token: tokenFrom(delivered[0]), newPassword: "brand-new-pass-9" });
    assert.equal(reset.status, 200, reset.text);
    const aOld = await post("/api/auth/login", { tenant_id: tenantA.id, username: "pat", password: "correct-horse-1" });
    const aNew = await post("/api/auth/login", { tenant_id: tenantA.id, username: "pat", password: "brand-new-pass-9" });
    const bOld = await post("/api/auth/login", { tenant_id: tenantB.id, username: "pat", password: "correct-horse-1" });
    assert.equal(aOld.status, 401);
    assert.equal(aNew.status, 200, aNew.text);
    assert.equal(bOld.status, 200, "tenant B's account must still have its ORIGINAL password");
  });

  test("MT by-email: a suspended tenant gets the generic response and sends nothing", async (t) => {
    const post = await freshServer(t);
    delivered.length = 0;
    await cp.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [tenantB.id]);
    t.after(() => cp.run("UPDATE tenants SET status = 'active' WHERE id = ?", [tenantB.id]));

    const live = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, email: "unverified@example.com" });
    const suspended = await post("/api/auth/forgot-password", { tenant_id: tenantB.id, email: "only-in-b@example.com" });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.text, live.text);
    await settle();
    assert.equal(delivered.length, 0);
    assert.equal(await resetHash(tenantB.id, "bonly"), null);
  });

  test("MT by-email: fan-out within one tenant is capped at 5 accounts per request", async (t) => {
    const post = await freshServer(t);
    for (let i = 1; i <= 7; i++) {
      await createTenantUser({ tenant_id: tenantA.id, username: `team${i}`, password: "correct-horse-1", role: "viewer", email: "team@shared-box.example", db: cp });
      await verifyEmail(tenantA.id, `team${i}`);
    }
    delivered.length = 0;
    const res = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, email: "team@shared-box.example" });
    assert.equal(res.status, 200);
    assert.ok(await waitFor(() => delivered.length >= 5));
    await settle();
    assert.equal(delivered.length, 5, `7 accounts share the address; expected the cap of 5, got ${delivered.length}`);
  });

  test("MT by-email: input-shape errors (missing tenant_id, neither, both, malformed) are 400s and send nothing", async (t) => {
    const post = await freshServer(t);
    delivered.length = 0;
    const cases = [
      { email: "pat@shared.example" }, // no tenant_id
      { tenant_id: tenantA.id }, // neither
      { tenant_id: tenantA.id, username: "pat", email: "pat@shared.example" }, // both
      { tenant_id: tenantA.id, email: "not-an-email" }, // malformed
    ];
    for (const body of cases) {
      const r = await post("/api/auth/forgot-password", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    }
    await settle();
    assert.equal(delivered.length, 0);
  });
}
