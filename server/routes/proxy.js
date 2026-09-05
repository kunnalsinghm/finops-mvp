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
const db = require("../db");
const { computeCost } = require("../pricing");
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
const { checkAnomaly } = require("../anomaly");
const { runShadowTest, DEFAULT_SAMPLE_RATE } = require("../shadowTest");
const { redactValue } = require("../piiRedaction");

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

const insertEvent = db.prepare(`
  INSERT INTO usage_events
    (event_time, provider, model, team, environment, git_branch, user_id,
     input_tokens, output_tokens, cost_usd, tagged, raw_json)
  VALUES
    (@event_time, @provider, @model, @team, @environment, @git_branch, @user_id,
     @input_tokens, @output_tokens, @cost_usd, @tagged, @raw_json)
`);

function logUsageEvent({ providerName, effectiveModel, team, environment, gitBranch, rateLimitKey, input_tokens, output_tokens, degraded, requestedModel, piiFindings }) {
  const { cost_usd } = computeCost({ provider: providerName, model: effectiveModel, input_tokens, output_tokens });

  // Anomaly check BEFORE insertion, same reasoning as ingest.js - comparing
  // against the prior baseline, not one diluted by the event being checked.
  checkAnomaly({ provider: providerName, model: effectiveModel, cost_usd: cost_usd ?? 0, team });

  insertEvent.run({
    event_time: new Date().toISOString(),
    provider: providerName,
    model: effectiveModel,
    team,
    environment,
    git_branch: gitBranch,
    user_id: rateLimitKey,
    input_tokens,
    output_tokens,
    cost_usd: cost_usd ?? 0,
    tagged: team && environment ? 1 : 0,
    raw_json: JSON.stringify({
      degraded,
      requestedModel,
      effectiveModel,
      streamed: true,
      ...(piiFindings && Object.keys(piiFindings).length > 0 ? { piiRedacted: piiFindings } : {}),
    }),
  });
  return cost_usd;
}

// Parse OpenAI SSE stream text for the final usage object
// (present because we force stream_options.include_usage = true)
function parseOpenAIStreamUsage(buffer) {
  const lines = buffer.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const json = JSON.parse(lines[i].slice(6));
      if (json.usage) {
        return { input_tokens: json.usage.prompt_tokens || 0, output_tokens: json.usage.completion_tokens || 0 };
      }
    } catch {
      // skip malformed line
    }
  }
  return { input_tokens: 0, output_tokens: 0 };
}

