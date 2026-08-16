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

function logUsageEvent({ providerName, effectiveModel, team, environment, gitBranch, rateLimitKey, input_tokens, output_tokens, degraded, requestedModel }) {
  const { cost_usd } = computeCost({ provider: providerName, model: effectiveModel, input_tokens, output_tokens });
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
    raw_json: JSON.stringify({ degraded, requestedModel, effectiveModel, streamed: true }),
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
    // Forces OpenAI to send exact usage in the final SSE chunk instead of us estimating.
    outboundBody.stream_options = { ...(outboundBody.stream_options || {}), include_usage: true };
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

      let fullBuffer = "";
      const decoder = new TextDecoder();

      for await (const chunk of providerRes.body) {
        const text = decoder.decode(chunk, { stream: true });
        fullBuffer += text;
        res.write(chunk); // pass through to client in real time, unmodified
      }
      res.end();

      const usage =
        providerName === "openai" ? parseOpenAIStreamUsage(fullBuffer) : parseAnthropicStreamUsage(fullBuffer);

      logUsageEvent({
        providerName, effectiveModel, team, environment, gitBranch, rateLimitKey,
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        degraded, requestedModel,
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

  // ================= NON-STREAMING PATH (unchanged) =================
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

    const { input_tokens, output_tokens } = endpoint.extractUsage(responseJson);
    const cost_usd = logUsageEvent({
      providerName, effectiveModel, team, environment, gitBranch, rateLimitKey,
      input_tokens, output_tokens, degraded, requestedModel,
    });

    res.set("X-FinOps-Cost-USD", String(cost_usd ?? 0));
    if (degraded) res.set("X-FinOps-Degraded", "true");
    res.json(responseJson);
  } catch (err) {
    res.status(502).json({ error: "Upstream provider request failed", detail: err.message });
  }
});

module.exports = router;