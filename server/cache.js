// cache.js - real request/response caching for the proxy (not just detection).
//
// HONEST SCOPE NOTE: this is EXACT-MATCH caching (same provider + model +
// message content -> same cached response), not true semantic caching
// (which would match near-duplicate prompts via embeddings and needs a
// vector store - a heavier dependency than fits "free/local, zero extra
// services"). Exact-match still captures the common case the blueprint's
// caching heuristic flags: templated/repeated prompts (e.g. the same
// classification prompt run on a schedule, or a chatbot's fixed system
// greeting). It will NOT catch "same question, different wording."
//
// Caching is OPT-IN per request (header X-Enable-Cache: true) rather than
// automatic. Silently returning a cached response as if it were fresh could
// surprise a caller who expects a new completion each time (e.g. a chatbot
// that should vary its phrasing) - opt-in keeps that a deliberate choice.

// Multi-tenant note: this cache is in-memory and PROCESS-GLOBAL (one Node
// process can serve many tenants in multi-tenant mode). Without a tenant
// discriminator in the cache key, two tenants making byte-identical
// requests (same provider/model/body) would silently receive each other's
// cached response - a real cross-tenant data leak, not just a stats
// nuisance. tenantId defaults to null (single-tenant mode: everyone is
// implicitly "the one tenant", so this is a no-op there) but every
// multi-tenant call site MUST pass req.tenantId.
//
// Stats and clear() are ALSO split per tenant (a Map of tenantId -> state)
// rather than one global counter, so a tenant can't see or wipe another
// tenant's cache stats via GET/POST /api/cache/*.

const crypto = require("crypto");

const NO_TENANT = "__single_tenant__";
const tenantStores = new Map(); // tenantId -> { store: Map, stats: {hits, misses} }

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

function getTenantState(tenantId) {
  const key = tenantId || NO_TENANT;
  let state = tenantStores.get(key);
  if (!state) {
    state = { store: new Map(), stats: { hits: 0, misses: 0 } };
    tenantStores.set(key, state);
  }
  return state;
}

function makeCacheKey(provider, model, body, tenantId = null) {
  const { stream, stream_options, ...cacheable } = body || {};
  const normalized = JSON.stringify({ tenantId: tenantId || NO_TENANT, provider, model, ...cacheable });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function getCached(key, tenantId = null) {
  const { store, stats } = getTenantState(tenantId);
  const entry = store.get(key);
  if (!entry) {
    stats.misses++;
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    stats.misses++;
    return null;
  }
  stats.hits++;
  return entry.value;
}

function setCached(key, value, ttlSeconds = DEFAULT_TTL_SECONDS, tenantId = null) {
  const { store } = getTenantState(tenantId);
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function getCacheStats(tenantId = null) {
  const { store, stats } = getTenantState(tenantId);
  return {
    hits: stats.hits,
    misses: stats.misses,
    hit_rate_pct: stats.hits + stats.misses > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0,
    current_size: store.size,
  };
}

function clearCache(tenantId = null) {
  const { store, stats } = getTenantState(tenantId);
  store.clear();
  stats.hits = 0;
  stats.misses = 0;
}

module.exports = { makeCacheKey, getCached, setCached, getCacheStats, clearCache };