// routes/ingest.js - Log Integrator webhook receiver (Phase 1 of the roadmap)
//
// Accepts usage events from client SDKs, CI jobs, or manual curl/webhook calls.
// Tagging policy default is WARN, not reject (see blueprint gap notes) - an
// untagged event is still recorded and counted, just flagged so it shows up
// in an "untagged spend" view rather than silently vanishing or breaking traffic.

const express = require("express");
const db = require("../db");
const { computeCost } = require("../pricing");
const { requireAuth } = require("../auth");
const { checkRateLimit } = require("../governance");
const { checkAnomaly } = require("../anomaly");
const { redactValue } = require("../piiRedaction");
const { logAlert } = require("../governance");

const router = express.Router();

const insertEvent = db.prepare(`
  INSERT INTO usage_events
    (event_time, provider, model, team, environment, git_branch, user_id,
     input_tokens, output_tokens, cost_usd, tagged, raw_json)
  VALUES
    (@event_time, @provider, @model, @team, @environment, @git_branch, @user_id,
     @input_tokens, @output_tokens, @cost_usd, @tagged, @raw_json)
`);

// Same governance rate limiter used by the proxy - the ingest webhook is
// just as capable of being flooded (by a bug, a misconfigured retry loop,
// or bad actor with a leaked key) as the proxy is.
const INGEST_LIMIT = { capacity: 120, refillPerSec: 2 };

router.post("/", requireAuth("write"), (req, res) => {
  const rl = checkRateLimit(`ingest:${req.apiKey.key_id}`, INGEST_LIMIT);
  if (!rl.allowed) {
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterSec: rl.retryAfterSec });
  }

  const body = req.body || {};
  const {
    provider,
    model,
    team,
    environment,
    git_branch,
    user_id,
    input_tokens = 0,
    output_tokens = 0,
    event_time,
  } = body;

  if (!provider || !model) {
    return res.status(400).json({ error: "provider and model are required fields" });
  }

  const { cost_usd, rate_found } = computeCost({ provider, model, input_tokens, output_tokens });

  const tagged = Boolean(team && environment) ? 1 : 0;

  // PII redaction on the stored copy of the raw payload - same on-by-default
  // stance as the proxy (see piiRedaction.js and routes/proxy.js for the
  // full reasoning). The ingest webhook accepts an arbitrary client-supplied
  // body, and that whole body gets persisted verbatim into raw_json - so
  // this is exactly the "stored logs" surface a client could accidentally
  // leak PII into (e.g. a free-text field, a custom metadata field).
  let storedBody = body;
  if (req.header("X-Disable-PII-Redaction") !== "true") {
    const { value, counts, hasPII } = redactValue(body);
    storedBody = value;
    if (hasPII) {
      logAlert(
        "pii-redaction",
        `Redacted PII in ingest payload - team:${team || "untagged"} - ${Object.entries(counts)
          .map(([k, v]) => `${k.toLowerCase()}:${v}`)
          .join(", ")}`
      );
    }
  }

  const row = {
    event_time: event_time || new Date().toISOString(),
    provider,
    model,
    team: team || null,
    environment: environment || null,
    git_branch: git_branch || null,
    user_id: user_id || req.apiKey.key_id,
    input_tokens,
    output_tokens,
    cost_usd: cost_usd ?? 0,
    tagged,
    raw_json: JSON.stringify(storedBody),
  };

  // Anomaly check runs against the baseline BEFORE this event is inserted,
  // so the outlier itself doesn't dilute the average it's being compared to.
  const anomaly = checkAnomaly({ provider, model, cost_usd: cost_usd ?? 0, team });

  insertEvent.run(row);

  res.status(201).json({
    ok: true,
    tagged: Boolean(tagged),
    cost_usd: row.cost_usd,
    rate_found,
    anomaly: anomaly || undefined,
    warning: rate_found
      ? tagged
        ? undefined
        : "Event recorded but missing team/environment tags - showing under 'Untagged'."
      : `No pricing rate found for ${provider}/${model}. Cost recorded as $0 - add an override via POST /api/pricing/override.`,
  });
});

module.exports = router;
