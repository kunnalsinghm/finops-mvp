// test/openapi.test.js - the hand-written OpenAPI document (server/openapi.js)
// must stay true to the REAL routers.
//
// Introspects the Express routers themselves (their route stacks), so this is
// not a string match against source:
//   * every documented path+method EXISTS on the router it claims to describe;
//   * every route those routers expose is DOCUMENTED (a new endpoint cannot be
//     added to proxy/ingest/keys/auth/invites without the spec noticing);
//   * the document is structurally sound ($refs resolve, path params declared,
//     operationIds unique, security schemes defined).
// Request/response schemas are NOT machine-checked against handler behaviour -
// see the header of server/openapi.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-openapi-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-openapi-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) process.env.FINOPS_POSTGRES_SCHEMA = `test_openapi_${process.pid}`;
delete process.env.FINOPS_MULTI_TENANT; // single-tenant: auth.js picks its route set at require time

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const spec = require("../server/openapi");

// documented path prefix -> the router that serves it (same mapping as index.js)
const ROUTERS = {
  "/proxy": require("../server/routes/proxy"),
  "/ingest": require("../server/routes/ingest"),
  "/keys": require("../server/routes/keys"),
  "/auth": require("../server/routes/auth"),
  "/invites": require("../server/routes/invites"),
};

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch {}
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch {}
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const METHODS = ["get", "post", "put", "patch", "delete"];
const toExpress = (p) => p.replace(/\{(\w+)\}/g, ":$1");
const norm = (p) => (p === "" ? "/" : p.replace(/\/+$/, "") || "/");

// Every "METHOD /prefix/sub" a router serves.
function routesOf(prefix, router) {
  const out = new Set();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const sub = layer.route.path === "/" ? "" : layer.route.path;
    for (const m of Object.keys(layer.route.methods)) {
      if (layer.route.methods[m]) out.add(`${m.toUpperCase()} ${norm(prefix + sub)}`);
    }
  }
  return out;
}

function documentedOps() {
  const out = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of Object.keys(item)) {
      if (METHODS.includes(m)) out.push({ method: m.toUpperCase(), path: p, op: item[m] });
    }
  }
  return out;
}

const served = new Set();
for (const [prefix, router] of Object.entries(ROUTERS)) for (const r of routesOf(prefix, router)) served.add(r);

test("introspection sanity: the routers expose routes at all (a broken walker must not pass vacuously)", () => {
  assert.ok(served.size >= 20, `expected >= 20 served routes, saw ${served.size}`);
  assert.ok(served.has("POST /ingest"));
  assert.ok(served.has("POST /proxy/:provider"));
  assert.ok(served.has("POST /keys/:keyId/revoke"));
});

test("every documented path+method exists on the real router", () => {
  const missing = documentedOps()
    .map(({ method, path: p }) => `${method} ${norm(toExpress(p))}`)
    .filter((k) => !served.has(k));
  assert.deepEqual(missing, [], "documented but not served");
});

test("every route the in-scope routers serve is documented", () => {
  const documented = new Set(documentedOps().map(({ method, path: p }) => `${method} ${norm(toExpress(p))}`));
  const undocumented = [...served].filter((k) => !documented.has(k)).sort();
  assert.deepEqual(undocumented, [], "served but not in server/openapi.js - document it (or this scope is wrong)");
});

test("document structure: version, servers, unique operationIds, responses present", () => {
  assert.match(spec.openapi, /^3\.0\.\d+$/);
  assert.deepEqual(spec.servers.map((s) => s.url), ["/api/v1"]);
  const ids = documentedOps().map((o) => o.op.operationId);
  assert.ok(ids.every(Boolean), "every operation needs an operationId");
  assert.equal(new Set(ids).size, ids.length, "operationIds must be unique");
  for (const { method, path: p, op } of documentedOps()) {
    assert.ok(op.responses && Object.keys(op.responses).length > 0, `${method} ${p} has no responses`);
    assert.ok(op.tags && op.tags.length, `${method} ${p} has no tag`);
  }
  for (const tag of documentedOps().flatMap((o) => o.op.tags)) {
    assert.ok(spec.tags.some((t) => t.name === tag), `tag '${tag}' is not declared`);
  }
});

test("every $ref resolves", () => {
  const refs = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref") refs.push(v);
        else walk(v);
      }
    }
  })(spec);
  assert.ok(refs.length > 5, "expected the spec to use $refs");
  for (const ref of refs) {
    const parts = ref.replace(/^#\//, "").split("/");
    let cur = spec;
    for (const part of parts) cur = cur && cur[part];
    assert.ok(cur, `unresolved $ref ${ref}`);
  }
});

test("path templates and declared path parameters agree", () => {
  for (const { method, path: p, op } of documentedOps()) {
    const inTemplate = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const declared = (op.parameters || []).filter((x) => x.in === "path").map((x) => x.name).sort();
    assert.deepEqual(declared, inTemplate, `${method} ${p}: path params must be declared exactly`);
    for (const x of (op.parameters || []).filter((q) => q.in === "path")) {
      assert.equal(x.required, true, `${method} ${p}: path param ${x.name} must be required`);
    }
  }
});

test("security: every referenced scheme is defined; public endpoints say so explicitly", () => {
  const defined = new Set(Object.keys(spec.components.securitySchemes));
  assert.deepEqual([...defined].sort(), ["apiKey", "sessionToken"]);
  for (const { method, path: p, op } of documentedOps()) {
    assert.ok(Array.isArray(op.security), `${method} ${p}: state security explicitly ([] = public)`);
    for (const req of op.security) for (const name of Object.keys(req)) assert.ok(defined.has(name), `${method} ${p}: unknown scheme ${name}`);
  }
  const publicOps = documentedOps().filter((o) => o.op.security.length === 0).map((o) => `${o.method} ${o.path}`).sort();
  assert.deepEqual(publicOps, [
    "POST /auth/forgot-password",
    "POST /auth/login",
    "POST /auth/logout",
    "POST /auth/resend-verification",
    "POST /auth/reset-password",
    "POST /auth/verify-email",
    "POST /invites/accept",
  ]);
});

test("the spec is plain JSON-serialisable and is what index.js serves at /api/v1/openapi.json", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec);
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  assert.match(src, /^app\.get\("\/api\/v1\/openapi\.json",.*require\("\.\/openapi"\)/m);
});
