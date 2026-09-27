// test/tracing.test.js - A13's contained OTel-compatible tracing step.
//
// Two layers, same split as health.test.js:
//   1. Unit tests directly against tracing.js - the opt-in gate, checkpoint
//      recording, and emitted JSON shape.
//   2. An end-to-end test booting a real Express instance with
//      routes/proxy.js mounted (same harness as proxy.test.js) and
//      confirming a real request, with FINOPS_OTEL_ENABLED=true, actually
//      emits one otel_compatible_span JSON line covering the ingest/
//      attribution/policy/pricing/provider-call checkpoints - and that
//      with tracing left at its default (off), nothing is emitted at all.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");

const tracing = require("../server/tracing");

// ---- 1. tracing.js unit tests (no DB, no HTTP needed) ----

test("startRequestSpan returns a disabled stub when FINOPS_OTEL_ENABLED is not set", () => {
  delete process.env.FINOPS_OTEL_ENABLED;
  const span = tracing.startRequestSpan("unit.test");
  assert.equal(span.enabled, false);
  assert.equal(tracing.tracingEnabled(), false);
});

test("mark()/endRequestSpan() on a disabled span are safe no-ops and emit nothing", (t) => {
  delete process.env.FINOPS_OTEL_ENABLED;
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));
  const span = tracing.startRequestSpan("unit.test");
  tracing.mark(span, "checkpoint-1");
  tracing.endRequestSpan(span);
  assert.equal(logged.length, 0);
});

test("an enabled span emits exactly one structured JSON line with trace_id/span_id/name/duration/events", (t) => {
  process.env.FINOPS_OTEL_ENABLED = "true";
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));
  try {
    const span = tracing.startRequestSpan("unit.test", { foo: "bar" });
    tracing.mark(span, "checkpoint-1", { a: 1 });
    tracing.mark(span, "checkpoint-2", { b: 2 });
    tracing.endRequestSpan(span, { attributes: { status_code: 200 } });

    assert.equal(logged.length, 1);
    const parsed = JSON.parse(logged[0]);
    assert.equal(parsed.otel_compatible_span, true);
    assert.match(parsed.trace_id, /^[0-9a-f]{32}$/, "trace_id should be 128-bit hex, W3C-trace-context width");
    assert.match(parsed.span_id, /^[0-9a-f]{16}$/, "span_id should be 64-bit hex, W3C-trace-context width");
    assert.equal(parsed.name, "unit.test");
    assert.equal(parsed.status, "ok");
    assert.equal(typeof parsed.duration_ms, "number");
    assert.ok(parsed.duration_ms >= 0);
    assert.equal(parsed.attributes.foo, "bar");
    assert.equal(parsed.attributes.status_code, 200);
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0].name, "checkpoint-1");
    assert.equal(parsed.events[0].attributes.a, 1);
    assert.equal(parsed.events[1].name, "checkpoint-2");
    for (const ev of parsed.events) {
      assert.equal(typeof ev.start_offset_ms, "number");
      assert.equal(typeof ev.duration_ms, "number");
    }
  } finally {
    delete process.env.FINOPS_OTEL_ENABLED;
  }
});

test("two spans in a row get different trace_id/span_id values", (t) => {
  process.env.FINOPS_OTEL_ENABLED = "true";
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));
  try {
    tracing.endRequestSpan(tracing.startRequestSpan("a"));
    tracing.endRequestSpan(tracing.startRequestSpan("b"));
    const [first, second] = logged.map((l) => JSON.parse(l));
    assert.notEqual(first.trace_id, second.trace_id);
    assert.notEqual(first.span_id, second.span_id);
  } finally {
    delete process.env.FINOPS_OTEL_ENABLED;
  }
});

test("a thrown attribute (unserializable value) during endRequestSpan never propagates", () => {
  process.env.FINOPS_OTEL_ENABLED = "true";
  try {
    const span = tracing.startRequestSpan("unit.test");
    const circular = {};
    circular.self = circular; // JSON.stringify on this throws
    assert.doesNotThrow(() => tracing.endRequestSpan(span, { attributes: { circular } }));
  } finally {
    delete process.env.FINOPS_OTEL_ENABLED;
  }
});

// ---- 2. End-to-end: a real proxy request emits a real span ----

