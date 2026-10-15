// test/accountRecoveryMultiTenant.test.js - multi-tenant forgot-password /
// resend-verification / reset-password, driven through the REAL routes.
//
// Postgres-only (multi-tenancy doesn't exist on SQLite). Before this file
// existed, NOTHING in the suite exercised the multi-tenant recovery routes or
// tenantUsers.js's reset/verify functions at all - accountRecovery.test.js
// covers single-tenant only.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("multi-tenant account recovery tests skipped - multi-tenancy requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_acctrecovery_mt_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const { createTenantUser } = require("../server/tenantUsers");
  const { _setTransporterForTesting } = require("../server/alertDelivery");

    // DETERMINISTIC - no clock. While a gate is held the simulated SMTP send is
  // blocked, so a route that AWAITED the send could not respond until the test
  // opens the gate. A response arriving while the gate is still shut proves the
  // route did not wait on SMTP. (An earlier version asserted "responds in under
  // 300 ms"; that is a wall-clock threshold and false-failed on a loaded machine
  // running the whole suite in parallel.)
  let gate = null;
  function holdSmtp() {
    let open;
    const promise = new Promise((resolve) => (open = resolve));
    gate = { promise, open };
    return gate;
  }
  const RESPONSE_TIMEOUT_MS = 8000; // only ever waited out when the route is broken
  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }
  const BLOCKED_MSG =
    "no response while the SMTP send was blocked - the route is awaiting the mail send, " +
    "which lets an anonymous caller enumerate accounts by response time";

  const delivered = [];
  const createdSchemas = [];
  let tenantA;

  test.before(async () => {
    _setTransporterForTesting({
      sendMail: async (mail) => {
        if (gate) await gate.promise;
        delivered.push(mail);
        return { messageId: "t" };
      },
    });
    tenantA = await tenancy.createTenant({ name: `RecoveryCo-${process.pid}` });
    createdSchemas.push(tenantA.schema_name);
    const { controlPlaneDb } = tenancy.initControlPlane();
    await createTenantUser({ tenant_id: tenantA.id, username: "alice", password: "correct-horse-1", role: "admin", email: "alice@example.com", db: controlPlaneDb });
    await createTenantUser({ tenant_id: tenantA.id, username: "noemail", password: "correct-horse-1", role: "viewer", db: controlPlaneDb });
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

  // Fresh router + fresh limiter per test (5 req / 15 min / IP, shared by
  // forgot-password and resend-verification).
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
    return async function post(pathName, body) {
      const started = process.hrtime.bigint();
      const res = await new Promise((resolve, reject) => {
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
      return { ...res, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    };
  }

  async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return predicate();
  }

  const tokenFrom = (mail) => /token=([0-9a-f]{64})/.exec(mail.text)[1];

  test("MT forgot-password: every non-match branch returns the SAME generic response as a real match, and sends nothing", async (t) => {
    const post = await freshServer(t);
    delivered.length = 0;
    const real = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, username: "alice" });
    await waitFor(() => delivered.length === 1);
    delivered.length = 0;

    const unknownUser = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, username: "ghost" });
    const noEmail = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, username: "noemail" });
    const unknownTenant = await post("/api/auth/forgot-password", { tenant_id: 987654321, username: "alice" });

    for (const r of [real, unknownUser, noEmail, unknownTenant]) assert.equal(r.status, 200);
    assert.equal(unknownUser.text, real.text);
    assert.equal(noEmail.text, real.text);
    assert.equal(unknownTenant.text, real.text);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(delivered.length, 0, "no email may be sent for a non-matching request");
  });

  test("MT forgot-password: a REAL account's response does not wait on SMTP (no timing oracle), mail still delivered", async (t) => {
    const g = holdSmtp(); // before freshServer: the gate must open before the server closes
    t.after(() => { gate = null; g.open(); });
    const post = await freshServer(t);
    delivered.length = 0;

    const hit = await withTimeout(post("/api/auth/forgot-password", { tenant_id: tenantA.id, username: "alice" }), RESPONSE_TIMEOUT_MS, BLOCKED_MSG);
    const miss = await post("/api/auth/forgot-password", { tenant_id: tenantA.id, username: "ghost" });

    assert.equal(hit.text, miss.text);
    assert.equal(delivered.length, 0, "the mail must still be in flight when the response arrives");
    g.open();
    assert.ok(await waitFor(() => delivered.length === 1), "mail never delivered after the response");
    assert.equal(delivered[0].to, "alice@example.com");
  });

  test("MT resend-verification: a REAL unverified account's response does not wait on SMTP, mail still delivered", async (t) => {
    const g = holdSmtp();
    t.after(() => { gate = null; g.open(); });
    const post = await freshServer(t);
    delivered.length = 0;

    const hit = await withTimeout(post("/api/auth/resend-verification", { tenant_id: tenantA.id, username: "alice" }), RESPONSE_TIMEOUT_MS, BLOCKED_MSG);
    const miss = await post("/api/auth/resend-verification", { tenant_id: tenantA.id, username: "ghost" });

    assert.equal(hit.text, miss.text);
    assert.equal(delivered.length, 0, "the mail must still be in flight when the response arrives");
    g.open();
    assert.ok(await waitFor(() => delivered.length === 1), "mail never delivered after the response");
  });

  test("MT end-to-end: emailed reset token resets the password via the real route, old password stops working, token is single-use", async (t) => {
    const post = await freshServer(t);
    delivered.length = 0;

    await post("/api/auth/forgot-password", { tenant_id: tenantA.id, username: "alice" });
    assert.ok(await waitFor(() => delivered.length === 1));
    const token = tokenFrom(delivered[0]);

    const reset = await post("/api/auth/reset-password", { token, newPassword: "brand-new-pass-9" });
    assert.equal(reset.status, 200, reset.text);

    const oldLogin = await post("/api/auth/login", { tenant_id: tenantA.id, username: "alice", password: "correct-horse-1" });
    assert.equal(oldLogin.status, 401);
    const newLogin = await post("/api/auth/login", { tenant_id: tenantA.id, username: "alice", password: "brand-new-pass-9" });
    assert.equal(newLogin.status, 200, newLogin.text);

    const reuse = await post("/api/auth/reset-password", { token, newPassword: "another-pass-77" });
    assert.equal(reuse.status, 400, "a redeemed token must not be reusable");
  });
}
