// governance.js - Rate Limiting as Code + Circuit Breaker + Quarantine Mode
//
// In-memory implementation (resets on server restart) - fine for a
// single-process self-hosted deployment. If you outgrow one process,
// swap the Maps below for Redis.
//
// Multi-tenant note: key_id values are globally unique (generateKey()/
// tenancy.createTenantApiKey() both mint 20 random bytes), so keying these
// Maps by keyId alone can never let one tenant's request be mistaken for
// another tenant's key - this was never a cross-tenant DATA leak. It was a
// cross-tenant BLAST-RADIUS problem: one process-global Map means one very
// noisy or malicious tenant's key churn grows a data structure every other
// tenant's requests also have to hash into, and there was no way to reason
// about, inspect, or clear "this one tenant's" governance state in
// isolation (e.g. when suspending or offboarding a tenant - see
// tenantLifecycle.js). Partitioned the same way cache.js's tenantStores
// already are: one bucket-map per tenant, keyed off tenantId, with a
// dedicated slot for single-tenant mode (NO_TENANT) so that deployment's
// behavior is byte-for-byte unchanged.

const { normalizeModelId } = require("./pricing");
const defaultDb = require("./storage");

const NO_TENANT = "__single_tenant__";

// ---- Rate limiting (token bucket per key) ----
// Prevents a recursive loop / bug from draining budget in minutes.
const tenantBuckets = new Map(); // tenantId -> Map(key -> { tokens, lastRefill })

function getBucketMap(tenantId) {
  const key = tenantId || NO_TENANT;
  let map = tenantBuckets.get(key);
  if (!map) {
    map = new Map();
    tenantBuckets.set(key, map);
  }
  return map;
}

const DEFAULT_LIMIT = {
  capacity: 60,       // max requests
  refillPerSec: 1,     // tokens added per second
};

function checkRateLimit(keyId, limit = DEFAULT_LIMIT, tenantId = null) {
  const buckets = getBucketMap(tenantId);
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
const tenantQuarantineBuckets = new Map(); // tenantId -> Map(keyId -> lastAllowedAt)

function getQuarantineMap(tenantId) {
  const key = tenantId || NO_TENANT;
  let map = tenantQuarantineBuckets.get(key);
  if (!map) {
    map = new Map();
    tenantQuarantineBuckets.set(key, map);
  }
  return map;
}

async function isQuarantined(keyId, db = defaultDb) {
  const row = await db.get("SELECT status FROM api_keys WHERE key_id = ?", [keyId]);
  return row?.status === "quarantined";
}

function checkQuarantineAllowance(keyId, tenantId = null) {
  const quarantineBuckets = getQuarantineMap(tenantId);
  const last = quarantineBuckets.get(keyId) || 0;
  const now = Date.now();
  if (now - last < 60_000) {
    return { allowed: false, retryAfterSec: Math.ceil((60_000 - (now - last)) / 1000) };
  }
  quarantineBuckets.set(keyId, now);
  return { allowed: true };
}

// Drops every in-memory rate-limit/quarantine bucket for one tenant - called
// when a tenant is suspended or offboarded (tenantLifecycle.js) so its
// governance state doesn't linger in the process after it can no longer
// authenticate anyway, and so a reactivated tenant starts with a clean
// bucket rather than whatever state it left behind. A no-op for tenantId
// values that were never seen (nothing to clear). Single-tenant mode never
// calls this - there's no lifecycle to offboard.
function clearTenantGovernanceState(tenantId) {
  const key = tenantId || NO_TENANT;
  tenantBuckets.delete(key);
  tenantQuarantineBuckets.delete(key);
}

async function quarantineKey(keyId, reason, db = defaultDb, alertDb = defaultDb) {
  await db.run(
    "UPDATE api_keys SET status = 'quarantined', quarantine_reason = ? WHERE key_id = ?",
    [reason, keyId]
  );
  await logAlert("quarantine", `Key ${keyId} quarantined: ${reason}`, alertDb);
}

async function approveKey(keyId, db = defaultDb) {
  await db.run(
    "UPDATE api_keys SET status = 'active', quarantine_reason = NULL WHERE key_id = ?",
    [keyId]
  );
}

// ---- Circuit breaker / graceful degradation ----
// If a team is over budget, route non-critical traffic to a cheaper fallback
// model instead of hard-cutting them off.
const FALLBACK_MODEL = {
  "openai/gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
  "anthropic/claude-opus": { provider: "anthropic", model: "claude-haiku" },
};

function getFallback(provider, model) {
  // Exact match first, then the normalized ID (strips a date snapshot / -latest),
  // so "gpt-4o-2024-08-06" degrades exactly like "gpt-4o" instead of silently
  // having no fallback and hitting the hard block instead.
  return (
    FALLBACK_MODEL[`${provider}/${model}`] ||
    FALLBACK_MODEL[`${provider}/${normalizeModelId(model)}`] ||
    null
  );
}

// ---- Alert log (shared by governance + budgets) ----
async function logAlert(type, message, db = defaultDb) {
  // Explicit ISO timestamp - see audit.js's logAudit for why (consistent
  // format regardless of backend, matching event_time's convention).
  await db.run(
    "INSERT INTO alerts_log (type, message, created_at) VALUES (?, ?, ?)",
    [type, message, new Date().toISOString()]
  );
}

module.exports = {
  checkRateLimit,
  isQuarantined,
  checkQuarantineAllowance,
  quarantineKey,
  approveKey,
  getFallback,
  logAlert,
  clearTenantGovernanceState,
};
