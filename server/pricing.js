// pricing.js - Pricing Catalogue Engine (Phase 1)
//
// Ships with a static baseline catalogue (update these numbers periodically -
// see README for where to check current vendor pricing) PLUS a manual override
// table, since the blueprint flagged auto-scraped pricing as a trust-risk if
// it silently goes stale. Overrides always win.

const defaultDb = require("./storage");

// Baseline rates in USD per 1,000 tokens. THESE ARE ILLUSTRATIVE PLACEHOLDERS -
// check current vendor pricing pages before relying on them for real billing,
// and use the override table (POST /api/pricing/override) to correct them.
const BASELINE_CATALOGUE = {
  openai: {
    "gpt-4o": { input_per_1k: 0.0025, output_per_1k: 0.01 },
    "gpt-4o-mini": { input_per_1k: 0.00015, output_per_1k: 0.0006 },
    // --- Added in the governance-hardening pass: real model IDs that were
    // previously unpriced (and therefore silently metered as $0). Snapshot
    // as of 2026-09-19, cross-checked across several published price lists -
    // NOT read from a provider's own billing API, so re-verify before
    // relying on them for invoicing, and use POST /api/pricing/override to
    // correct any rate that drifts. Models whose published rates disagreed
    // between sources (e.g. promotional tiers) are deliberately left out so
    // they surface as "unpriced" instead of being guessed.
    "gpt-4.1": { input_per_1k: 0.002, output_per_1k: 0.008 },
    "gpt-4.1-mini": { input_per_1k: 0.0004, output_per_1k: 0.0016 },
    "gpt-4.1-nano": { input_per_1k: 0.0001, output_per_1k: 0.0004 },
    "o3": { input_per_1k: 0.002, output_per_1k: 0.008 },
    "o4-mini": { input_per_1k: 0.0011, output_per_1k: 0.0044 },
    "gpt-5": { input_per_1k: 0.00125, output_per_1k: 0.01 },
    "gpt-5-mini": { input_per_1k: 0.00025, output_per_1k: 0.002 },
    "gpt-5-nano": { input_per_1k: 0.00005, output_per_1k: 0.0004 },
    "gpt-5.1": { input_per_1k: 0.00125, output_per_1k: 0.01 },
    "gpt-5.2": { input_per_1k: 0.00175, output_per_1k: 0.014 },
    "gpt-5.4": { input_per_1k: 0.0025, output_per_1k: 0.015 },
    "gpt-5.4-mini": { input_per_1k: 0.00075, output_per_1k: 0.0045 },
    "gpt-5.4-nano": { input_per_1k: 0.0002, output_per_1k: 0.00125 },
    "gpt-5.5": { input_per_1k: 0.005, output_per_1k: 0.03 },
  },
  anthropic: {
    "claude-opus": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-haiku": { input_per_1k: 0.0008, output_per_1k: 0.004 },
    // Real Anthropic model IDs (same 2026-09-19 snapshot caveats as above).
    // NOTE the generic "claude-opus" placeholder above is $15/$75, which is
    // the LEGACY Opus 4/4.1 rate - current Opus models (4.5 and later) are
    // $5/$25, hence the explicit per-model entries below rather than
    // relying on the family fallback in getRate().
    "claude-opus-5": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-8": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-7": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-6": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-5": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-1": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-opus-4": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-3-opus": { input_per_1k: 0.015, output_per_1k: 0.075 },
    // Sonnet 5 had a time-limited introductory rate through 2026-08-31;
    // this is the standard rate that applies afterward. Sources still
    // disagree on which is current - verify against Anthropic's pricing page.
    "claude-sonnet-5": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-sonnet-4-6": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-sonnet-4-5": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-sonnet-4": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-3-7-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-3-5-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-haiku-4-5": { input_per_1k: 0.001, output_per_1k: 0.005 },
    "claude-3-5-haiku": { input_per_1k: 0.0008, output_per_1k: 0.004 },
    "claude-3-haiku": { input_per_1k: 0.00025, output_per_1k: 0.00125 },
    "claude-fable-5": { input_per_1k: 0.01, output_per_1k: 0.05 },
    "claude-fable-5-1": { input_per_1k: 0.01, output_per_1k: 0.05 },
  },
  bedrock: {
    "titan-text-express": { input_per_1k: 0.0002, output_per_1k: 0.0006 },
  },
};

