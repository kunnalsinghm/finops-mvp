// test/shutdownUnit.test.js - server/shutdown.js in-process, with a fake server.
// The end-to-end behaviour (real SIGTERM, real provider call) is in
// gracefulShutdown.test.js; this pins the ordering and failure handling that
// are awkward to provoke through a real process.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finops-shutdown-unit-"));
process.env.FINOPS_DB_PATH = path.join(dir, "t.db");
delete process.env.FINOPS_DB_DRIVER;
delete process.env.FINOPS_MULTI_TENANT;

const shutdown = require("../server/shutdown");
const silent = { info() {}, warn() {}, error() {} };

test.after(() => {
  try { require("../server/db").close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeServer({ closesAfterMs }) {
  const calls = [];
  return {
    calls,
    close(cb) {
      calls.push("close");
      if (closesAfterMs !== undefined) setTimeout(cb, closesAfterMs);
    },
    closeIdleConnections() { calls.push("closeIdle"); },
    closeAllConnections() { calls.push("closeAll"); },
  };
}

test("parseGraceMs: valid values pass through; invalid, zero and negative fall back to the default", () => {
  assert.equal(shutdown.parseGraceMs("1500"), 1500);
  for (const bad of [undefined, "", "abc", "0", "-5", "NaN", null]) {
    assert.equal(shutdown.parseGraceMs(bad), shutdown.DEFAULT_GRACE_MS, `input ${JSON.stringify(bad)}`);
  }
});

test("clean drain: closers run in order after the server drains, exit code 0, closeAll never called", async () => {
  const server = fakeServer({ closesAfterMs: 20 });
  const order = [];
  let exitCode;
  const done = new Promise((resolve) => {
    const h = shutdown.createShutdown({
      server, graceMs: 5000, log: silent,
      closers: [async () => order.push("a"), async () => order.push("b")],
      exit: (c) => { exitCode = c; resolve(); },
    });
    h.begin("SIGTERM");
  });
  await done;
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(exitCode, 0);
  assert.ok(!server.calls.includes("closeAll"));
  assert.equal(shutdown.isShuttingDown(), true);
});

test("a closer that throws does not stop the later closers", async () => {
  const server = fakeServer({ closesAfterMs: 0 });
  const order = [];
  const errors = [];
  let exitCode;
  await new Promise((resolve) => {
    shutdown.createShutdown({
      server, graceMs: 5000, log: { ...silent, error: (m) => errors.push(m) },
      closers: [async () => { throw new Error("boom"); }, async () => order.push("second")],
      exit: (c) => { exitCode = c; resolve(); },
    }).begin("SIGTERM");
  });
  assert.deepEqual(order, ["second"]);
  assert.equal(errors.length, 1);
  assert.equal(exitCode, 0);
});

test("grace expiry: connections are cut, closers still run, exit code is 1", async () => {
  const server = fakeServer({}); // never finishes draining
  const order = [];
  let exitCode;
  const t0 = Date.now();
  await new Promise((resolve) => {
    shutdown.createShutdown({
      server, graceMs: 100, log: silent,
      closers: [async () => order.push("closer")],
      exit: (c) => { exitCode = c; resolve(); },
    }).begin("SIGTERM");
  });
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(server.calls.includes("closeAll"));
  assert.deepEqual(order, ["closer"]);
  assert.equal(exitCode, 1);
});

test("begin() is idempotent: a second call neither re-closes nor re-runs closers", async () => {
  const server = fakeServer({ closesAfterMs: 30 });
  let closerRuns = 0;
  let exits = 0;
  const h = shutdown.createShutdown({
    server, graceMs: 5000, log: silent,
    closers: [async () => { closerRuns++; }],
    exit: () => { exits++; },
  });
  await Promise.all([h.begin("SIGTERM"), h.begin("SIGTERM"), h.begin("SIGINT")]);
  assert.equal(closerRuns, 1);
  assert.equal(exits, 1);
  assert.equal(server.calls.filter((c) => c === "close").length, 1);
});

test("once draining, GET /health/ready answers 503 'shutting down'", async () => {
  // shuttingDown is already true: the tests above called begin() in this process.
  assert.equal(shutdown.isShuttingDown(), true);
  const express = require("express");
  const app = express();
  app.use("/health", require("../server/routes/health"));
  const srv = await new Promise((r) => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const res = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: srv.address().port, path: "/health/ready" }, (r) => {
        let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => resolve({ status: r.statusCode, body: JSON.parse(t) }));
      });
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.checks.shutdown.reason, "shutting down");
  } finally {
    srv.close();
  }
});
