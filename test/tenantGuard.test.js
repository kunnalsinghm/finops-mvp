// test/tenantGuard.test.js - route groups that are not yet tenant-aware must be switched
// OFF in multi-tenant mode (501), not left to silently serve the default database to
// every tenant. Runs on both backends: the guard is driven by an injectable predicate,
// so no Postgres is needed to prove the behaviour.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { NOT_TENANT_AWARE, blockInMultiTenant } = require("../server/tenantGuard");

function appWith(isMultiTenant) {
  const app = express();
  for (const { path: p } of NOT_TENANT_AWARE) app.use(p, blockInMultiTenant({ isMultiTenant }));
  // stand-ins for the real routes, mounted AFTER the guard exactly as index.js does
  for (const { path: p } of NOT_TENANT_AWARE) app.get(p, (req, res) => res.json({ reached: p }));
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

test("multi-tenant: every not-yet-converted route group answers 501 with a reason, and never reaches its handler", async () => {
  const app = appWith(() => true);
  for (const { path: p, why } of NOT_TENANT_AWARE) {
    const r = await hit(app, p);
    assert.equal(r.status, 501, p);
    assert.match(r.body.error, /not available in multi-tenant mode yet/);
    assert.ok(r.body.error.includes(why), `${p} should say why`);
    assert.equal(r.body.reached, undefined, `${p} handler must not run`);
  }
});

test("multi-tenant: routes that ARE tenant-aware are untouched by the guard", async () => {
  const r = await hit(appWith(() => true), "/api/costs");
  assert.equal(r.status, 200);
});

test("single-tenant: the guard is a complete no-op for every group", async () => {
  const app = appWith(() => false);
  for (const { path: p } of NOT_TENANT_AWARE) {
    const r = await hit(app, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.body.reached, p);
  }
});

test("the guard is registered in server/index.js BEFORE any guarded route is mounted", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  const guardAt = src.indexOf("blockInMultiTenant()");
  assert.ok(guardAt > 0, "index.js must register the guard");
  const mounts = [...src.matchAll(/app\.use\("(\/api\/[a-z-]+)",\s*\w+/g)].map((m) => ({ path: m[1], at: m.index }));
  for (const { path: p } of NOT_TENANT_AWARE) {
    const m = mounts.find((x) => x.path === p);
    assert.ok(m, `${p} must actually be a mounted route (stale entry in NOT_TENANT_AWARE?)`);
    assert.ok(guardAt < m.at, `the guard must come before the ${p} mount, or it protects nothing`);
  }
});

test("every guarded path corresponds to a real route file (no stale entries)", () => {
  const dir = path.join(__dirname, "..", "server", "routes");
  const files = fs.readdirSync(dir).map((f) => f.replace(/\.js$/, "").toLowerCase());
  for (const { path: p } of NOT_TENANT_AWARE) {
    const name = p.replace("/api/", "").replace(/-/g, "");
    assert.ok(files.includes(name), `no route file matches ${p}`);
  }
});
