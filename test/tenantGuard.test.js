// test/tenantGuard.test.js - route groups that are not yet tenant-aware must be switched
// OFF in multi-tenant mode (501), not left to silently serve the default database to
// every tenant. Runs on both backends: the guard is driven by an injectable predicate,
// so no Postgres is needed to prove the behaviour.
//
// NOT_TENANT_AWARE is currently EMPTY - alerts, commitments, gitops, reconcile, reports,
// query and tool-calls all graduated to req.db (see test/multiTenantIsolation.test.js for
// the two-tenant proof that each one is actually isolated, not just unblocked). The tests
// below exercise the mechanism itself with a synthetic still-blocked entry, so this suite
// stays meaningful - and still catches a regression - even while the real list is empty.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { NOT_TENANT_AWARE, blockInMultiTenant } = require("../server/tenantGuard");

const SYNTHETIC_ENTRY = { path: "/api/__not_tenant_aware_fixture", why: "fixture route for tenantGuard.test.js" };

function appWith(isMultiTenant, entries = NOT_TENANT_AWARE) {
  const app = express();
  for (const { path: p } of entries) app.use(p, blockInMultiTenant({ isMultiTenant }));
  // stand-ins for the real routes, mounted AFTER the guard exactly as index.js does
  for (const { path: p } of entries) app.get(p, (req, res) => res.json({ reached: p }));
  app.get("/api/costs", (req, res) => res.json({ reached: "/api/costs" }));
  return app;
}
function hit(app, p) {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => {
      http.get({ hostname: "127.0.0.1", port: s.address().port, path: p }, (res) => {
        let t = ""; res.on("data", (c) => (t += c));
        res.on("end", () => s.close(() => resolve({ status: res.statusCode, body: JSON.parse(t) })));
      }).on("error", reject);
    });
  });
}

test("NOT_TENANT_AWARE is empty: every route group has been converted to req.db", () => {
  assert.deepEqual(NOT_TENANT_AWARE, [], "a non-empty list here means a route group regressed back to a hardcoded global db - see multiTenantIsolation.test.js");
});

test("multi-tenant: an entry in NOT_TENANT_AWARE answers 501 with a reason, and never reaches its handler", async () => {
  const app = appWith(() => true, [SYNTHETIC_ENTRY]);
  const r = await hit(app, SYNTHETIC_ENTRY.path);
  assert.equal(r.status, 501);
  assert.match(r.body.error, /not available in multi-tenant mode yet/);
  assert.equal(r.body.reached, undefined, "handler must not run");
});

test("multi-tenant: routes that are NOT listed in NOT_TENANT_AWARE are untouched by the guard", async () => {
  const r = await hit(appWith(() => true), "/api/costs");
  assert.equal(r.status, 200);
});

test("multi-tenant: every real route group (alerts/commitments/gitops/reconcile/reports/query/tool-calls) is reachable, not 501'd", async () => {
  const app = express();
  for (const { path: p } of NOT_TENANT_AWARE) app.use(p, blockInMultiTenant({ isMultiTenant: () => true }));
  for (const p of ["/api/alerts", "/api/commitments", "/api/gitops", "/api/reconcile", "/api/reports", "/api/query", "/api/tool-calls"]) {
    app.get(p, (req, res) => res.json({ reached: p }));
  }
  for (const p of ["/api/alerts", "/api/commitments", "/api/gitops", "/api/reconcile", "/api/reports", "/api/query", "/api/tool-calls"]) {
    const r = await hit(app, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.body.reached, p);
  }
});

test("single-tenant: the guard is a complete no-op for a synthetic entry", async () => {
  const app = appWith(() => false, [SYNTHETIC_ENTRY]);
  const r = await hit(app, SYNTHETIC_ENTRY.path);
  assert.equal(r.status, 200);
  assert.equal(r.body.reached, SYNTHETIC_ENTRY.path);
});

test("the guard registration point still exists in server/index.js, ready for the next not-yet-converted group", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  const guardAt = src.indexOf("blockInMultiTenant()");
  assert.ok(guardAt > 0, "index.js must still register the guard");
});
