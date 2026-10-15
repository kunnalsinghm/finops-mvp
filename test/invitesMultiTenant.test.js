// test/invitesMultiTenant.test.js - "invite a teammate" in MULTI-TENANT mode,
// driven through the REAL routes.
//
// Postgres-only. The single-tenant behaviour is in invites.test.js. This file
// is about the property that one cannot test: invites live in the shared
// control-plane schema, so every query must be scoped by tenant. Each
// isolation test writes real data into tenant B and asserts tenant A's admin
// cannot see, revoke, supersede, exhaust the cap of, or accept into it.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("multi-tenant invite tests skipped - multi-tenancy requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_invites_mt_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const { createTenantUser, createTenantSession } = require("../server/tenantUsers");
  const invites = require("../server/invites");
  const { _setTransporterForTesting } = require("../server/alertDelivery");

  const delivered = [];
  const createdSchemas = [];
  let tenantA;
  let tenantB;
  let cp; // control-plane db
  let adminA;
  let adminB;

  test.before(async () => {
    _setTransporterForTesting({
      sendMail: async (mail) => {
        delivered.push(mail);
        return { messageId: "t" };
      },
    });
    tenantA = await tenancy.createTenant({ name: `InvA-${process.pid}` });
    tenantB = await tenancy.createTenant({ name: `InvB-${process.pid}` });
    createdSchemas.push(tenantA.schema_name, tenantB.schema_name);
    cp = tenancy.initControlPlane().controlPlaneDb;
    for (const t of [tenantA, tenantB]) {
      await createTenantUser({ tenant_id: t.id, username: "boss", password: "correct-horse-1", role: "admin", db: cp });
    }
    adminA = createTenantSession({ tenant_id: tenantA.id, username: "boss", role: "admin" }, tenantA.schema_name);
    adminB = createTenantSession({ tenant_id: tenantB.id, username: "boss", role: "admin" }, tenantB.schema_name);
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

  async function freshServer(t) {
    delete require.cache[require.resolve("../server/loginRateLimit")];
    delete require.cache[require.resolve("../server/routes/invites")];
    const route = require("../server/routes/invites");
    const app = express();
    app.use(express.json());
    app.use("/api/invites", route);
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return function call(method, pathName, body, sessionToken) {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (payload) {
          headers["Content-Type"] = "application/json";
          headers["Content-Length"] = Buffer.byteLength(payload);
        }
        if (sessionToken) headers["X-Session-Token"] = sessionToken;
        const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers }, (r) => {
          let text = "";
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve({ status: r.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    };
  }

  const tokenFrom = (mail) => /token=([0-9a-f]{64})/.exec(mail.text)[1];
  const rowFor = (tenantId, email) =>
    cp.get("SELECT * FROM invites WHERE tenant_id = ? AND email = ? ORDER BY id DESC", [tenantId, email]);

  async function invite(call, session, email, role = "viewer") {
    delivered.length = 0;
    const res = await call("POST", "/api/invites", { email, role }, session);
    assert.equal(res.status, 201, res.text);
    return { res, token: tokenFrom(delivered[0]) };
  }

  test("tenantInvites refuses to be built without a tenant id", () => {
    assert.throws(() => invites.tenantInvites(cp, undefined), /tenant id/);
    assert.throws(() => invites.tenantInvites(cp, null), /tenant id/);
  });

  test("each tenant lists ONLY its own invites", async (t) => {
    const call = await freshServer(t);
    await invite(call, adminA, "only-a@example.com");
    await invite(call, adminB, "only-b@example.com");
    const a = await call("GET", "/api/invites", undefined, adminA);
    const b = await call("GET", "/api/invites", undefined, adminB);
    assert.ok(a.json.some((i) => i.email === "only-a@example.com"));
    assert.ok(!a.json.some((i) => i.email === "only-b@example.com"), "tenant A must not see tenant B's invite");
    assert.ok(b.json.some((i) => i.email === "only-b@example.com"));
    assert.ok(!b.json.some((i) => i.email === "only-a@example.com"), "tenant B must not see tenant A's invite");
  });

  test("tenant A's admin cannot revoke tenant B's invite (404, and B's invite still works)", async (t) => {
    const call = await freshServer(t);
    const { token } = await invite(call, adminB, "victim-b@example.com");
    const bId = (await rowFor(tenantB.id, "victim-b@example.com")).id;
    const res = await call("DELETE", `/api/invites/${bId}`, undefined, adminA);
    assert.equal(res.status, 404);
    assert.equal((await rowFor(tenantB.id, "victim-b@example.com")).revoked_at, null, "B's invite must not be revoked");
    const ok = await call("POST", "/api/invites/accept", { token, username: "bvictim", password: "correct-horse-2" });
    assert.equal(ok.status, 201);
  });

  test("accepting creates the user in the INVITE's tenant and ignores any client-supplied tenant", async (t) => {
    const call = await freshServer(t);
    const { token } = await invite(call, adminA, "joiner@example.com", "developer");
    const ok = await call("POST", "/api/invites/accept", {
      token, username: "joiner", password: "correct-horse-2", tenant_id: tenantB.id,
    });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.tenant_id, tenantA.id, "the tenant comes from the invite row");
    const inA = await cp.get("SELECT * FROM users WHERE tenant_id = ? AND username = ?", [tenantA.id, "joiner"]);
    assert.ok(inA);
    assert.equal(inA.role, "developer");
    assert.equal(inA.email, "joiner@example.com");
    assert.equal(Number(inA.email_verified), 1);
    assert.equal(await cp.get("SELECT 1 AS x FROM users WHERE tenant_id = ? AND username = ?", [tenantB.id, "joiner"]), undefined);
  });

  test("the same username can be taken in another tenant: 'username taken' is per tenant", async (t) => {
    const call = await freshServer(t);
    const a = await invite(call, adminA, "samename-a@example.com");
    const b = await invite(call, adminB, "samename-b@example.com");
    assert.equal((await call("POST", "/api/invites/accept", { token: a.token, username: "twin", password: "correct-horse-2" })).status, 201);
    assert.equal((await call("POST", "/api/invites/accept", { token: b.token, username: "twin", password: "correct-horse-2" })).status, 201);
    // ...but not twice within one tenant.
    const a2 = await invite(call, adminA, "samename-a2@example.com");
    assert.equal((await call("POST", "/api/invites/accept", { token: a2.token, username: "twin", password: "correct-horse-2" })).status, 409);
  });

  test("re-inviting an address in tenant A does NOT supersede tenant B's pending invite for that address", async (t) => {
    const call = await freshServer(t);
    const b = await invite(call, adminB, "shared-addr@example.com");
    await invite(call, adminA, "shared-addr@example.com");
    await invite(call, adminA, "shared-addr@example.com"); // A re-invites: only A's older one is superseded
    const bRow = await rowFor(tenantB.id, "shared-addr@example.com");
    assert.equal(bRow.revoked_at, null, "tenant B's invite must be untouched by tenant A's re-invite");
    const ok = await call("POST", "/api/invites/accept", { token: b.token, username: "bshared", password: "correct-horse-2" });
    assert.equal(ok.status, 201);
  });

  test("the pending cap is per tenant: filling A does not block B", async (t) => {
    const call = await freshServer(t);
    await cp.run("DELETE FROM invites WHERE tenant_id = ?", [tenantA.id]);
    await cp.run("DELETE FROM invites WHERE tenant_id = ?", [tenantB.id]);
    const store = invites.tenantInvites(cp, tenantA.id);
    for (let i = 0; i < invites.MAX_PENDING_INVITES; i++) {
      await store.create({ email: `capmt${i}@example.com`, role: "viewer", invitedBy: "t", inviterRole: "admin" });
    }
    assert.equal((await call("POST", "/api/invites", { email: "over@example.com" }, adminA)).status, 429);
    assert.equal((await call("POST", "/api/invites", { email: "fine@example.com" }, adminB)).status, 201);
    await cp.run("DELETE FROM invites WHERE tenant_id = ?", [tenantA.id]);
  });

  test("an invite issued before a tenant was suspended cannot be redeemed until it is reactivated", async (t) => {
    const call = await freshServer(t);
    const { token } = await invite(call, adminA, "latecomer@example.com");
    const unknown = await call("POST", "/api/invites/accept", { token: "e".repeat(64), username: "late", password: "correct-horse-2" });
    await cp.run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [tenantA.id]);
    try {
      const blocked = await call("POST", "/api/invites/accept", { token, username: "late", password: "correct-horse-2" });
      assert.equal(blocked.status, 400);
      assert.equal(blocked.text, unknown.text, "a suspended tenant is indistinguishable from an unknown token");
      assert.equal(await cp.get("SELECT 1 AS x FROM users WHERE tenant_id = ? AND username = ?", [tenantA.id, "late"]), undefined);
    } finally {
      await cp.run("UPDATE tenants SET status = 'active' WHERE id = ?", [tenantA.id]);
    }
    const ok = await call("POST", "/api/invites/accept", { token, username: "late", password: "correct-horse-2" });
    assert.equal(ok.status, 201, "the invite was not burned by the blocked attempt");
  });

  test("concurrent accepts of one token in multi-tenant mode: exactly one wins", async (t) => {
    const call = await freshServer(t);
    const { token } = await invite(call, adminA, "mtrace@example.com");
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => call("POST", "/api/invites/accept", { token, username: `mtracer${i}`, password: "correct-horse-2" }))
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(","));
    const made = await cp.all("SELECT username FROM users WHERE tenant_id = ? AND email = ?", [tenantA.id, "mtrace@example.com"]);
    assert.equal(made.length, 1);
  });

  test("the email names the tenant, and audit entries land in that tenant's own schema only", async (t) => {
    const call = await freshServer(t);
    delivered.length = 0;
    const res = await call("POST", "/api/invites", { email: "audited@example.com" }, adminA);
    assert.equal(res.status, 201);
    assert.match(delivered[0].subject, new RegExp(`InvA-${process.pid}`));
    const dbA = await tenancy.getTenantDb(tenantA.schema_name);
    const dbB = await tenancy.getTenantDb(tenantB.schema_name);
    const inA = await dbA.all("SELECT action, target FROM audit_log WHERE action = 'invite.create' AND target = ?", ["audited@example.com"]);
    const inB = await dbB.all("SELECT action FROM audit_log WHERE target = ?", ["audited@example.com"]);
    assert.equal(inA.length, 1, "audit entry written to tenant A's schema");
    assert.equal(inB.length, 0, "and not to tenant B's");
  });
}
