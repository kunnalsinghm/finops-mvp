// governance.js - Rate Limiting as Code + Circuit Breaker + Quarantine Mode
//
// In-memory implementation (resets on server restart) - fine for a
// single-process self-hosted deployment. If you outgrow one process,
// swap the Maps below for Redis.

const db = require("./db");

// ---- Rate limiting (token bucket per key) ----
// Prevents a recursive loop / bug from draining budget in minutes.
const buckets = new Map(); // key -> { tokens, lastRefill }

const DEFAULT_LIMIT = {
  capacity: 60,       // max requests
  refillPerSec: 1,     // tokens added per second
};

function checkRateLimit(keyId, limit = DEFAULT_LIMIT) {
  const now = Date.now();
  let bucket = buckets.get(keyId);
  if (!bucket) {
    bucket = { tokens: limit.capacity, lastRefill: now };
    buckets.set(keyId, bucket);
  }
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(limit.capacity, bucket.tokens + elapsedSec * limit.refillPerSec);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    return { allowed: false, retryAfterSec: Math.ceil((1 - bucket.tokens) / limit.refillPerSec) };
  }
  bucket.tokens -= 1;
  return { allowed: true };
}

// ---- Quarantine mode ----
// An isolated key can only make 1 request/minute until a human approves it.
const quarantineBuckets = new Map(); // keyId -> lastAllowedAt

function isQuarantined(keyId) {
  const row = db.prepare("SELECT status FROM api_keys WHERE key_id = ?").get(keyId);
  return row?.status === "quarantined";
}

function checkQuarantineAllowance(keyId) {
  const last = quarantineBuckets.get(keyId) || 0;
  const now = Date.now();
  if (now - last < 60_000) {
    return { allowed: false, retryAfterSec: Math.ceil((60_000 - (now - last)) / 1000) };
  }
  quarantineBuckets.set(keyId, now);
  return { allowed: true };
}

function quarantineKey(keyId, reason) {
  db.prepare(
    "UPDATE api_keys SET status = 'quarantined', quarantine_reason = ? WHERE key_id = ?"
  ).run(reason, keyId);
  logAlert("quarantine", `Key ${keyId} quarantined: ${reason}`);
}

function approveKey(keyId) {
  db.prepare(
    "UPDATE api_keys SET status = 'active', quarantine_reason = NULL WHERE key_id = ?"
  ).run(keyId);
}

// ---- Circuit breaker / graceful degradation ----
// If a team is over budget, route non-critical traffic to a cheaper fallback
// model instead of hard-cutting them off.
const FALLBACK_MODEL = {
  "openai/gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
  "anthropic/claude-opus": { provider: "anthropic", model: "claude-haiku" },
};

function getFallback(provider, model) {
  return FALLBACK_MODEL[`${provider}/${model}`] || null;
}

// ---- Alert log (shared by governance + budgets) ----
const insertAlert = db.prepare(
  "INSERT INTO alerts_log (type, message, created_at) VALUES (?, ?, datetime('now'))"
);

function logAlert(type, message) {
  insertAlert.run(type, message);
}

module.exports = {
  checkRateLimit,
  isQuarantined,
  checkQuarantineAllowance,
  quarantineKey,
  approveKey,
  getFallback,
  logAlert,
};