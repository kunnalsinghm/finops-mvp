// routes/ingest.js - Log Integrator webhook receiver (Phase 1 of the roadmap)
//
// Accepts usage events from client SDKs, CI jobs, or manual curl/webhook calls.
// Tagging policy default is WARN, not reject (see blueprint gap notes) - an
// untagged event is still recorded and counted, just flagged so it shows up
// in an "untagged spend" view rather than silently vanishing or breaking traffic.

const express = require("express");
const defaultDb = require("../storage");
const { computeCost } = require("../pricing");
const { requireAuth } = require("../auth");
const { checkRateLimit } = require("../governance");
const { checkAnomaly } = require("../anomaly");
const { redactValue } = require("../piiRedaction");
const { logAlert } = require("../governance");
const { detectPromptInjection } = require("../promptInjection");
const { checkKeyFraudSignals } = require("../fraudDetection");
const { TASK_STATUSES } = require("../agentAttribution");
const { inferTag } = require("../smartTagging");
const { applyTagRules } = require("../tagRules");
const { realKeyId } = require("../keyIdentity");

const router = express.Router();

// Was a db.prepare(...) statement with named (@col) params under the old
// sync db.js. Positional params + await, same pattern as every other
// migrated insert in this codebase (see shadowTest.js/seed.js).
async function insertUsageEvent(row, db = defaultDb) {
  const result = await db.run(
    `INSERT INTO usage_events
       (event_time, provider, model, team, environment, git_branch, user_id, key_id,
        feature_id, customer_id, project_id, cost_center, client_region, agent_id, session_id, task_id,
        task_status, workload_type, input_tokens, output_tokens, cost_usd, tagged, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      row.event_time,
      row.provider,
      row.model,
      row.team,
      row.environment,
      row.git_branch,
      row.user_id,
      row.key_id || null,
      row.feature_id,
      row.customer_id,
      row.project_id,
      row.cost_center,
      row.client_region,
      row.agent_id,
      row.session_id,
      row.task_id,
      row.task_status,
      row.workload_type,
      row.input_tokens,
      row.output_tokens,
      row.cost_usd,
      row.tagged,
      row.raw_json,
    ]
  );
  return result.lastInsertRowid;
}

// Same governance rate limiter used by the proxy - the ingest webhook is
// just as capable of being flooded (by a bug, a misconfigured retry loop,
// or bad actor with a leaked key) as the proxy is.
const INGEST_LIMIT = { capacity: 120, refillPerSec: 2 };

router.post("/", requireAuth("write"), async (req, res) => {
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
    feature_id,
    customer_id,
    project_id,
    cost_center,
    agent_id,
    session_id,
    task_id,
    task_status,
    workload_type,
    input_tokens = 0,
    output_tokens = 0,
    event_time,
  } = body;

  if (!provider || !model) {
    return res.status(400).json({ error: "provider and model are required fields" });
  }

  if (task_status && !TASK_STATUSES.includes(task_status)) {
    return res.status(400).json({ error: `task_status must be one of: ${TASK_STATUSES.join(", ")}` });
  }

  // Prompt-injection scan across the ENTIRE raw body, not just recognized
  // fields - runs BEFORE PII redaction below (a request that's about to be
  // blocked shouldn't first pay the cost of being redacted). ingest.js never
  // calls an LLM itself, but raw_json persists the whole body verbatim, so
  // a payload planted in any field (a custom field, even provider/model)
  // could be replayed into a real prompt later by some downstream feature.
  const injectionCheck = detectPromptInjection(JSON.stringify(body));
  if (injectionCheck.flagged) {
    await logAlert(
      "prompt-injection",
      `Blocked ingest event from key '${req.apiKey.key_id}' - matched: ${injectionCheck.matched.join(", ")}`,
      req.db
    );
    return res.status(400).json({
      error: "Request blocked: possible prompt injection detected.",
      matched_patterns: injectionCheck.matched,
    });
  }

  const { cost_usd, rate_found } = await computeCost({ provider, model, input_tokens, output_tokens, db: req.db });

  // Declarative tagging rules (finops.yaml `tagging_rules:`, synced via
  // POST /api/gitops/sync) fill in any of these fields the caller left
  // blank - never overriding a value the caller actually sent. Matched
  // against the REAL authenticated key (not the client-declared user_id),
  // same identity used for the key_id column below. See tagRules.js for
  // the full precedence rules (this runs before smart-tag inference below,
  // so a declared rule always wins over a statistical guess).
  const { fields: resolvedTags } = await applyTagRules({
    key_id: realKeyId(req.apiKey),
    fields: { team, environment, project_id, cost_center, customer_id, feature_id },
    db: req.db,
  });

  const tagged = Boolean(resolvedTags.team && resolvedTags.environment) ? 1 : 0;

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
      await logAlert(
        "pii-redaction",
        `Redacted PII in ingest payload - team:${resolvedTags.team || "untagged"} - ${Object.entries(counts)
          .map(([k, v]) => `${k.toLowerCase()}:${v}`)
          .join(", ")}`,
        req.db
      );
    }
  }

  const row = {
    event_time: event_time || new Date().toISOString(),
    provider,
    model,
    team: resolvedTags.team || null,
    environment: resolvedTags.environment || null,
    git_branch: git_branch || null,
    user_id: user_id || req.apiKey.key_id,
    // Unlike user_id (which a client may declare), this is always the key that
    // actually authenticated - the one that can be quarantined or revoked.
    key_id: realKeyId(req.apiKey),
    feature_id: resolvedTags.feature_id || null,
    customer_id: resolvedTags.customer_id || null,
    project_id: resolvedTags.project_id || null,
    cost_center: resolvedTags.cost_center || null,
    client_region: req.header("X-Client-Region") || null,
    agent_id: agent_id || null,
    session_id: session_id || null,
    task_id: task_id || null,
    task_status: task_status || null,
    workload_type: workload_type || null,
    input_tokens,
    output_tokens,
    cost_usd: cost_usd ?? 0,
    tagged,
    raw_json: JSON.stringify(storedBody),
  };

  // Anomaly and fraud checks both run against the baseline BEFORE this event
  // is inserted, so the event itself doesn't dilute the average/history it's
  // being compared to. Neither check blocks the request (see fraudDetection.js
  // for why this is flag-only, not auto-block).
  const anomaly = await checkAnomaly({ provider, model, cost_usd: cost_usd ?? 0, team: resolvedTags.team, db: req.db });
  const fraud = await checkKeyFraudSignals({
    key_id: req.apiKey.key_id,
    provider,
    model,
    client_region: req.header("X-Client-Region") || null,
    db: req.db,
  });

  const insertedId = await insertUsageEvent(row, req.db);

  // Smart/inferred tagging: only for events that are STILL untagged after
  // declarative rules ran (no team supplied by the caller AND no rule
  // filled one in) - never overrides or second-guesses a team that's
  // already real, whichever of those two sources it came from. Stored as a
  // SEPARATE row in tag_inferences, never written back into
  // usage_events.team itself - see smartTagging.js header for why
  // conflating the two would be dangerous.
  let tagInference;
  if (!resolvedTags.team) {
    tagInference = await inferTag({ key_id: req.apiKey.key_id, usage_event_id: insertedId, db: req.db });
  }

  res.status(201).json({
    ok: true,
    tagged: Boolean(tagged),
    cost_usd: row.cost_usd,
    rate_found,
    anomaly: anomaly || undefined,
    fraud_signal: fraud || undefined,
    tag_inference: tagInference || undefined,
    warning: rate_found
      ? tagged
        ? undefined
        : "Event recorded but missing team/environment tags - showing under 'Untagged'."
      : `No pricing rate found for ${provider}/${model}. Cost recorded as $0 - add an override via POST /api/pricing/override.`,
  });
});

module.exports = router;
