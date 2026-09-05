// shadowTest.js - Shadow A/B testing for the optimization engine.
//
// WHY THIS EXISTS: recommend.js has always shipped every model-switch
// recommendation with a "cost-only, quality unverified" caveat, by explicit
// design (see recommend.js header comment) - because a savings estimate
// alone isn't proof a cheaper model is good enough. This module closes that
// gap using real traffic instead of a synthetic eval set: when opted in on
// the proxy (X-Enable-Shadow-Test: true), the SAME prompt that just got a
// real answer from the primary model is ALSO sent to its cheaper same-
// provider alternative (see modelAlternatives.js), purely to compare.
//
// KEY DESIGN CHOICES:
//   - Fire-and-forget, AFTER the primary response is already sent to the
//     client - shadow testing must never add latency or a failure mode to
//     real traffic. See routes/proxy.js for the call site.
//   - Non-streaming only (v1 scope). Shadow-testing a stream would require
//     buffering both streams to compare them, which reintroduces the
//     latency this is trying to avoid. A streaming request is simply never
//     eligible for shadow testing.
//   - Costs here are REAL (both models actually got called) but are
//     deliberately NOT written to usage_events/budgets - see the db.js
//     schema comment on shadow_comparisons for why.
//   - Quality scoring reuses the same local word-overlap cosine similarity
//     already implemented in semanticCache.js, rather than inventing a
//     second implementation. Same honest caveat applies: this is lexical
//     overlap, not true semantic understanding - a useful signal, not a
//     replacement for a human reading sample outputs.
//   - Sampling is opt-in and rate-controlled (X-Shadow-Test-Sample-Rate)
//     because every sampled request calls TWO models instead of one - the
//     whole point is spending a little to find out whether you can spend
//     a lot less, but that "little" is real money if left on unbounded.

const db = require("./db");
const { computeCost } = require("./pricing");
const { CHEAPER_ALTERNATIVES } = require("./modelAlternatives");
const { tokenize, termFrequency, cosineSimilarityLocal } = require("./semanticCache");

const DEFAULT_SAMPLE_RATE = clamp01(Number(process.env.FINOPS_SHADOW_TEST_SAMPLE_RATE), 1.0);
const MIN_SAMPLES_FOR_CONFIDENCE = Number(process.env.FINOPS_SHADOW_TEST_MIN_SAMPLES) || 5;
const SIMILARITY_CONFIDENCE_THRESHOLD =
  Number(process.env.FINOPS_SHADOW_TEST_SIMILARITY_THRESHOLD) || 0.8;

function clamp01(n, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const insertShadowRow = db.prepare(`
  INSERT INTO shadow_comparisons
    (provider, primary_model, shadow_model, team, primary_cost_usd, shadow_cost_usd,
     similarity, primary_length, shadow_length, length_delta_pct, shadow_error)
  VALUES
    (@provider, @primary_model, @shadow_model, @team, @primary_cost_usd, @shadow_cost_usd,
     @similarity, @primary_length, @shadow_length, @length_delta_pct, @shadow_error)
`);

// Pulls plain response text out of an OpenAI or Anthropic chat *response*
// body (different shape from semanticCache.js's extractPromptText, which
// reads REQUEST bodies) so the two can be compared for similarity/length.
function extractResponseText(providerName, responseJson) {
  if (providerName === "openai") {
    const content = responseJson?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((b) => typeof b?.text === "string")
        .map((b) => b.text)
        .join("\n");
    }
    return "";
  }
  if (providerName === "anthropic") {
    const blocks = Array.isArray(responseJson?.content) ? responseJson.content : [];
    return blocks
      .filter((b) => typeof b?.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// Fire-and-forget: call this AFTER the primary response has already been
// sent to the client. Never throws - any failure is recorded in the row's
// shadow_error column rather than propagated, since a shadow test failing
// must never surface as an error to real traffic.
async function runShadowTest({
  providerName,
  primaryModel,
  primaryRequestBody,
  primaryResponseJson,
  primaryCostUsd,
  providerKey,
  team,
  endpoint,
  sampleRate = DEFAULT_SAMPLE_RATE,
} = {}) {
  const alt = CHEAPER_ALTERNATIVES[`${providerName}/${primaryModel}`];
  if (!alt) return; // no known cheaper alternative for this model - nothing to test

  if (Math.random() >= clamp01(sampleRate, DEFAULT_SAMPLE_RATE)) return; // sampled out

  const shadowBody = { ...primaryRequestBody, model: alt.model };
  delete shadowBody.stream;
  delete shadowBody.stream_options;

  const row = {
    provider: providerName,
    primary_model: primaryModel,
    shadow_model: alt.model,
    team: team || null,
    primary_cost_usd: primaryCostUsd ?? 0,
    shadow_cost_usd: null,
    similarity: null,
    primary_length: null,
    shadow_length: null,
    length_delta_pct: null,
    shadow_error: null,
  };

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...endpoint.authHeader(providerKey) },
      body: JSON.stringify(shadowBody),
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json) {
      row.shadow_error = `HTTP ${res.status}${json?.error?.message ? `: ${json.error.message}` : ""}`;
    } else {
      const { input_tokens, output_tokens } = endpoint.extractUsage(json);
      const { cost_usd } = computeCost({ provider: providerName, model: alt.model, input_tokens, output_tokens });
      row.shadow_cost_usd = cost_usd ?? 0;

      const primaryText = extractResponseText(providerName, primaryResponseJson);
      const shadowText = extractResponseText(providerName, json);
      row.primary_length = primaryText.length;
      row.shadow_length = shadowText.length;
      row.length_delta_pct =
        primaryText.length > 0
          ? Math.round(((shadowText.length - primaryText.length) / primaryText.length) * 1000) / 10
          : null;
      row.similarity =
        Math.round(
          cosineSimilarityLocal(termFrequency(tokenize(primaryText)), termFrequency(tokenize(shadowText))) * 1000
        ) / 1000;
    }
  } catch (err) {
    row.shadow_error = err.message;
  }

  insertShadowRow.run(row);
}