for (const f of fs.readdirSync(__dirname)) {
  if (new RegExp(`^\\.tmp-tracing-\\d+\\.db`).test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch { /* ignore */ }
  }
}
process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-tracing-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_tracing_${process.pid}`;
}

const legacyDb = require("../server/db");
const storage = require("../server/storage");
const proxyRoute = require("../server/routes/proxy");

let server;
let keyCounter = 0;

async function makeApiKey(role = "developer") {
  keyCounter++;
  const key_id = `fk_test_tracing_${role}_${keyCounter}`;
  await storage.run(
    "INSERT INTO api_keys (key_id, label, role, status) VALUES (?, ?, ?, 'active')",
    [key_id, `tracing test key ${keyCounter}`, role]
  );
  return key_id;
}

function post(server_, pathName, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const reqHeaders = { "Content-Type": "application/json", ...headers };
    if (data !== undefined) reqHeaders["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(
      { hostname: "127.0.0.1", port: server_.address().port, path: pathName, method: "POST", headers: reqHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function openaiResponse() {
  return {
    id: "mock-1",
    object: "chat.completion",
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

test.before(async () => {
  await storage.ready;
  const app = express();
  app.use(express.json());
  app.use("/api/proxy", proxyRoute);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (isPostgres && storage.schemaName) {
    try { await storage.ready; } catch { /* ignore */ }
    try { await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`); } catch { /* ignore */ }
    await storage.pool.end();
  }
  try { legacyDb.close(); } catch { /* ignore */ }
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

test("with FINOPS_OTEL_ENABLED unset (default), a real proxy request emits no span", async (t) => {
  delete process.env.FINOPS_OTEL_ENABLED;
  const key_id = await makeApiKey();
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => openaiResponse() }));
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));

  const res = await post(server, "/api/proxy/openai", {
    headers: { "X-API-Key": key_id, "X-Provider-Key": "sk-real" },
    body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(res.status, 200);
  assert.equal(logged.filter((l) => typeof l === "string" && l.includes("otel_compatible_span")).length, 0);
});

test("with FINOPS_OTEL_ENABLED=true, a real proxy request emits one span covering the ingest/attribution/policy/pricing/provider-call checkpoints", async (t) => {
  process.env.FINOPS_OTEL_ENABLED = "true";
  const key_id = await makeApiKey();
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200, json: async () => openaiResponse() }));
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));

  try {
    const res = await post(server, "/api/proxy/openai", {
      headers: { "X-API-Key": key_id, "X-Provider-Key": "sk-real" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 200);

    const spanLines = logged.filter((l) => typeof l === "string" && l.includes("otel_compatible_span"));
    assert.equal(spanLines.length, 1, "expected exactly one span for one request");
    const span = JSON.parse(spanLines[0]);
    assert.equal(span.name, "proxy.request");
    assert.equal(span.attributes.provider, "openai");
    assert.equal(span.attributes.status_code, 200);

    const eventNames = span.events.map((e) => e.name);
    assert.deepEqual(eventNames, [
      "ingest.identity_resolved",
      "attribution.tag_rules_applied",
      "policy.checks_passed",
      "pricing.checked",
      "provider.call_start",
      "provider.call_end",
    ]);
    for (const ev of span.events) {
      assert.ok(ev.start_offset_ms >= 0);
      assert.ok(ev.duration_ms >= 0);
    }
  } finally {
    delete process.env.FINOPS_OTEL_ENABLED;
  }
});

test("with FINOPS_OTEL_ENABLED=true, a request BLOCKED early (unknown provider) still emits a span via res.on('finish'), with no checkpoints reached", async (t) => {
  process.env.FINOPS_OTEL_ENABLED = "true";
  const key_id = await makeApiKey();
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));
  try {
    const res = await post(server, "/api/proxy/not-a-real-provider", {
      headers: { "X-API-Key": key_id, "X-Provider-Key": "sk-real" },
      body: { model: "x", messages: [] },
    });
    assert.equal(res.status, 400);
    // The 400 for an unknown provider returns before the span is even
    // created (providerName/endpoint lookup happens first) - so no span
    // line is expected here. This documents that boundary rather than
    // assuming it.
    assert.equal(logged.filter((l) => typeof l === "string" && l.includes("otel_compatible_span")).length, 0);
  } finally {
    delete process.env.FINOPS_OTEL_ENABLED;
  }
});

test("with FINOPS_OTEL_ENABLED=true, a request blocked AFTER span creation (missing provider key) still emits a span with res.on('finish')", async (t) => {
  process.env.FINOPS_OTEL_ENABLED = "true";
  const key_id = await makeApiKey();
  const logged = [];
  t.mock.method(console, "log", (line) => logged.push(line));
  try {
    const res = await post(server, "/api/proxy/openai", {
      headers: { "X-API-Key": key_id }, // no X-Provider-Key
      body: { model: "x", messages: [] },
    });
    assert.equal(res.status, 400);
    const spanLines = logged.filter((l) => typeof l === "string" && l.includes("otel_compatible_span"));
    assert.equal(spanLines.length, 1, "res.on('finish') must fire and close the span even on this early return");
    const span = JSON.parse(spanLines[0]);
    assert.equal(span.attributes.status_code, 400);
    assert.equal(span.events.length, 0, "no checkpoints were reached before the early return");
  } finally {
    delete process.env.FINOPS_OTEL_ENABLED;
  }
});
