// test/testDbHygiene.test.js - a test must never open the repo's real database.
//
// Loading server/storage (directly, or through a route, a limiter, a store ...)
// opens SQLite at FINOPS_DB_PATH, which defaults to data/finops.db in the repo -
// the same file a developer's `npm start` uses. A test that loads it without
// pointing FINOPS_DB_PATH at a scratch file therefore opens, and MIGRATES, the
// developer's real database (and writes a pre-migration snapshot into
// data/backups). It also makes the suite fail on an older checkout once a newer
// build has migrated that file ("database is newer than this build").
//
// This found it in trustProxy.test.js: it required loginRateLimit, which loads
// storage. Rule enforced here, statically: a test file whose requires reach the
// storage layer must assign process.env.FINOPS_DB_PATH, or be gated on the Postgres driver
// (FINOPS_DB_DRIVER), where it uses its own schema and never touches that file.
//
// It is a static check: it follows `require("./relative")` calls through
// server/ and cannot see a path built at run time. It over-approximates
// (a lazy require inside a function counts), which only ever asks a test file to
// say explicitly which database it uses.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server");

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + ".js", path.join(base, "index.js")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function requiresOf(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    const r = resolveRequire(file, m[1]);
    if (r) out.push(r);
  }
  return out;
}

function walk(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else if (e.name.endsWith(".js")) files.push(p);
  }
  return files;
}

// The modules that open the database when loaded.
const STORAGE_ENTRY = new Set([path.join(SERVER, "storage", "index.js"), path.join(SERVER, "db.js")]);

function reachesStorage(file, memo = new Map(), stack = new Set()) {
  if (STORAGE_ENTRY.has(file)) return true;
  if (memo.has(file)) return memo.get(file);
  if (stack.has(file)) return false;
  stack.add(file);
  let hit = false;
  for (const dep of requiresOf(file)) {
    if (dep.startsWith(SERVER) && reachesStorage(dep, memo, stack)) { hit = true; break; }
  }
  stack.delete(file);
  memo.set(file, hit);
  return hit;
}

// Does this test file's source say which database it uses, for ITS OWN process?
//  - it assigns process.env.FINOPS_DB_PATH (a scratch file), or
//  - it branches on process.env.FINOPS_DB_DRIVER (Postgres-gated: own schema).
// Mentioning either variable in the environment handed to a CHILD process (a spawn
// env object, `delete env.FINOPS_DB_DRIVER`) does not protect this process.
function declaresItsDatabase(src) {
  return /process\.env\.FINOPS_DB_PATH\s*=(?!=)/.test(src) || /process\.env\.FINOPS_DB_DRIVER\s*[!=]==?/.test(src);
}

// Test files that load storage and say nothing about which database they use.
function offenders() {
  const memo = new Map();
  const bad = [];
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith(".test.js"))) {
    const file = path.join(__dirname, f);
    const src = fs.readFileSync(file, "utf8");
    const loadsStorage = requiresOf(file).some((d) => d.startsWith(SERVER) && reachesStorage(d, memo));
    if (!loadsStorage) continue;
    if (declaresItsDatabase(src)) continue;
    bad.push(f);
  }
  return bad;
}

test("the analysis sees storage through a limiter, a route and a store (a blind walker must not pass vacuously)", () => {
  const memo = new Map();
  for (const rel of ["loginRateLimit.js", "usageStore.js", path.join("routes", "proxy.js")]) {
    assert.ok(reachesStorage(path.join(SERVER, rel), memo), `${rel} should reach the storage layer`);
  }
  assert.equal(reachesStorage(path.join(SERVER, "trustProxy.js"), memo), false, "trustProxy.js is pure and must not");
  assert.ok(walk(SERVER).length > 40);
});

test("every test that loads the storage layer points at a scratch database or is Postgres-gated", () => {
  assert.deepEqual(offenders(), [],
    "these test files load storage without setting FINOPS_DB_PATH (or gating on FINOPS_DB_DRIVER): " +
    "they would open and migrate the developer's real data/finops.db");
});

test("declaresItsDatabase: what counts, and the near-misses that must not", () => {
  assert.equal(declaresItsDatabase('process.env.FINOPS_DB_PATH = path.join(dir, "t.db");'), true);
  assert.equal(declaresItsDatabase('if (process.env.FINOPS_DB_DRIVER !== "postgres") { test("skipped", () => {}); }'), true);
  assert.equal(declaresItsDatabase('const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";'), true);
  // the shapes that fooled the first versions of this check:
  assert.equal(declaresItsDatabase('const env = { ...process.env, FINOPS_DB_PATH: path.join(dir, "t.db") }; delete env.FINOPS_DB_DRIVER;'), false, "a child's env is not this process");
  assert.equal(declaresItsDatabase("// uses FINOPS_DB_PATH and FINOPS_DB_DRIVER"), false, "a comment is not a setting");
  assert.equal(declaresItsDatabase("if (process.env.FINOPS_DB_PATH == null) {}"), false, "reading it is not setting it");
  assert.equal(declaresItsDatabase(""), false);
});
