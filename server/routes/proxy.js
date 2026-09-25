// routes/proxy.js - Gateway Proxy (Phase 2), now with streaming (SSE) support
//
// Non-streaming requests work exactly as before. For streaming requests
// (body.stream === true):
//   - OpenAI: we inject `stream_options: { include_usage: true }` into the
//     outbound request. OpenAI then emits a final SSE chunk containing real
//     token usage before [DONE] - so metering stays exact, not estimated.
//   - Anthropic: usage is naturally split across the stream - input_tokens
//     arrives in the `message_start` event, output_tokens accumulates in
//     `message_delta` events. We parse both from the passthrough buffer.
// The client's stream is piped through in real time (no added latency from
// buffering); usage parsing happens on our copy of the same bytes in parallel.

const express = require("express");
const defaultDb = require("../storage");
const { yearMonthExpr } = require("../storage/dialectSql");
const { computeCost, getRate } = require("../pricing");
const { insertUsageEvent } = require("../usageStore");
const { resolveIdentity, realKeyId } = require("../keyIdentity");
const { spoolEvent } = require("../meteringSpool");
const logger = require("../logger");
const { requireAuth } = require("../auth");
const {
  checkRateLimit,
  isQuarantined,
  checkQuarantineAllowance,
  getFallback,
  logAlert,
} = require("../governance");
const { makeCacheKey, getCached, setCached } = require("../cache");
const { findSemanticMatch, setSemanticCache, extractPromptText } = require("../semanticCache");
const { checkAllAnomalies } = require("../anomaly");
const { runShadowTest, DEFAULT_SAMPLE_RATE } = require("../shadowTest");
const { redactValue } = require("../piiRedaction");
const { detectPromptInjection } = require("../promptInjection");
const { checkModelAllowed } = require("../modelAllowlist");
const { checkTokenQuota } = require("../tokenQuota");
const { checkKeyFraudSignals } = require("../fraudDetection");
const { checkRegionAllowed } = require("../dataResidency");
const { checkMonthlyEventQuota } = require("../tenantQuota");
const { TASK_STATUSES } = require("../agentAttribution");
const { inferTag } = require("../smartTagging");
const { applyTagRules } = require("../tagRules");

const router = express.Router();

const PROVIDER_ENDPOINTS = {
  openai: {
    url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    extractUsage: (json) => ({
      input_tokens: json?.usage?.prompt_tokens || 0,
      output_tokens: json?.usage?.completion_tokens || 0,
    }),
  },
  anthropic: {
    url: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages",
    authHeader: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    extractUsage: (json) => ({
      input_tokens: json?.usage?.input_tokens || 0,
      output_tokens: json?.usage?.output_tokens || 0,
    }),
  },
};

// insertUsageEvent now lives in ../usageStore.js so a spooled event can be
// replayed through the identical INSERT (see meteringSpool.js).

// ---- Upstream + metering policy knobs (all env-driven, read per call so tests
// and operators can change them without a restart-order dependency) ----
//
// FINOPS_UPSTREAM_TIMEOUT_MS  (default 120000)
//   Before this existed the proxy would wait on a hung provider forever,
//   pinning a connection (and the caller) indefinitely. Non-streaming: caps the
//   whole request. Streaming: caps time-to-first-byte only - a healthy stream
//   may legitimately run for minutes, so it is not cut mid-flight.
//
// FINOPS_UNPRICED_POLICY  ("flag" default | "block")
//   What to do when the model has no price at all (not in the catalogue, no
//   override, no family match). "flag": forward it but record it as unpriced,
//   raise an alert and set X-FinOps-Unpriced - spend is visible as a gap, not
//   silently $0. "block": refuse with 422 before calling the provider, the
//   right choice wherever budgets are a hard control (an unpriced model
//   otherwise sidesteps every dollar-based limit).
//
// FINOPS_METERING_FAILURE_POLICY  ("open" default | "closed")
//   Metering happens AFTER the provider call, so a metering failure can't
//   un-spend the money. "closed" therefore acts as a PRE-flight: if the usage
//   store is unreachable, refuse (503) before forwarding anything. In both
//   modes a failure after the call is spooled to disk (meteringSpool.js) and
//   the client still gets the provider's response.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000;

