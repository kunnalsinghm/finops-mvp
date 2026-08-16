// recommend.js - Smart Optimization Engine (Phase 1: rule-based, not ML-based)
//
// IMPORTANT DESIGN NOTE: every recommendation here is explicitly framed as
// "consider testing" rather than "you should switch" - a true quality/eval
// layer (shadow A/B testing model outputs before recommending) is a
// deliberately separate, larger project. Shipping confident cost-savings
// claims without a quality check is the fastest way to lose trust in this
// category (see blueprint risk notes). This engine surfaces *opportunities*
// for a human to evaluate, not autonomous decisions.

const db = require("./db");
const { computeCost } = require("./pricing");

// Pairs of (expensive model -> cheaper same-provider alternative) worth testing.
// Deliberately conservative: same provider only, so behavior/quality is more
// likely to be comparable than a cross-provider switch.
const CHEAPER_ALTERNATIVES = {
  "openai/gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
  "anthropic/claude-opus": { provider: "anthropic", model: "claude-sonnet" },
  "anthropic/claude-sonnet": { provider: "anthropic", model: "claude-haiku" },
};

function getModelSwitchRecommendations({ days = 30 } = {}) {
  const rows = db
    .prepare(
      `SELECT provider, model, SUM(cost_usd) AS total_cost,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              COUNT(*) AS event_count
       FROM usage_events
       WHERE event_time >= datetime('now', ?)
       GROUP BY provider, model`
    )
    .all(`-${days} days`);

  const recommendations = [];

  for (const row of rows) {
    const key = `${row.provider}/${row.model}`;
    const alt = CHEAPER_ALTERNATIVES[key];
    if (!alt || row.total_cost < 1) continue; // skip trivial spend

    const altCost = computeCost({
      provider: alt.provider,
      model: alt.model,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
    });

    if (!altCost.rate_found || altCost.cost_usd == null) continue;

    const savings = row.total_cost - altCost.cost_usd;
    const savingsPct = row.total_cost > 0 ? (savings / row.total_cost) * 100 : 0;

    if (savings <= 0.01) continue;

    recommendations.push({
      current: { provider: row.provider, model: row.model, cost_usd: round2(row.total_cost), event_count: row.event_count },
      suggested: { provider: alt.provider, model: alt.model, estimated_cost_usd: round2(altCost.cost_usd) },
      estimated_savings_usd: round2(savings),
      estimated_savings_pct: Math.round(savingsPct),
      confidence: "unverified",
      caveat:
        "Cost-only estimate. Output quality has NOT been evaluated - test on a sample of real traffic (shadow A/B) before switching production workloads.",
    });
  }

  return recommendations.sort((a, b) => b.estimated_savings_usd - a.estimated_savings_usd);
}

// Caching opportunity heuristic: flags providers/models with high call volume
// but low token variance per call, which often indicates repeated/templated
// prompts that could benefit from semantic or provider-native prompt caching.
function getCachingOpportunities({ days = 30 } = {}) {
  const rows = db
    .prepare(
      `SELECT provider, model, input_tokens
       FROM usage_events
       WHERE event_time >= datetime('now', ?)`
    )
    .all(`-${days} days`);

  const groups = {};
  for (const r of rows) {
    const key = `${r.provider}/${r.model}`;
    (groups[key] ||= { provider: r.provider, model: r.model, values: [] }).values.push(r.input_tokens);
  }

  const opportunities = [];
  for (const g of Object.values(groups)) {
    if (g.values.length < 20) continue;
    const avg = g.values.reduce((a, b) => a + b, 0) / g.values.length;
    if (avg <= 0) continue;
    const variance = g.values.reduce((a, b) => a + (b - avg) ** 2, 0) / g.values.length;
    const coeffOfVariation = Math.sqrt(variance) / avg;

    if (coeffOfVariation < 0.15) {
      opportunities.push({
        provider: g.provider,
        model: g.model,
        event_count: g.values.length,
        note: "Low variance in input size across many calls - a signal (not proof) of repeated/templated prompts. Worth checking whether provider-native prompt caching or a semantic cache would reduce cost.",
      });
    }
  }
  return opportunities;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { getModelSwitchRecommendations, getCachingOpportunities };