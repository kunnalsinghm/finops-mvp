// test/gracefulShutdown.test.js - SIGTERM must drain, not kill.
//
// The proxy calls the provider FIRST and meters AFTER. Before this change a
// SIGTERM (scale-down, rolling deploy) during a provider call killed the
// process in between: the client got ECONNRESET and the money the provider
// had already billed was never recorded - not even in the spool. Measured:
// 0 usage rows, 0 spooled lines, vs 1 row in the no-signal control.
//
// These tests start the REAL server (server/index.js) as a child process
// against a slow mock provider and send it a real SIGTERM.
//
// POSIX only: on Windows, process.kill("SIGTERM") terminates the process
// unconditionally and never runs a handler, so the behaviour cannot be
// exercised there. Production targets are Linux containers.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const skip = process.platform === "win32" ? "SIGTERM semantics differ on Windows" : false;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function slowProvider(delayMs) {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () =>
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          id: "x", model: "gpt-4o",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }));
      }, delayMs));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

async function startServer({ providerPort, graceMs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finops-shutdown-"));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    FINOPS_DB_PATH: path.join(dir, "t.db"),
    FINOPS_SPOOL_PATH: path.join(dir, "t.spool"),
    OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
    FINOPS_BACKUP_DIR: path.join(dir, "backups"), // never touch the repo's data/backups
  };
  if (graceMs !== undefined) env.FINOPS_SHUTDOWN_GRACE_MS = String(graceMs);
  delete env.FINOPS_DB_DRIVER;
  delete env.FINOPS_POSTGRES_URL;
  delete env.FINOPS_MULTI_TENANT;
  const child = spawn(process.execPath, ["server/index.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 100; i++) {
    if (/Dashboard:/.test(out)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(out, /Dashboard:/, `server did not start:\n${out}`);
  return { child, port, dir, exited, log: () => out };
}

function request(port, pathname, { method = "GET", body } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, path: pathname, method,
      headers: { "Content-Type": "application/json", "X-Provider-Key": "sk-test", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, text: t, connection: res.headers.connection }));
    });
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    req.end(data);
  });
}

function usageRows(dir) {
  const d = new DatabaseSync(path.join(dir, "t.db"));
  try {
    return d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS c FROM usage_events").get();
  } finally {
    d.close();
  }
}

const CHAT = { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] };

test("REGRESSION: SIGTERM during an in-flight provider call lets it finish and meters it", { skip }, async () => {
  const provider = await slowProvider(1500);
  const s = await startServer({ providerPort: provider.address().port });
  try {
    const inflight = request(s.port, "/api/proxy/openai", { method: "POST", body: CHAT });
    await new Promise((r) => setTimeout(r, 500)); // provider call is now in flight
    s.child.kill("SIGTERM");
    const res = await inflight;
    assert.equal(res.error, undefined, `client was cut off: ${res.error}`);
    assert.equal(res.status, 200);
    const { code, signal } = await s.exited;
    assert.equal(signal, null, "process was killed by a signal instead of exiting on its own");
    assert.equal(code, 0, `expected a clean exit, got ${code}\n${s.log()}`);
    const rows = usageRows(s.dir);
    assert.equal(rows.n, 1, "the billed call must be recorded");
    assert.ok(rows.c > 0, "cost must be recorded");
  } finally {
    s.child.kill("SIGKILL");
    provider.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("while draining: readiness fails (503) and new requests are refused", { skip }, async () => {
  const provider = await slowProvider(1500);
  const s = await startServer({ providerPort: provider.address().port });
  try {
    assert.equal((await request(s.port, "/health/ready")).status, 200, "ready before SIGTERM");
    const inflight = request(s.port, "/api/proxy/openai", { method: "POST", body: CHAT });
    await new Promise((r) => setTimeout(r, 400));
    s.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    // The listener is closed: a NEW connection is refused outright.
    const fresh = await request(s.port, "/health/ready");
    assert.ok(fresh.error === "ECONNREFUSED" || fresh.status === 503, `new connection during drain: ${JSON.stringify(fresh)}`);
    assert.equal((await inflight).status, 200);
    assert.equal((await s.exited).code, 0);
  } finally {
    s.child.kill("SIGKILL");
    provider.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a request that outlives FINOPS_SHUTDOWN_GRACE_MS is cut off and the process still exits (non-zero)", { skip }, async () => {
  const provider = await slowProvider(8000);
  const s = await startServer({ providerPort: provider.address().port, graceMs: 700 });
  try {
    const inflight = request(s.port, "/api/proxy/openai", { method: "POST", body: CHAT });
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    s.child.kill("SIGTERM");
    const { code, signal } = await s.exited;
    const took = Date.now() - t0;
    assert.equal(signal, null, "must exit by itself, not be killed");
    assert.notEqual(code, 0, "a forced shutdown must not look like a clean one");
    assert.ok(took < 4000, `exit took ${took}ms; the grace period was 700ms`);
    assert.ok((await inflight).error, "the hung client should have been disconnected");
  } finally {
    s.child.kill("SIGKILL");
    provider.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a second SIGTERM while draining is harmless (idempotent)", { skip }, async () => {
  const provider = await slowProvider(1200);
  const s = await startServer({ providerPort: provider.address().port });
  try {
    const inflight = request(s.port, "/api/proxy/openai", { method: "POST", body: CHAT });
    await new Promise((r) => setTimeout(r, 400));
    s.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    s.child.kill("SIGTERM");
    assert.equal((await inflight).status, 200);
    assert.equal((await s.exited).code, 0);
    assert.equal(usageRows(s.dir).n, 1);
  } finally {
    s.child.kill("SIGKILL");
    provider.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});