function upstreamTimeoutMs() {
  const n = Number(process.env.FINOPS_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

function isTimeoutError(err) {
  return err && (err.name === "TimeoutError" || err.name === "AbortError");
}

const warnedUnpriced = new Set();
async function noteUnpricedModel(provider, model, db = defaultDb, tenantKey = null) {
  const id = `${provider}/${model}`;
  // one alert per model per process PER TENANT - not one per request, and one
  // tenant's alert must not suppress (or leak into) another tenant's.
  const dedupeKey = `${tenantKey || "-"}|${id}`;
  if (warnedUnpriced.has(dedupeKey)) return;
  warnedUnpriced.add(dedupeKey);
  try {
    await logAlert(
      "unpriced-model",
      `No price is configured for '${id}' - its usage is being recorded at $0 and will NOT count toward any dollar budget. Add a rate with POST /api/pricing/override, or set FINOPS_UNPRICED_POLICY=block to refuse unpriced models.`,
      db
    );
  } catch (err) {
    logger.warn(`[proxy] could not log unpriced-model alert: ${err.message}`);
  }
}

function buildUsageRow({ providerName, effectiveModel, team, environment, gitBranch, featureId, customerId, projectId, costCenter, clientRegion, agentId, sessionId, taskId, taskStatus, workloadType, rateLimitKey, input_tokens, output_tokens, degraded, requestedModel, piiFindings, streamed, partial }, costInfo) {
  const { cost_usd, rate_found, approximate, costComputeFailed } = costInfo;
  return {
    event_time: new Date().toISOString(),
    provider: providerName,
    model: effectiveModel,
    team,
    environment,
    git_branch: gitBranch,
    user_id: rateLimitKey,
    key_id: realKeyId(rateLimitKey),
    feature_id: featureId,
    customer_id: customerId,
    project_id: projectId,
    cost_center: costCenter,
    client_region: clientRegion,
    agent_id: agentId,
    session_id: sessionId,
    task_id: taskId,
    task_status: taskStatus,
    workload_type: workloadType,
    input_tokens,
    output_tokens,
    cost_usd: cost_usd ?? 0,
    tagged: team && environment ? 1 : 0,
    raw_json: JSON.stringify({
      degraded,
      requestedModel,
      effectiveModel,
      streamed: Boolean(streamed),
      // A $0 that means "we don't know the price" must be distinguishable
      // from a $0 that means "this was free" - GET /api/pricing/unpriced
      // reads these markers.
      ...(rate_found === false ? { unpriced: true } : {}),
      ...(approximate ? { priceApproximate: true } : {}),
      ...(costComputeFailed ? { costComputeFailed: true } : {}),
      ...(partial ? { partial: true } : {}),
      ...(piiFindings && Object.keys(piiFindings).length > 0 ? { piiRedacted: piiFindings } : {}),
    }),
  };
}

async function logUsageEvent(params) {
  // `db` is the CALLER'S database (req.db): the tenant's own schema in multi-tenant
  // mode, the one shared database otherwise. Nothing below may reach for a global.
  const { providerName, effectiveModel, team, rateLimitKey, clientRegion, agentId, input_tokens, output_tokens, db = defaultDb, controlPlaneDb = db } = params;

  let costInfo;
  try {
    costInfo = await computeCost({ provider: providerName, model: effectiveModel, input_tokens, output_tokens, db });
  } catch (err) {
    // The price lookup itself hit the DB and failed. Record the tokens anyway
    // (flagged, so it can be re-priced later) rather than losing the event.
    logger.warn(`[proxy] cost computation failed, recording event unpriced: ${err.message}`);
    costInfo = { cost_usd: null, rate_found: false, costComputeFailed: true };
  }

  // Anomaly and fraud checks BEFORE insertion, same reasoning as ingest.js -
  // comparing against the prior baseline, not one diluted by the event
  // being checked. Neither check blocks the request - see fraudDetection.js.
  // They are advisory, so a failure in a detector must never cost us the
  // usage record itself. checkAllAnomalies covers all five anomaly trigger
  // types as one system - see anomaly.js.
  try {
    await checkAllAnomalies({
      provider: providerName,
      model: effectiveModel,
      cost_usd: costInfo.cost_usd ?? 0,
      team,
      agent_id: agentId,
      client_region: clientRegion,
      db,
    });
    await checkKeyFraudSignals({ key_id: rateLimitKey, provider: providerName, model: effectiveModel, client_region: clientRegion, db, controlPlaneDb: req.controlPlaneDb });
  } catch (err) {
    logger.warn(`[proxy] advisory check failed (event still recorded): ${err.message}`);
  }

  const row = buildUsageRow(params, costInfo);
  let insertedId;
  try {
    insertedId = await insertUsageEvent(row, db);
  } catch (err) {
    err.usageRow = row; // so meterSafely can spool exactly what we failed to write
    throw err;
  }

  if (!team) {
    try {
      await inferTag({ key_id: rateLimitKey, usage_event_id: insertedId, db });
    } catch (err) {
      logger.warn(`[proxy] smart-tag inference failed (event still recorded): ${err.message}`);
    }
  }

  return costInfo;
}

// Meter without ever turning a completed (and already billed) provider call
// into a failure for the client. On failure: spool the row to disk, log
// loudly, best-effort alert. Returns { metered, cost_usd, ... }.
async function meterSafely(params) {
  try {
    const costInfo = await logUsageEvent(params);
    return { metered: true, ...costInfo };
  } catch (err) {
    const row =
      err.usageRow ||
      buildUsageRow(params, { cost_usd: null, rate_found: false, costComputeFailed: true });
    const spool = spoolEvent(row, err.message, { tenantSchema: params.tenantSchema });
    logger.error(`[metering] FAILED to record usage for ${params.providerName}/${params.effectiveModel} (key ${params.rateLimitKey}): ${err.message} - ${spool.spooled ? "spooled to " + spool.file : "NOT spooled, event lost"}`);
    try {
      await logAlert("metering-failure", `Usage for ${params.providerName}/${params.effectiveModel} (key '${params.rateLimitKey}') was not recorded: ${err.message}. ${spool.spooled ? "Spooled for replay (npm run replay-spool)." : "Could not be spooled - event lost."}`, params.db);
    } catch {
      // the store is probably what's down - the log line above is the record
    }
    return { metered: false, spooled: spool.spooled, cost_usd: null };
  }
}

// Parse OpenAI/Anthropic SSE stream usage - see sseParsing.js, shared with
// shadowTest.js's A8 streaming shadow-test support.
const { parseOpenAIStreamUsage, parseAnthropicStreamUsage, parseStreamText } = require("../sseParsing");

router.post("/:provider", requireAuth("write"), async (req, res) => {
  const providerName = req.params.provider.toLowerCase();
  const endpoint = PROVIDER_ENDPOINTS[providerName];
  if (!endpoint) {
    return res.status(400).json({ error: `Unknown provider '${providerName}'. Supported: openai, anthropic` });
  }

  const providerKey = req.header("X-Provider-Key");
  if (!providerKey) {
    return res.status(400).json({ error: "Missing X-Provider-Key header (your real OpenAI/Anthropic key - forwarded only, never stored)" });
  }

  let environment = req.header("X-Environment") || null;
  const gitBranch = req.header("X-Git-Branch") || null;
  let featureId = req.header("X-Feature-Id") || null;
  let customerId = req.header("X-Customer-Id") || null;
  let projectId = req.header("X-Project-Id") || null;
  let costCenter = req.header("X-Cost-Center") || null;
  const clientRegion = req.header("X-Client-Region") || null;
  const agentId = req.header("X-Agent-Id") || null;
  const sessionId = req.header("X-Session-Id") || null;
  const taskId = req.header("X-Task-Id") || null;
  const taskStatus = req.header("X-Task-Status") || null;
  const rateLimitKey = req.apiKey.key_id;
  const isStreaming = req.body?.stream === true;

  // --- Identity: team and workload class come from the KEY, not from headers
  // the caller controls - see keyIdentity.js for the full rules and why.
  const identity = resolveIdentity(req.apiKey, {
    teamHeader: req.header("X-Team"),
    workloadHeader: req.header("X-Workload-Type"),
  });
  if (!identity.ok) {
    await logAlert("identity-violation", `Blocked proxy request from key '${rateLimitKey}' - ${identity.code}: ${identity.error}`, req.db);
    return res.status(identity.status).json({ error: identity.error, code: identity.code });
  }
  const { team: identityTeam, workloadType, backgroundExempt } = identity;
  let team = identityTeam;

  // Declarative tagging rules (finops.yaml `tagging_rules:`, synced via
  // POST /api/gitops/sync) fill in any of these fields that are STILL
  // blank after key-binding/header resolution above - never overriding an
  // already-resolved value (a key-bound team from resolveIdentity, or a
  // header the caller actually sent). Reassigning these same variables (not
  // introducing new ones) is deliberate: everything below - governance,
  // row construction, smart-tag inference - already reads `team`/
  // `environment`/etc., so a rule-filled value flows through unchanged
  // rather than needing every downstream call site updated. See
  // tagRules.js for the full precedence rules.
  const { fields: resolvedTags } = await applyTagRules({
    key_id: realKeyId(req.apiKey),
    fields: { team, environment, project_id: projectId, cost_center: costCenter, customer_id: customerId, feature_id: featureId },
    db: req.db,
  });
  team = resolvedTags.team;
  environment = resolvedTags.environment;
  projectId = resolvedTags.project_id;
  costCenter = resolvedTags.cost_center;
  customerId = resolvedTags.customer_id;
  featureId = resolvedTags.feature_id;

  // --- Fail-closed metering (opt-in): refuse to spend money we couldn't
  // record. Pre-flight only - see the policy notes above.
  if (process.env.FINOPS_METERING_FAILURE_POLICY === "closed") {
    try {
      await req.db.get("SELECT 1 AS ok");
    } catch (err) {
      return res.status(503).json({
        error: "Usage metering store is unavailable and this deployment is configured fail-closed (FINOPS_METERING_FAILURE_POLICY=closed). The request was NOT forwarded to the provider.",
      });
    }
  }

  if (taskStatus && !TASK_STATUSES.includes(taskStatus)) {
    return res.status(400).json({ error: `X-Task-Status must be one of: ${TASK_STATUSES.join(", ")}` });
  }

  // --- Data residency: block BEFORE calling upstream if this request's
  // declared region isn't on the applicable allow-list. Checked early,
  // alongside quarantine/rate-limiting, since (like those) it's a
  // should-this-request-happen-at-all gate, not a cost-shaping decision
  // like the budget circuit breaker below.
  const residency = await checkRegionAllowed({ keyId: rateLimitKey, team, region: clientRegion, db: req.db });
  if (!residency.allowed) {
    await logAlert(
      "data-residency-violation",
      `Blocked proxy request from key '${rateLimitKey}' - region '${clientRegion}' is not on the ${residency.scope}-level allow-list`,
      req.db
    );
    return res.status(403).json({
      error: `Region '${clientRegion}' is not approved for this ${residency.scope}. Approved regions: ${residency.allowedRegions.join(", ")}`,
    });
  }

  // --- Governance: quarantine + rate limiting (shared by both paths) ---
  // isQuarantined/quarantineKey touch api_keys, which lives in the shared
  // control-plane schema in multi-tenant mode, NOT a tenant's own schema -
  // see auth.js's req.controlPlaneDb and governance.js's header.
  if (await isQuarantined(rateLimitKey, req.controlPlaneDb)) {
    const allowance = checkQuarantineAllowance(rateLimitKey, req.tenantId);
    if (!allowance.allowed) {
      return res.status(429).json({
        error: "This key is quarantined and limited to 1 request/minute pending human approval.",
        retryAfterSec: allowance.retryAfterSec,
      });
    }
  } else {
    const rl = checkRateLimit(rateLimitKey, undefined, req.tenantId);
    if (!rl.allowed) {
      return res.status(429).json({ error: "Rate limit exceeded", retryAfterSec: rl.retryAfterSec });
    }
  }

  // Per-tenant monthly usage-event quota (see tenantQuota.js) - a no-op in
  // single-tenant mode (req.tenantId unset). Checked here rather than only
  // at ingest.js's webhook, since the proxy path writes its own
  // usage_events row too (see insertUsageEvent below) and is the higher-
  // volume of the two paths in practice.
  const eventQuota = await checkMonthlyEventQuota(req);
  if (!eventQuota.allowed) {
    return res.status(429).json({ error: eventQuota.message, limit: eventQuota.limit, count: eventQuota.count });
  }

  // --- Governance: budget circuit breaker (graceful degradation) ---
  let requestedModel = req.body?.model;
  let effectiveModel = requestedModel;
  let degraded = false;

  // --- Model allow-listing: checked BEFORE the budget/circuit-breaker
  // logic below - no point computing this month's spend for a request
  // that's about to be rejected for model-access reasons anyway. Checked
  // against the REQUESTED model, not any later fallback - see
  // modelAllowlist.js for the full key-vs-team precedence rules.
  const allowlistCheck = await checkModelAllowed({ keyId: rateLimitKey, team, provider: providerName, model: requestedModel, db: req.db });
  if (!allowlistCheck.allowed) {
    await logAlert(
      "model-allowlist",
      `Blocked proxy request from key '${rateLimitKey}'${team ? ` (team '${team}')` : ""} - '${providerName}/${requestedModel}' is not on the ${allowlistCheck.scope}-level allow-list`,
      req.db
    );
    return res.status(403).json({
      error: `Model '${requestedModel}' is not allowed for this ${allowlistCheck.scope}.`,
      allowed_models: allowlistCheck.allowedModels,
    });
  }

  // --- Token quota: checked using consumption SO FAR (not including this
  // request, since its own token cost isn't known until the response comes
  // back) - see tokenQuota.js header for the full reasoning and the
  // documented tradeoff this implies.
  const quotaCheck = await checkTokenQuota({ keyId: rateLimitKey, team, db: req.db });
  if (!quotaCheck.allowed) {
    const v = quotaCheck.violations[0];
    await logAlert(
      "token-quota",
      `Blocked proxy request from key '${rateLimitKey}'${team ? ` (team '${team}')` : ""} - ${quotaCheck.scope}-level ${v.period} token quota exceeded (${v.used}/${v.limit})`,
      req.db
    );
    return res.status(429).json({
      error: `Token quota exceeded for this ${quotaCheck.scope}.`,
      violations: quotaCheck.violations,
    });
  }

  // Background/continuous-inference traffic (X-Workload-Type: background)
  // is deliberately EXEMPT from the team circuit-breaker/hard-block below -
  // a 24/7 monitoring or compliance-scanning agent throttled mid-cycle can
  // break the function it exists to perform, which is worse than letting
  // it keep running while its own separate 'background'-scope budget
  // alerts (see routes/budgets.js status computation) flag the overage for
  // a human to act on deliberately, rather than the system silently
  // degrading or cutting it off.
  if (team && !backgroundExempt) {
    const budget = await req.db.get("SELECT * FROM budgets WHERE scope_type = 'team' AND scope_value = ?", [team]);
    if (budget) {
      const month = new Date().toISOString().slice(0, 7);
      const spend = await req.db.get(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events WHERE team = ? AND ${yearMonthExpr("event_time")} = ?`,
        [team, month]
      );
      if (spend.spend >= budget.monthly_limit_usd) {
        const fallback = getFallback(providerName, requestedModel);
        if (fallback) {
          // A cheaper model exists - degrade rather than cut the team off
          // entirely. This is the "instead of hard-blocking" case the
          // original product plan describes: circuit-breaker degrade is
          // the softer alternative to a hard block, available whenever
          // there's actually a cheaper model to fall back to.
          effectiveModel = fallback.model;
          degraded = true;
          await logAlert("circuit-breaker", `Team '${team}' over budget - degraded ${providerName}/${requestedModel} -> ${fallback.model}`, req.db);
        } else {
          // No cheaper fallback is configured for this provider/model (see
          // FALLBACK_MODEL in governance.js) - there's nothing left to
          // degrade TO, so letting the request through would mean a team
          // that has explicitly exceeded its budget keeps spending at full
          // price with zero enforcement. That was a real gap: the request
          // silently proceeded unthrottled. This is the actual "hard
          // block" the product plan calls for - the enforcement of last
          // resort when the circuit breaker has no cheaper model to use.
          await logAlert(
            "budget-hard-block",
            `Blocked proxy request from key '${rateLimitKey}' (team '${team}') - over its $${budget.monthly_limit_usd} monthly budget ($${spend.spend.toFixed(2)} spent) with no configured fallback for ${providerName}/${requestedModel}`,
            req.db
          );
          return res.status(402).json({
            error: `Team '${team}' has exceeded its monthly budget of $${budget.monthly_limit_usd} (current spend: $${spend.spend.toFixed(2)}), and no cheaper fallback model is configured for '${providerName}/${requestedModel}' to degrade to instead.`,
            monthly_limit_usd: budget.monthly_limit_usd,
            current_spend_usd: Math.round(spend.spend * 10000) / 10000,
          });
        }
      }
    }
  }

  // --- Pricing check: know, BEFORE spending, whether this request can be costed.
  const rateInfo = await getRate(providerName, effectiveModel, req.db);
  const unpriced = !rateInfo;
  const priceApproximate = Boolean(rateInfo?.approximate);
  if (unpriced) {
    await noteUnpricedModel(providerName, effectiveModel, req.db, req.tenantId);
    if (process.env.FINOPS_UNPRICED_POLICY === "block") {
      return res.status(422).json({
        error: `No price is configured for '${providerName}/${effectiveModel}', and this deployment refuses unpriced models (FINOPS_UNPRICED_POLICY=block). Add a rate via POST /api/pricing/override.`,
      });
    }
  }
  const setPricingHeaders = (setter) => {
    if (unpriced) setter("X-FinOps-Unpriced", "true");
    if (priceApproximate) setter("X-FinOps-Price-Approximate", "true");
  };

  let outboundBody = { ...req.body, model: effectiveModel };
  if (isStreaming && providerName === "openai") {
    outboundBody.stream_options = { ...(outboundBody.stream_options || {}), include_usage: true };
  }

  // --- Prompt-injection detection: runs BEFORE PII redaction below - a
  // request that's about to be blocked shouldn't first pay the cost of
  // being redacted. Blocks outright (unlike PII redaction's redact-and-
  // continue) so a blocked request never reaches, or costs money against,
  // a real provider. See promptInjection.js header for the full reasoning.
  const injectionCheck = detectPromptInjection(extractPromptText(outboundBody));
  if (injectionCheck.flagged) {
    await logAlert(
      "prompt-injection",
      `Blocked proxy request from key '${rateLimitKey}'${team ? ` (team '${team}')` : ""} - matched: ${injectionCheck.matched.join(", ")}`
    );
    return res.status(400).json({
      error: "Request blocked: possible prompt injection detected.",
      matched_patterns: injectionCheck.matched,
    });
  }

  // --- PII redaction: on by default, applied to the actual outbound body ---
  // Unlike caching/shadow-testing (opt-in), this runs unless explicitly
  // disabled - the failure mode of "PII silently leaves your infra or gets
  // written to your own DB" is worse than the failure mode of "a request
  // gets redacted when it didn't strictly need to be". Redaction happens
  // BEFORE the request is sent upstream (so PII never reaches the provider)
  // and before it's used for cache keys/values or logged - everything
  // downstream (fetch call, cache, semantic cache, shadow test, raw_json)
  // sees the redacted version. Opt out per-request with
  // X-Disable-PII-Redaction: true (e.g. a support-bot use case that
  // legitimately needs to send a customer's real email to the model).
  let piiFindings = {};
  if (req.header("X-Disable-PII-Redaction") !== "true") {
    const { value, counts, hasPII } = redactValue(outboundBody);
    outboundBody = value;
    piiFindings = counts;
    if (hasPII) {
      await logAlert(
        "pii-redaction",
        `Redacted PII in proxy request - team:${team || "untagged"} - ${Object.entries(counts)
          .map(([k, v]) => `${k.toLowerCase()}:${v}`)
          .join(", ")}`,
        req.db
      );
    }
  }

  // ================= STREAMING PATH =================
  if (isStreaming) {
    // Time-to-first-byte guard only (see FINOPS_UPSTREAM_TIMEOUT_MS notes).
    const controller = new AbortController();
    const ttfbTimer = setTimeout(() => controller.abort(), upstreamTimeoutMs());
    try {
      let providerRes;
      try {
        providerRes = await fetch(endpoint.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...endpoint.authHeader(providerKey) },
          body: JSON.stringify(outboundBody),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(ttfbTimer);
      }

      if (!providerRes.ok || !providerRes.body) {
        const errJson = await providerRes.json().catch(() => ({ error: "Upstream error" }));
        return res.status(providerRes.status || 502).json(errJson);
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (degraded) res.setHeader("X-FinOps-Degraded", "true");
      if (Object.keys(piiFindings).length > 0) res.setHeader("X-FinOps-PII-Redacted", "true");
      setPricingHeaders((k, v) => res.setHeader(k, v));

      // If the client disconnects mid-stream, stop reading: breaking out of the
      // loop cancels the upstream body, so we stop paying for tokens nobody is
      // receiving. What was consumed up to that point is still metered below.
      let clientAborted = false;
      res.on("close", () => {
        if (!res.writableFinished) clientAborted = true;
      });

      let fullBuffer = "";
      let streamError = null;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of providerRes.body) {
          if (clientAborted) break;
          fullBuffer += decoder.decode(chunk, { stream: true });
          res.write(chunk);
        }
      } catch (err) {
        streamError = err; // upstream died mid-stream
      }

      const partial = clientAborted || Boolean(streamError);
      if (streamError && !res.headersSent) {
        // Nothing reached the client yet - a clean error is still possible.
        res.status(502).json({ error: "Upstream provider stream failed", detail: streamError.message });
      } else if (!res.writableEnded) {
        res.end();
      }

      const usage =
        providerName === "openai" ? parseOpenAIStreamUsage(fullBuffer) : parseAnthropicStreamUsage(fullBuffer);

      // Meter whatever was actually consumed. A stream that produced nothing
      // cost nothing, so it's skipped; anything else - complete OR cut short -
      // is recorded, because the provider bills for tokens generated even if
      // the client never saw them. (OpenAI only reports usage at the very end
      // of a stream, so a cut-short OpenAI stream is recorded with whatever
      // usage arrived - possibly none - and flagged partial.)
      let streamMetering = null;
      if (fullBuffer.length > 0 || usage.input_tokens > 0 || usage.output_tokens > 0) {
        streamMetering = await meterSafely({
          providerName, effectiveModel, team, environment, gitBranch, featureId, customerId, projectId, costCenter, clientRegion,
          agentId, sessionId, taskId, taskStatus, workloadType, rateLimitKey,
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          degraded, requestedModel, piiFindings, streamed: true, partial,
          db: req.db, controlPlaneDb: req.controlPlaneDb, tenantSchema: req.tenantSchema,
        });
      }
      if (partial) {
        try {
          await logAlert(
            "stream-interrupted",
            `Stream for ${providerName}/${effectiveModel} (key '${rateLimitKey}') ended early - ${clientAborted ? "client disconnected" : `upstream error: ${streamError.message}`}. Usage recorded may be incomplete.`,
            req.db
          );
        } catch {
          // alerting is best-effort here
        }
      }

      // ---- Shadow A/B testing (A8: streaming support) - same opt-in
      // header, fires AFTER the client's stream has already ended, same
      // fire-and-forget contract as the non-streaming path below. Skipped
      // on a partial/interrupted stream: the primary text itself is
      // incomplete, so a similarity comparison against it would be
      // comparing against a broken baseline, not a real answer.
      if (!partial && req.header("X-Enable-Shadow-Test") === "true") {
        const sampleRateHeader = Number(req.header("X-Shadow-Test-Sample-Rate"));
        const sampleRate = Number.isFinite(sampleRateHeader) ? sampleRateHeader : DEFAULT_SAMPLE_RATE;
        runShadowTest({
          providerName,
          primaryModel: effectiveModel,
          primaryRequestBody: outboundBody,
          primaryResponseText: parseStreamText(providerName, fullBuffer),
          primaryCostUsd: streamMetering?.cost_usd ?? 0,
          providerKey,
          team,
          endpoint,
          sampleRate,
          streamed: true,
          db: req.db,
        }).catch((err) => {
          console.warn(`[shadowTest] Unexpected failure (streaming): ${err.message}`);
        });
      }
    } catch (err) {
      if (!res.headersSent) {
        if (isTimeoutError(err)) {
          res.status(504).json({ error: `Upstream provider did not respond within ${upstreamTimeoutMs()}ms` });
        } else {
          res.status(502).json({ error: "Upstream provider stream failed", detail: err.message });
        }
      } else {
        res.end();
      }
    }
    return;
  }

  // ================= NON-STREAMING PATH (with opt-in caching) =================
  const cachingEnabled = req.header("X-Enable-Cache") === "true";
  const cacheKey = cachingEnabled ? makeCacheKey(providerName, effectiveModel, outboundBody, req.tenantId) : null;

  if (cachingEnabled) {
    const cachedResponse = getCached(cacheKey, req.tenantId);
    if (cachedResponse) {
      const { input_tokens, output_tokens } = endpoint.extractUsage(cachedResponse);
      const { cost_usd: wouldHaveCost } = await computeCost({ provider: providerName, model: effectiveModel, input_tokens, output_tokens, db: req.db });
      await insertUsageEvent({
        event_time: new Date().toISOString(),
        provider: providerName,
        model: effectiveModel,
        team, environment, git_branch: gitBranch, user_id: rateLimitKey, key_id: realKeyId(rateLimitKey),
        feature_id: featureId, customer_id: customerId, project_id: projectId, cost_center: costCenter, client_region: clientRegion,
        agent_id: agentId, session_id: sessionId, task_id: taskId, task_status: taskStatus, workload_type: workloadType,
        input_tokens, output_tokens,
        cost_usd: 0,
        tagged: team && environment ? 1 : 0,
        raw_json: JSON.stringify({ cacheHit: true, would_have_cost_usd: wouldHaveCost ?? 0 }),
      }, req.db);
      res.set("X-FinOps-Cache", "HIT");
      res.set("X-FinOps-Cost-USD", "0");
      res.set("X-FinOps-Cache-Savings-USD", String(wouldHaveCost ?? 0));
      return res.json(cachedResponse);
    }
  }

  // ---- Semantic cache (opt-in, checked only on an exact-match miss) ----
  // Exact match always takes priority - it's cheap and guaranteed-correct.
  // A semantic hit returns a response to a SIMILAR, not identical, prompt.
  const semanticEnabled = req.header("X-Enable-Semantic-Cache") === "true";
  const promptText = semanticEnabled ? extractPromptText(outboundBody) : null;

  if (semanticEnabled && promptText) {
    const match = await findSemanticMatch(providerName, effectiveModel, promptText, { tenantId: req.tenantId });
    if (match) {
      const { input_tokens, output_tokens } = endpoint.extractUsage(match.value);
      const { cost_usd: wouldHaveCost } = await computeCost({ provider: providerName, model: effectiveModel, input_tokens, output_tokens, db: req.db });
      await insertUsageEvent({
        event_time: new Date().toISOString(),
        provider: providerName,
        model: effectiveModel,
        team, environment, git_branch: gitBranch, user_id: rateLimitKey, key_id: realKeyId(rateLimitKey),
        feature_id: featureId, customer_id: customerId, project_id: projectId, cost_center: costCenter, client_region: clientRegion,
        agent_id: agentId, session_id: sessionId, task_id: taskId, task_status: taskStatus, workload_type: workloadType,
        input_tokens, output_tokens,
        cost_usd: 0,
        tagged: team && environment ? 1 : 0,
        raw_json: JSON.stringify({ semanticCacheHit: true, similarity: match.similarity, would_have_cost_usd: wouldHaveCost ?? 0 }),
      }, req.db);
      res.set("X-FinOps-Cache", "SEMANTIC-HIT");
      res.set("X-FinOps-Cache-Similarity", match.similarity.toFixed(4));
      res.set("X-FinOps-Cost-USD", "0");
      res.set("X-FinOps-Cache-Savings-USD", String(wouldHaveCost ?? 0));
      return res.json(match.value);
    }
  }

  try {
    const providerRes = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...endpoint.authHeader(providerKey) },
      body: JSON.stringify(outboundBody),
      signal: AbortSignal.timeout(upstreamTimeoutMs()),
    });

    const responseJson = await providerRes.json();
    if (!providerRes.ok) {
      return res.status(providerRes.status).json(responseJson);
    }

    if (cachingEnabled) {
      const ttl = Number(req.header("X-Cache-TTL-Seconds")) || undefined;
      setCached(cacheKey, responseJson, ttl, req.tenantId);
    }

    if (semanticEnabled && promptText) {
      const ttl = Number(req.header("X-Cache-TTL-Seconds")) || undefined;
      setSemanticCache(providerName, effectiveModel, promptText, responseJson, ttl, { tenantId: req.tenantId }).catch((err) => {
        console.warn(`[semanticCache] Failed to store entry: ${err.message}`);
      });
    }

    const { input_tokens, output_tokens } = endpoint.extractUsage(responseJson);
    // The provider call already succeeded (and was billed) - a metering failure
    // must not turn that into an error for the client. See meterSafely().
    const metering = await meterSafely({
      providerName, effectiveModel, team, environment, gitBranch, featureId, customerId, projectId, costCenter, clientRegion,
      agentId, sessionId, taskId, taskStatus, workloadType, rateLimitKey,
      input_tokens, output_tokens, degraded, requestedModel, piiFindings, streamed: false,
      db: req.db, controlPlaneDb: req.controlPlaneDb, tenantSchema: req.tenantSchema,
    });
    const cost_usd = metering.cost_usd;

    if (metering.metered) res.set("X-FinOps-Cost-USD", String(cost_usd ?? 0));
    else res.set("X-FinOps-Metering", "failed");
    setPricingHeaders((k, v) => res.set(k, v));
    if (cachingEnabled) res.set("X-FinOps-Cache", "MISS");
    if (degraded) res.set("X-FinOps-Degraded", "true");
    if (Object.keys(piiFindings).length > 0) res.set("X-FinOps-PII-Redacted", "true");
    res.json(responseJson);

    // ---- Shadow A/B testing (opt-in, fires AFTER the client already has
    // its response - see shadowTest.js for why this is fire-and-forget) ----
    if (req.header("X-Enable-Shadow-Test") === "true") {
      const sampleRateHeader = Number(req.header("X-Shadow-Test-Sample-Rate"));
      const sampleRate = Number.isFinite(sampleRateHeader) ? sampleRateHeader : DEFAULT_SAMPLE_RATE;
      runShadowTest({
        providerName,
        primaryModel: effectiveModel,
        primaryRequestBody: outboundBody,
        primaryResponseJson: responseJson,
        primaryCostUsd: cost_usd ?? 0,
        providerKey,
        team,
        endpoint,
        sampleRate,
        db: req.db,
      }).catch((err) => {
        console.warn(`[shadowTest] Unexpected failure: ${err.message}`);
      });
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      return res.status(504).json({ error: `Upstream provider did not respond within ${upstreamTimeoutMs()}ms` });
    }
    res.status(502).json({ error: "Upstream provider request failed", detail: err.message });
  }
});

module.exports = router;
