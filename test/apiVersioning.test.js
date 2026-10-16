// test/apiVersioning.test.js - /api/v1 is an alias of /api, and it must not be a
// way AROUND anything that guards /api.
//
// The risk this file exists for: server/tenantGuard.js switches off route groups
// that are not tenant-aware in multi-tenant mode by registering a guard at
// `/api/<name>`. Mounting the same router at `/api/v1/<name>` next to that
// would have skipped the guard - a not-yet-tenant-aware group would answer on
// /api/v1 with the DEFAULT tenant's data while /api correctly said 501. Runs on
// both backends; the guard is driven by an injectable predicate, so no Postgres
// is needed to prove it. NOT_TENANT_AWARE is empty today, so the guard tests use
// a synthetic entry (same approach as tenantGuard.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { blockInMultiTenant } = require("../server/tenantGuard");
const { API_PREFIXES, canonicalApiPath, versionedPaths, mountApi } = require("../server/apiMounts");

const ENTRY = { path: "/api/__fixture_group", why: "fixture group for apiVersioning.test.js" };

function hit(app, p) {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => {
      http.get({ hostname: "127.0.0.1", port: s.address().port, path: p }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => s.close(() => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(t); } catch { return t; } })() })));
      }).on("error", reject);
    });
  });
}

// Mirrors index.js: guard first, then the real mount, both through mountApi.
function appFor(isMultiTenant) {
  const app = express();
  mountApi(app, ENTRY.path, blockInMultiTenant({ isMultiTenant }));
  const router = express.Router();
  router.get("/", (req, res) => res.json({ reached: true }));
  router.get("/sub/path", (req, res) => res.json({ reached: "sub" }));
  mountApi(app, ENTRY.path, router);
  return app;
}

test("canonicalApiPath maps only the exact /api/v1 prefix", () => {
  assert.equal(canonicalApiPath("/api/v1/costs"), "/api/costs");
  assert.equal(canonicalApiPath("/api/v1"), "/api");
  assert.equal(canonicalApiPath("/api/costs"), "/api/costs");
  assert.equal(canonicalApiPath("/api/v10/costs"), "/api/v10/costs", "v10 is not v1");
  assert.equal(canonicalApiPath("/api/v1x"), "/api/v1x");
  assert.equal(canonicalApiPath("/apix/v1/a"), "/apix/v1/a");
  assert.equal(canonicalApiPath(undefined), undefined);
});

test("versionedPaths: both prefixes, and refuses anything that is not /api/<name>", () => {
  assert.deepEqual(API_PREFIXES, ["/api", "/api/v1"]);
  assert.deepEqual(versionedPaths("/api/costs"), ["/api/costs", "/api/v1/costs"]);
  assert.deepEqual(versionedPaths("/api/semantic-cache"), ["/api/semantic-cache", "/api/v1/semantic-cache"]);
  assert.throws(() => versionedPaths("/costs"), /\/api\/<name>/);
  assert.throws(() => versionedPaths("/api"), /\/api\/<name>/);
  assert.throws(() => versionedPaths("/api/"), /\/api\/<name>/);
});

test("single-tenant: the group is reachable at /api and /api/v1, including sub-paths", async () => {
  for (const p of [ENTRY.path, `/api/v1${ENTRY.path.slice(4)}`, `${ENTRY.path}/sub/path`, `/api/v1${ENTRY.path.slice(4)}/sub/path`]) {
    const r = await hit(appFor(() => false), p);
    assert.equal(r.status, 200, p);
  }
});

test("multi-tenant: a not-tenant-aware group answers 501 at /api AND /api/v1 (and sub-paths), never reaching the handler", async () => {
  for (const p of [ENTRY.path, `/api/v1${ENTRY.path.slice(4)}`, `${ENTRY.path}/sub/path`, `/api/v1${ENTRY.path.slice(4)}/sub/path`]) {
    const r = await hit(appFor(() => true), p);
    assert.equal(r.status, 501, `${p} must be guarded`);
    assert.match(r.body.error, /not available in multi-tenant mode yet/);
    assert.equal(r.body.reached, undefined, `${p}: handler must not run`);
  }
});

test("the 501 on /api/v1 names the real reason (the guard matched the canonical entry)", async () => {
  const { NOT_TENANT_AWARE } = require("../server/tenantGuard");
  NOT_TENANT_AWARE.push(ENTRY);
  try {
    const v1 = await hit(appFor(() => true), `/api/v1${ENTRY.path.slice(4)}`);
    const plain = await hit(appFor(() => true), ENTRY.path);
    assert.match(v1.body.error, /fixture group for apiVersioning\.test\.js/, "reason must be found via /api/v1");
    assert.match(plain.body.error, /fixture group for apiVersioning\.test\.js/);
  } finally {
    NOT_TENANT_AWARE.splice(NOT_TENANT_AWARE.indexOf(ENTRY), 1);
  }
});

test("index.js: every /api mount goes through mountApi, except the deliberately unversioned ones", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l));

  // 1. No direct app.use("/api/...") may remain, except /api/platform.
  const direct = code.filter((l) => /app\.use\(\s*["'`]\/api\//.test(l));
  assert.deepEqual(
    direct.map((l) => l.trim()).filter((l) => !l.includes('"/api/platform"')),
    [],
    "a route group mounted with app.use('/api/...') is NOT available at /api/v1 and is NOT covered by the guard's v1 registration - use mountApi()"
  );

  // 2. The multi-tenant guard registration itself must use mountApi, or a
  //    guarded group would be guarded at /api only.
  const guardLine = code.find((l) => /^\s*for\s*\(/.test(l) && l.includes("NOT_TENANT_AWARE") && l.includes("blockInMultiTenant"));
  assert.ok(guardLine, "the guard registration must still exist");
  assert.match(guardLine, /mountApi\(/, "the guard must be registered at BOTH prefixes");

  // 3. The Stripe webhook stays a single, unversioned, raw-body route registered
  //    BEFORE the JSON parser.
  const codeOnly = code.join("\n"); // comments mention express.json() too
  const webhookAt = codeOnly.indexOf('app.post("/api/billing/webhook"');
  const jsonAt = codeOnly.indexOf("app.use(express.json(");
  assert.ok(webhookAt > 0 && jsonAt > 0 && webhookAt < jsonAt, "webhook must be registered before express.json()");
  assert.ok(!/\/api\/v1\/billing\/webhook/.test(codeOnly), "do not alias the webhook under /api/v1");
});

test("the billing router defines no webhook of its own (so /api/v1/billing/webhook cannot bypass the raw-body route)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "billing.js"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/router\.\w+\(\s*["'`]\/webhook/.test(code));
});

test("nothing in server code keys on the exact /api prefix other than the (now normalising) tenant guard", () => {
  const dir = path.join(__dirname, "..", "server");
  const offenders = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith(".js")) {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((l, i) => {
          if (/^\s*\/\//.test(l)) return;
          if (/req\.(baseUrl|originalUrl|path|url)\b/.test(l) || /startsWith\(\s*["'`]\/api/.test(l)) {
            offenders.push(`${path.relative(dir, full)}:${i + 1}: ${l.trim()}`);
          }
        });
      }
    }
  })(dir);
  const unexpected = offenders.filter((o) => !o.startsWith("tenantGuard.js:"));
  assert.deepEqual(unexpected, [], "new path-prefix matching must be checked against /api/v1 - see apiMounts.js");
});
