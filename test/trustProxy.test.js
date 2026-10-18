// test/trustProxy.test.js - FINOPS_TRUST_PROXY (RFC 0001, phase A2).
//
// Behind a load balancer every client shares the balancer's address, so the
// per-IP login and forgot-password limiters (server/loginRateLimit.js, the
// only two users of req.ip) become one global bucket. FINOPS_TRUST_PROXY is
// an opt-in that is passed to Express "trust proxy". Unset must behave
// exactly as before; an invalid value must refuse to start rather than
// silently trust every client-supplied X-Forwarded-For.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const express = require("express");

// loginRateLimit loads the storage layer, which opens SQLite at FINOPS_DB_PATH.
// Left alone that is the repo's own data/finops.db (the one `npm start` uses), which
// this test would then open and migrate. Point this process at a scratch database
// (test/testDbHygiene.test.js enforces that). The servers spawned further down get
// their own scratch directory through serverEnv().
const SCRATCH_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "finops-trustproxy-db-"));
process.env.FINOPS_DB_PATH = path.join(SCRATCH_DB_DIR, "t.db");
process.env.FINOPS_BACKUP_DIR = path.join(SCRATCH_DB_DIR, "backups");

const { parseTrustProxy, applyTrustProxy } = require("../server/trustProxy");
const { createRateLimit } = require("../server/loginRateLimit");

test.after(() => {
  try { require("../server/db").close(); } catch { /* never opened, or already closed */ }
  fs.rmSync(SCRATCH_DB_DIR, { recursive: true, force: true });
});

const ROOT = path.join(__dirname, "..");

// ---- parsing --------------------------------------------------------------

test("unset or empty means no trust setting at all", () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy(""), undefined);
  assert.equal(parseTrustProxy("   "), undefined);
});

test("a hop count is accepted as a number", () => {
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy(" 2 "), 2);
});

test("an IP / CIDR list is accepted as an array", () => {
  assert.deepEqual(parseTrustProxy("10.0.0.0/8"), ["10.0.0.0/8"]);
  assert.deepEqual(parseTrustProxy("10.0.0.0/8, 192.168.1.5"), ["10.0.0.0/8", "192.168.1.5"]);
  assert.deepEqual(parseTrustProxy("fd00::/8,::1"), ["fd00::/8", "::1"]);
  assert.deepEqual(parseTrustProxy("loopback, uniquelocal"), ["loopback", "uniquelocal"]);
});

test("values that would trust everyone, or are malformed, throw a message naming the setting", () => {
  const bad = [
    "true", "false", "*", "all",
    "0", "-1", "1.5", "33", "abc",
    "0.0.0.0/0", "::/0",
    "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/8x", "999.1.1.1",
    "10.0.0.0/8,", ",10.0.0.0/8", "10.0.0.0/8,,1.1.1.1",
    "1,2", "10.0.0.0/255.0.0.0",
  ];
  for (const v of bad) {
    assert.throws(() => parseTrustProxy(v), /FINOPS_TRUST_PROXY/, `should reject ${JSON.stringify(v)}`);
  }
});

// ---- limiter identity -----------------------------------------------------

