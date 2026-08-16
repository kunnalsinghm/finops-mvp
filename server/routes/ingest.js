// routes/ingest.js - Log Integrator webhook receiver (Phase 1 of the roadmap)
//
// Accepts usage events from client SDKs, CI jobs, or manual curl/webhook calls.
// Tagging policy default is WARN, not reject (see blueprint gap notes) - an
// untagged event is still recorded and counted, just flagged so it shows up
// in an "untagged spend" view rather than silently vanishing or breaking traffic.

const express = require("express");
const db = require("../db");
const { computeCost } = require("../pricing");

const router = express.Router();

const insertEvent = db.prepare(`
  INSERT INTO usage_events
    (event_time, provider, model, team, environment, git_branch, user_id,
     input_tokens, output_tokens, cost_usd, tagged, raw_json)
  VALUES
    (@event_time, @provider, @model, @team, @environment, @git_branch, @user_id,
     @input_tokens, @output_tokens, @cost_usd, @tagged, @raw_json)
`);

router.post("/", (req, res) => {
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

  const row = {
    event_time: event_time || new Date().toISOString(),
    provider,
    model,
    team: team || null,
    environment: environment || null,
    git_branch: git_branch || null,
    user_id: user_id || null,
    input_tokens,
    output_tokens,
    cost_usd: cost_usd ?? 0,
    tagged,
    raw_json: JSON.stringify(body),
  };

  insertEvent.run(row);

  res.status(201).json({
    ok: true,
    tagged: Boolean(tagged),
    cost_usd: row.cost_usd,
    rate_found,
    warning: rate_found
      ? tagged
        ? undefined
        : "Event recorded but missing team/environment tags - showing under 'Untagged'."
      : `No pricing rate found for ${provider}/${model}. Cost recorded as $0 - add an override via POST /api/pricing/override.`,
  });
});

module.exports = router;