// Aggregate stats for one specific (current -> suggested) pair, used by
// recommend.js to decide whether a recommendation has moved beyond
// "unverified" for that exact switch.
function getShadowStatsForPair(provider, primaryModel, shadowModel, { days = 90 } = {}) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN shadow_error IS NULL THEN 1 ELSE 0 END) AS successes,
              AVG(CASE WHEN shadow_error IS NULL THEN similarity END) AS avg_similarity,
              AVG(CASE WHEN shadow_error IS NULL THEN length_delta_pct END) AS avg_length_delta_pct,
              SUM(CASE WHEN shadow_error IS NULL THEN primary_cost_usd - shadow_cost_usd ELSE 0 END) AS total_actual_savings_usd
       FROM shadow_comparisons
       WHERE provider = ? AND primary_model = ? AND shadow_model = ?
         AND created_at >= datetime('now', ?)`
    )
    .get(provider, primaryModel, shadowModel, `-${days} days`);

  return {
    sample_count: row.n || 0,
    successful_count: row.successes || 0,
    avg_similarity: row.avg_similarity != null ? Math.round(row.avg_similarity * 1000) / 1000 : null,
    avg_length_delta_pct: row.avg_length_delta_pct != null ? Math.round(row.avg_length_delta_pct * 10) / 10 : null,
    total_actual_savings_usd:
      row.total_actual_savings_usd != null ? Math.round(row.total_actual_savings_usd * 1e6) / 1e6 : 0,
  };
}

// Every distinct pair tested, for a dashboard/API summary view.
function getShadowTestSummary({ days = 90 } = {}) {
  const rows = db
    .prepare(
      `SELECT provider, primary_model, shadow_model,
              COUNT(*) AS n,
              SUM(CASE WHEN shadow_error IS NULL THEN 1 ELSE 0 END) AS successes,
              AVG(CASE WHEN shadow_error IS NULL THEN similarity END) AS avg_similarity,
              AVG(CASE WHEN shadow_error IS NULL THEN length_delta_pct END) AS avg_length_delta_pct,
              SUM(CASE WHEN shadow_error IS NULL THEN primary_cost_usd - shadow_cost_usd ELSE 0 END) AS total_actual_savings_usd
       FROM shadow_comparisons
       WHERE created_at >= datetime('now', ?)
       GROUP BY provider, primary_model, shadow_model
       ORDER BY n DESC`
    )
    .all(`-${days} days`);

  return rows.map((r) => ({
    provider: r.provider,
    primary_model: r.primary_model,
    shadow_model: r.shadow_model,
    sample_count: r.n,
    successful_count: r.successes,
    avg_similarity: r.avg_similarity != null ? Math.round(r.avg_similarity * 1000) / 1000 : null,
    avg_length_delta_pct: r.avg_length_delta_pct != null ? Math.round(r.avg_length_delta_pct * 10) / 10 : null,
    total_actual_savings_usd:
      r.total_actual_savings_usd != null ? Math.round(r.total_actual_savings_usd * 1e6) / 1e6 : 0,
  }));
}

// Raw recent rows, including failures, for debugging/audit.
function getShadowComparisons({ limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return db.prepare(`SELECT * FROM shadow_comparisons ORDER BY created_at DESC LIMIT ?`).all(capped);
}

module.exports = {
  runShadowTest,
  getShadowStatsForPair,
  getShadowTestSummary,
  getShadowComparisons,
  extractResponseText,
  DEFAULT_SAMPLE_RATE,
  MIN_SAMPLES_FOR_CONFIDENCE,
  SIMILARITY_CONFIDENCE_THRESHOLD,
};