function buildApp(trustProxyEnv) {
  const app = express();
  applyTrustProxy(app, trustProxyEnv);
  const limiter = createRateLimit({ maxAttempts: 2, auditAction: "test.rate_limited" });
  app.post("/x", limiter.rateLimit, (req, res) => res.json({ ok: true }));
  app.get("/ip", (req, res) => res.json({ ip: req.ip }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function post(port, xff) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (xff !== undefined) headers["X-Forwarded-For"] = xff;
    const req = http.request({ host: "127.0.0.1", port, path: "/x", method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

function getIp(port, xff) {
  return new Promise((resolve, reject) => {
    const headers = xff === undefined ? {} : { "X-Forwarded-For": xff };
    http.get({ host: "127.0.0.1", port, path: "/ip", headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(JSON.parse(body).ip));
    }).on("error", reject);
  });
}

test("unset: X-Forwarded-For is ignored, all clients share the peer's bucket", async () => {
  const srv = await listen(buildApp(undefined));
  const { port } = srv.address();
  try {
    assert.match(await getIp(port, "203.0.113.7"), /127\.0\.0\.1$/);
    assert.equal(await post(port, "1.1.1.1"), 200);
    assert.equal(await post(port, "1.1.1.1"), 200);
    // A different forwarded client is still the same bucket.
    assert.equal(await post(port, "2.2.2.2"), 429);
  } finally {
    srv.close();
  }
});

test("hop count 1: two forwarded clients are limited independently", async () => {
  const srv = await listen(buildApp("1"));
  const { port } = srv.address();
  try {
    assert.equal(await getIp(port, "203.0.113.7"), "203.0.113.7");
    assert.equal(await post(port, "1.1.1.1"), 200);
    assert.equal(await post(port, "1.1.1.1"), 200);
    assert.equal(await post(port, "1.1.1.1"), 429);
    assert.equal(await post(port, "2.2.2.2"), 200);
  } finally {
    srv.close();
  }
});

test("hop count 1: a client rotating a spoofed leftmost value does not escape its bucket", async () => {
  // A real proxy appends the peer it saw to the right. The client controls
  // only what is to the left of that.
  const srv = await listen(buildApp("1"));
  const { port } = srv.address();
  try {
    assert.equal(await post(port, "9.9.9.1, 1.1.1.1"), 200);
    assert.equal(await post(port, "9.9.9.2, 1.1.1.1"), 200);
    assert.equal(await post(port, "9.9.9.3, 1.1.1.1"), 429);
  } finally {
    srv.close();
  }
});

test("CIDR list that does not include the peer: header from an untrusted hop is ignored", async () => {
  const srv = await listen(buildApp("10.0.0.0/8"));
  const { port } = srv.address();
  try {
    assert.match(await getIp(port, "203.0.113.7"), /127\.0\.0\.1$/);
    assert.equal(await post(port, "1.1.1.1"), 200);
    assert.equal(await post(port, "2.2.2.2"), 200);
    assert.equal(await post(port, "3.3.3.3"), 429);
  } finally {
    srv.close();
  }
});

test("CIDR list that includes the peer: header is honoured", async () => {
  const srv = await listen(buildApp("127.0.0.1/32"));
  const { port } = srv.address();
  try {
    assert.equal(await getIp(port, "203.0.113.7"), "203.0.113.7");
    assert.equal(await post(port, "1.1.1.1"), 200);
    assert.equal(await post(port, "1.1.1.1"), 200);
    assert.equal(await post(port, "1.1.1.1"), 429);
    assert.equal(await post(port, "2.2.2.2"), 200);
  } finally {
    srv.close();
  }
});

test("applyTrustProxy with an invalid value throws before touching the app", () => {
  const app = express();
  assert.throws(() => applyTrustProxy(app, "true"), /FINOPS_TRUST_PROXY/);
  assert.equal(app.get("trust proxy"), false);
});

// ---- the real server (wiring in server/index.js) ---------------------------

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function serverEnv(dir, port, trust) {
  const env = {
    ...process.env,
    PORT: String(port),
    FINOPS_DB_PATH: path.join(dir, "t.db"),
    FINOPS_SPOOL_PATH: path.join(dir, "t.spool"),
    FINOPS_BACKUP_DIR: path.join(dir, "backups"),
  };
  delete env.FINOPS_DB_DRIVER;
  delete env.FINOPS_POSTGRES_URL;
  delete env.FINOPS_MULTI_TENANT;
  delete env.FINOPS_TRUST_PROXY;
  if (trust !== undefined) env.FINOPS_TRUST_PROXY = trust;
  return env;
}

function startReal(trust) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finops-trustproxy-"));
  return freePort().then((port) => {
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: ROOT, env: serverEnv(dir, port, trust), stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, port, dir, exited, log: () => out };
  });
}

async function waitStarted(s) {
  for (let i = 0; i < 100; i++) {
    if (/Dashboard:/.test(s.log())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`server did not start:\n${s.log()}`);
}

function forgot(port, xff) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: "nobody" });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (xff) headers["X-Forwarded-For"] = xff;
    const req = http.request({ host: "127.0.0.1", port, path: "/api/auth/forgot-password", method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function cleanup(s) {
  try { s.child.kill(); } catch { /* already gone */ }
  return s.exited.then(() => fs.rmSync(s.dir, { recursive: true, force: true }));
}

test("real server: an invalid FINOPS_TRUST_PROXY refuses to start with a clear message", async () => {
  const s = await startReal("true");
  const code = await Promise.race([
    s.exited,
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  const out = s.log();
  await cleanup(s);
  assert.notEqual(code, "timeout", `server kept running:\n${out}`);
  assert.notEqual(code, 0);
  assert.match(out, /FINOPS_TRUST_PROXY/);
  assert.doesNotMatch(out, /Dashboard:/);
});

test("real server: FINOPS_TRUST_PROXY=1 gives each forwarded client its own forgot-password budget", async () => {
  const s = await startReal("1");
  try {
    await waitStarted(s);
    for (let i = 0; i < 5; i++) assert.notEqual(await forgot(s.port, "1.1.1.1"), 429);
    assert.equal(await forgot(s.port, "1.1.1.1"), 429);
    assert.notEqual(await forgot(s.port, "2.2.2.2"), 429);
  } finally {
    await cleanup(s);
  }
});

test("real server: unset keeps today's behaviour (forwarded header ignored, one shared budget)", async () => {
  const s = await startReal(undefined);
  try {
    await waitStarted(s);
    for (let i = 0; i < 5; i++) assert.notEqual(await forgot(s.port, "1.1.1.1"), 429);
    assert.equal(await forgot(s.port, "2.2.2.2"), 429);
  } finally {
    await cleanup(s);
  }
});
