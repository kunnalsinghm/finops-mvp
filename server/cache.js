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

const crypto = require("crypto");

const store = new Map(); // key -> { value, expiresAt }
const stats = { hits: 0, misses: 0 };

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

function makeCacheKey(provider, model, body) {
  const { stream, stream_options, ...cacheable } = body || {};
  const normalized = JSON.stringify({ provider, model, ...cacheable });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function getCached(key) {
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

function setCached(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function getCacheStats() {
  return {
    hits: stats.hits,
    misses: stats.misses,
    hit_rate_pct: stats.hits + stats.misses > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0,
    current_size: store.size,
  };
}

function clearCache() {
  store.clear();
  stats.hits = 0;
  stats.misses = 0;
}

module.exports = { makeCacheKey, getCached, setCached, getCacheStats, clearCache };