// Parse Anthropic SSE stream text: input_tokens from message_start,
// output_tokens from the last message_delta usage block.
function parseAnthropicStreamUsage(buffer) {
  let input_tokens = 0;
  let output_tokens = 0;
  const lines = buffer.split("\n").filter((l) => l.startsWith("data: "));
  for (const line of lines) {
    try {
      const json = JSON.parse(line.slice(6));
      if (json.type === "message_start" && json.message?.usage?.input_tokens) {
        input_tokens = json.message.usage.input_tokens;
      }
      if (json.type === "message_delta" && json.usage?.output_tokens) {
        output_tokens = json.usage.output_tokens;
      }
    } catch {
      // skip malformed line
    }
  }
  return { input_tokens, output_tokens };
}

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

  const team = req.header("X-Team") || null;
  const environment = req.header("X-Environment") || null;
  const gitBranch = req.header("X-Git-Branch") || null;
  const rateLimitKey = req.apiKey.key_id;
  const isStreaming = req.body?.stream === true;

  // --- Governance: quarantine + rate limiting (shared by both paths) ---
  if (isQuarantined(rateLimitKey)) {
    const allowance = checkQuarantineAllowance(rateLimitKey);
    if (!allowance.allowed) {
      return res.status(429).json({
        error: "This key is quarantined and limited to 1 request/minute pending human approval.",
        retryAfterSec: allowance.retryAfterSec,
      });
    }
  } else {
    const rl = checkRateLimit(rateLimitKey);
    if (!rl.allowed) {
      return res.status(429).json({ error: "Rate limit exceeded", retryAfterSec: rl.retryAfterSec });
    }
  }

  // --- Governance: budget circuit breaker (graceful degradation) ---
  let requestedModel = req.body?.model;
  let effectiveModel = requestedModel;
  let degraded = false;

  if (team) {
    const budget = db.prepare("SELECT * FROM budgets WHERE scope_type = 'team' AND scope_value = ?").get(team);
    if (budget) {
      const month = new Date().toISOString().slice(0, 7);
      const spend = db
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events WHERE team = ? AND strftime('%Y-%m', event_time) = ?`)
        .get(team, month);
      if (spend.spend >= budget.monthly_limit_usd) {
        const fallback = getFallback(providerName, requestedModel);
        if (fallback) {
          effectiveModel = fallback.model;
          degraded = true;
          logAlert("circuit-breaker", `Team '${team}' over budget - degraded ${providerName}/${requestedModel} -> ${fallback.model}`);
        }
      }
    }
  }

  let outboundBody = { ...req.body, model: effectiveModel };
  if (isStreaming && providerName === "openai") {
    outboundBody.stream_options = { ...(outboundBody.stream_options || {}), include_usage: true };
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
      logAlert(
        "pii-redaction",
        `Redacted PII in proxy request - team:${team || "untagged"} - ${Object.entries(counts)
          .map(([k, v]) => `${k.toLowerCase()}:${v}`)
          .join(", ")}`
      );
    }
  }

  // ================= STREAMING PATH =================
  if (isStreaming) {
    try {
      const providerRes = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...endpoint.authHeader(providerKey) },
        body: JSON.stringify(outboundBody),
      });

      if (!providerRes.ok || !providerRes.body) {
        const errJson = await providerRes.json().catch(() => ({ error: "Upstream error" }));
        return res.status(providerRes.status || 502).json(errJson);
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (degraded) res.setHeader("X-FinOps-Degraded", "true");
      if (Object.keys(piiFindings).length > 0) res.setHeader("X-FinOps-PII-Redacted", "true");

      let fullBuffer = "";
      const decoder = new TextDecoder();

      for await (const chunk of providerRes.body) {
        const text = decoder.decode(chunk, { stream: true });
        fullBuffer += text;
        res.write(chunk);
      }
      res.end();

      const usage =
        providerName === "openai" ? parseOpenAIStreamUsage(fullBuffer) : parseAnthropicStreamUsage(fullBuffer);

      logUsageEvent({
        providerName, effectiveModel, team, environment, gitBranch, rateLimitKey,
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        degraded, requestedModel, piiFindings,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: "Upstream provider stream failed", detail: err.message });
      } else {
        res.end();
      }
    }
    return;
  }

  // ================= NON-STREAMING PATH (with opt-in caching) =================
  const cachingEnabled = req.header("X-Enable-Cache") === "true";
  const cacheKey = cachingEnabled ? makeCacheKey(providerName, effectiveModel, outboundBody) : null;

  if (cachingEnabled) {
    const cachedResponse = getCached(cacheKey);
    if (cachedResponse) {
      const { input_tokens, output_tokens } = endpoint.extractUsage(cachedResponse);
      const { cost_usd: wouldHaveCost } = computeCost({ provider: providerName, model: effectiveModel, input_tokens, output_tokens });
      insertEvent.run({
        event_time: new Date().toISOString(),
        provider: providerName,
        model: effectiveModel,
        team, environment, git_branch: gitBranch, user_id: rateLimitKey,
        input_tokens, output_tokens,
        cost_usd: 0,
        tagged: team && environment ? 1 : 0,
        raw_json: JSON.stringify({ cacheHit: true, would_have_cost_usd: wouldHaveCost ?? 0 }),
      });
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
    const match = await findSemanticMatch(providerName, effectiveModel, promptText);
    if (match) {
      const { input_tokens, output_tokens } = endpoint.extractUsage(match.value);
      const { cost_usd: wouldHaveCost } = computeCost({ provider: providerName, model: effectiveModel, input_tokens, output_tokens });
      insertEvent.run({
        event_time: new Date().toISOString(),
        provider: providerName,
        model: effectiveModel,
        team, environment, git_branch: gitBranch, user_id: rateLimitKey,
        input_tokens, output_tokens,
        cost_usd: 0,
        tagged: team && environment ? 1 : 0,
        raw_json: JSON.stringify({ semanticCacheHit: true, similarity: match.similarity, would_have_cost_usd: wouldHaveCost ?? 0 }),
      });
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
    });

    const responseJson = await providerRes.json();
    if (!providerRes.ok) {
      return res.status(providerRes.status).json(responseJson);
    }

    if (cachingEnabled) {
      const ttl = Number(req.header("X-Cache-TTL-Seconds")) || undefined;
      setCached(cacheKey, responseJson, ttl);
    }

    if (semanticEnabled && promptText) {
      const ttl = Number(req.header("X-Cache-TTL-Seconds")) || undefined;
      setSemanticCache(providerName, effectiveModel, promptText, responseJson, ttl).catch((err) => {
        console.warn(`[semanticCache] Failed to store entry: ${err.message}`);
      });
    }

    const { input_tokens, output_tokens } = endpoint.extractUsage(responseJson);
    const cost_usd = logUsageEvent({
      providerName, effectiveModel, team, environment, gitBranch, rateLimitKey,
      input_tokens, output_tokens, degraded, requestedModel, piiFindings,
    });

    res.set("X-FinOps-Cost-USD", String(cost_usd ?? 0));
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
      }).catch((err) => {
        console.warn(`[shadowTest] Unexpected failure: ${err.message}`);
      });
    }
  } catch (err) {
    res.status(502).json({ error: "Upstream provider request failed", detail: err.message });
  }
});

module.exports = router;