// Real provider model IDs rarely match a catalogue key byte-for-byte:
// "gpt-4o-2024-08-06", "claude-sonnet-4-5-20250929", "claude-opus-4-5-latest".
// Strip the date / "-latest" suffix so a dated snapshot of a known model is
// priced as that model, EXACTLY (not approximately).
function normalizeModelId(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/-latest$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "") // gpt-4o-2024-08-06
    .replace(/-\d{8}$/, ""); // claude-sonnet-4-5-20250929
}

// Longest catalogue key K such that model starts with "K-" (e.g. a future
// "claude-sonnet-5-2" falls back to the "claude-sonnet-5" family). This is a
// GUESS by construction - a new generation may be priced differently - so the
// caller gets approximate:true and is expected to surface it, never to treat
// the number as authoritative.
function familyFallback(providerCatalogue, normalized) {
  let best = null;
  for (const key of Object.keys(providerCatalogue || {})) {
    if (normalized.startsWith(key + "-") && (!best || key.length > best.length)) best = key;
  }
  return best;
}

async function getRate(provider, model, db = defaultDb) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "");
  const normalized = normalizeModelId(m);

  // 1. Manual override always wins - checked against the exact string the
  // caller sent first, then its normalized form, so an operator can price
  // one specific dated snapshot differently from the rest of its family.
  for (const candidate of m === normalized ? [m] : [m, normalized]) {
    const override = await db.get(
      "SELECT input_per_1k, output_per_1k FROM pricing_overrides WHERE provider = ? AND model = ?",
      [p, candidate]
    );
    if (override) return { ...override, source: "override", approximate: false };
  }

  // 2. Baseline catalogue - exact match on the normalized ID
  const providerCatalogue = BASELINE_CATALOGUE[p];
  const baseline = providerCatalogue?.[normalized] || providerCatalogue?.[m];
  if (baseline) return { ...baseline, source: "baseline", approximate: false };

  // 3. Family fallback - approximate, see familyFallback()
  const family = familyFallback(providerCatalogue, normalized);
  if (family) {
    return { ...providerCatalogue[family], source: "baseline-family", approximate: true, matched_family: family };
  }

  return null; // unknown provider/model - caller MUST flag, not silently cost $0
}

async function setOverride({ provider, model, input_per_1k, output_per_1k, db = defaultDb }) {
  // EXCLUDED works identically in this ON CONFLICT clause on both SQLite and
  // Postgres (same pseudo-table name in both dialects) - no dialect helper
  // needed here. updated_at is passed explicitly (see audit.js/governance.js
  // for why) rather than via a dialect-native datetime('now')/NOW() literal.
  await db.run(
    `INSERT INTO pricing_overrides (provider, model, input_per_1k, output_per_1k, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, model) DO UPDATE SET
       input_per_1k = excluded.input_per_1k,
       output_per_1k = excluded.output_per_1k,
       updated_at = excluded.updated_at`,
    [String(provider).toLowerCase(), model, input_per_1k, output_per_1k, new Date().toISOString()]
  );
}

async function computeCost({ provider, model, input_tokens = 0, output_tokens = 0, db = defaultDb }) {
  const rate = await getRate(provider, model, db);
  if (!rate) {
    return { cost_usd: null, rate_found: false };
  }
  const cost =
    (input_tokens / 1000) * rate.input_per_1k +
    (output_tokens / 1000) * rate.output_per_1k;
  return {
    cost_usd: Math.round(cost * 1e6) / 1e6,
    rate_found: true,
    source: rate.source,
    approximate: Boolean(rate.approximate),
    ...(rate.matched_family ? { matched_family: rate.matched_family } : {}),
  };
}

module.exports = { getRate, setOverride, computeCost, normalizeModelId, BASELINE_CATALOGUE };
