// pricing.js - Pricing Catalogue Engine (Phase 1)
//
// Ships with a static baseline catalogue (update these numbers periodically -
// see README for where to check current vendor pricing) PLUS a manual override
// table in SQLite, since the blueprint flagged auto-scraped pricing as a
// trust-risk if it silently goes stale. Overrides always win.

const db = require("./db");

// Baseline rates in USD per 1,000 tokens. THESE ARE ILLUSTRATIVE PLACEHOLDERS -
// check current vendor pricing pages before relying on them for real billing,
// and use the override table (POST /api/pricing/override) to correct them.
const BASELINE_CATALOGUE = {
  openai: {
    "gpt-4o": { input_per_1k: 0.0025, output_per_1k: 0.01 },
    "gpt-4o-mini": { input_per_1k: 0.00015, output_per_1k: 0.0006 },
  },
  anthropic: {
    "claude-opus": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-haiku": { input_per_1k: 0.0008, output_per_1k: 0.004 },
  },
  bedrock: {
    "titan-text-express": { input_per_1k: 0.0002, output_per_1k: 0.0006 },
  },
};

const getOverrideStmt = db.prepare(
  "SELECT input_per_1k, output_per_1k FROM pricing_overrides WHERE provider = ? AND model = ?"
);

const upsertOverrideStmt = db.prepare(`
  INSERT INTO pricing_overrides (provider, model, input_per_1k, output_per_1k, updated_at)
  VALUES (@provider, @model, @input_per_1k, @output_per_1k, datetime('now'))
  ON CONFLICT(provider, model) DO UPDATE SET
    input_per_1k = excluded.input_per_1k,
    output_per_1k = excluded.output_per_1k,
    updated_at = datetime('now')
`);

function getRate(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "");

  // 1. Manual override always wins
  const override = getOverrideStmt.get(p, m);
  if (override) return { ...override, source: "override" };

  // 2. Baseline catalogue
  const baseline = BASELINE_CATALOGUE[p]?.[m];
  if (baseline) return { ...baseline, source: "baseline" };

  return null; // unknown provider/model - caller should flag, not silently cost $0
}

function setOverride({ provider, model, input_per_1k, output_per_1k }) {
  upsertOverrideStmt.run({
    provider: String(provider).toLowerCase(),
    model,
    input_per_1k,
    output_per_1k,
  });
}

function computeCost({ provider, model, input_tokens = 0, output_tokens = 0 }) {
  const rate = getRate(provider, model);
  if (!rate) {
    return { cost_usd: null, rate_found: false };
  }
  const cost =
    (input_tokens / 1000) * rate.input_per_1k +
    (output_tokens / 1000) * rate.output_per_1k;
  return { cost_usd: Math.round(cost * 1e6) / 1e6, rate_found: true, source: rate.source };
}

module.exports = { getRate, setOverride, computeCost, BASELINE_CATALOGUE };
