// test/governance.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-governance-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

test.after(() => {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

const db = require("../server/db");
const {
  checkRateLimit,
  isQuarantined,
  checkQuarantineAllowance,
  quarantineKey,
  approveKey,
  getFallback,
} = require("../server/governance");

test("checkRateLimit allows requests within capacity", () => {
  const result = checkRateLimit("test-key-1", { capacity: 5, refillPerSec: 1 });
  assert.equal(result.allowed, true);
});

test("checkRateLimit blocks once capacity is exhausted", () => {
  const limit = { capacity: 3, refillPerSec: 0 };
  for (let i = 0; i < 3; i++) {
    const r = checkRateLimit("test-key-2", limit);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = checkRateLimit("test-key-2", limit);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);
});

test("quarantineKey marks a key quarantined and isQuarantined reflects it", () => {
  db.prepare("INSERT INTO api_keys (key_id, label, role) VALUES (?, ?, ?)").run("qk_1", "test", "developer");
  assert.equal(isQuarantined("qk_1"), false);
  quarantineKey("qk_1", "suspicious activity");
  assert.equal(isQuarantined("qk_1"), true);
});

test("approveKey lifts quarantine status", () => {
  db.prepare("INSERT INTO api_keys (key_id, label, role) VALUES (?, ?, ?)").run("qk_2", "test2", "developer");
  quarantineKey("qk_2", "test");
  assert.equal(isQuarantined("qk_2"), true);
  approveKey("qk_2");
  assert.equal(isQuarantined("qk_2"), false);
});

test("checkQuarantineAllowance permits first request then blocks within 60s window", () => {
  const first = checkQuarantineAllowance("qk_3");
  assert.equal(first.allowed, true);
  const second = checkQuarantineAllowance("qk_3");
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterSec > 0 && second.retryAfterSec <= 60);
});

test("getFallback returns a cheaper model for known expensive models", () => {
  const fallback = getFallback("openai", "gpt-4o");
  assert.deepEqual(fallback, { provider: "openai", model: "gpt-4o-mini" });
});

test("getFallback returns null for a model with no defined fallback", () => {
  const fallback = getFallback("openai", "some-unmapped-model");
  assert.equal(fallback, null);
});
