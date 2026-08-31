// semanticCache.js - opt-in NEAR-DUPLICATE prompt caching for the proxy.
//
// HONEST SCOPE NOTE: separate from cache.js (exact-match only). This module
// matches prompts that are SIMILAR but not identical - e.g. the same
// question reworded. Two modes:
//
//   "local" (default) - zero-dependency term-frequency cosine similarity.
//   Catches reworded-but-lexically-similar prompts. Does NOT understand
//   real semantic meaning ("cat" vs "feline" won't match) - it's word
//   overlap, not embeddings.
//
//   "embedding" - calls OpenAI's embeddings API for a real semantic vector.
//   Requires FINOPS_EMBEDDING_API_KEY (a real OpenAI key, used ONLY to
//   compute embeddings, kept separate from the per-request X-Provider-Key
//   which is never stored). Anthropic has no first-party embeddings
//   endpoint, so Anthropic proxy requests use OpenAI's embeddings API too
//   when this mode is active. If the key is missing or a request fails,
//   this silently falls back to local mode (logged once, not per-request).
//
// A semantic HIT returns a response to a DIFFERENT (similar) prompt than
// what was actually asked - a bigger trust assumption than exact-match, so
// it needs its own opt-in header (X-Enable-Semantic-Cache), separate from
// X-Enable-Cache.

const MODE = (process.env.FINOPS_SEMANTIC_CACHE_MODE || "local").toLowerCase();
const THRESHOLD = Number(process.env.FINOPS_SEMANTIC_CACHE_THRESHOLD) || (MODE === "embedding" ? 0.90 : 0.92);
const EMBEDDING_API_KEY = process.env.FINOPS_EMBEDDING_API_KEY || null;
const DEFAULT_TTL_SECONDS = 300;

const store = []; // { provider, model, promptText, vectorType, vector, value, expiresAt }
const stats = { hits: 0, misses: 0 };
let warnedEmbeddingFailure = false;

// Pulls plain text out of an OpenAI or Anthropic chat request body so it
// can be tokenized/embedded, regardless of which shape it came in.
function extractPromptText(body) {
  const parts = [];
  if (typeof body?.system === "string") parts.push(body.system);
  else if (Array.isArray(body?.system)) {
    for (const block of body.system) if (typeof block?.text === "string") parts.push(block.text);
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const msg of messages) {
    const content = msg?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === "string") parts.push(block.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function termFrequency(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function cosineSimilarityLocal(tfA, tfB) {
  let dot = 0, normA = 0, normB = 0;
  for (const [term, count] of tfA) {
    normA += count * count;
    if (tfB.has(term)) dot += count * tfB.get(term);
  }
  for (const count of tfB.values()) normB += count * count;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cosineSimilarityEmbedding(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getEmbedding(text, apiKey) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`Embedding request failed: HTTP ${res.status}`);
  const json = await res.json();
  const vector = json?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("Embedding response missing vector");
  return vector;
}

async function computeVector(text, mode, embeddingApiKey) {
  if (mode === "embedding" && embeddingApiKey) {
    try {
      const vector = await getEmbedding(text, embeddingApiKey);
      return { vectorType: "embedding", vector };
    } catch (err) {
      if (!warnedEmbeddingFailure) {
        console.warn(`[semanticCache] Embedding request failed, falling back to local mode for this and future requests until resolved: ${err.message}`);
        warnedEmbeddingFailure = true;
      }
    }
  }
  return { vectorType: "local", vector: termFrequency(tokenize(text)) };
}

function pruneExpired() {
  const now = Date.now();
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].expiresAt <= now) store.splice(i, 1);
  }
}

async function findSemanticMatch(provider, model, promptText, options = {}) {
  const mode = options.mode || MODE;
  const threshold = options.threshold ?? THRESHOLD;
  const embeddingApiKey = options.embeddingApiKey ?? EMBEDDING_API_KEY;

  pruneExpired();
  const { vectorType, vector } = await computeVector(promptText, mode, embeddingApiKey);

  let best = null;
  for (const entry of store) {
    if (entry.provider !== provider || entry.model !== model) continue;
    if (entry.vectorType !== vectorType) continue; // different vector spaces aren't comparable
    const sim = vectorType === "embedding"
      ? cosineSimilarityEmbedding(vector, entry.vector)
      : cosineSimilarityLocal(vector, entry.vector);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { value: entry.value, similarity: sim };
    }
  }

  if (best) stats.hits++;
  else stats.misses++;
  return best;
}

async function setSemanticCache(provider, model, promptText, value, ttlSeconds, options = {}) {
  const mode = options.mode || MODE;
  const embeddingApiKey = options.embeddingApiKey ?? EMBEDDING_API_KEY;

  pruneExpired();
  const { vectorType, vector } = await computeVector(promptText, mode, embeddingApiKey);
  store.push({
    provider,
    model,
    promptText,
    vectorType,
    vector,
    value,
    expiresAt: Date.now() + (ttlSeconds || DEFAULT_TTL_SECONDS) * 1000,
  });
}

function getSemanticCacheStats() {
  pruneExpired();
  return {
    hits: stats.hits,
    misses: stats.misses,
    hit_rate_pct: stats.hits + stats.misses > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0,
    current_size: store.length,
    mode: MODE,
    threshold: THRESHOLD,
  };
}

function clearSemanticCache() {
  store.length = 0;
  stats.hits = 0;
  stats.misses = 0;
}

setInterval(pruneExpired, 5 * 60 * 1000).unref();

module.exports = {
  findSemanticMatch,
  setSemanticCache,
  getSemanticCacheStats,
  clearSemanticCache,
  extractPromptText,
  tokenize,
  termFrequency,
  cosineSimilarityLocal,
  cosineSimilarityEmbedding,
  MODE,
  THRESHOLD,
};
