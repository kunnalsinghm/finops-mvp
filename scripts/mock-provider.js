// scripts/mock-provider.js - a tiny local stand-in for OpenAI/Anthropic APIs,
// so the full proxy flow (governance, caching, semantic caching, cost
// logging) can be tested end-to-end with zero real API cost.
//
// Usage: node scripts/mock-provider.js
// Then point the real server at it via .env:
//   OPENAI_BASE_URL=http://localhost:5001/v1/chat/completions
//   ANTHROPIC_BASE_URL=http://localhost:5001/v1/messages

const express = require("express");
const app = express();
app.use(express.json());

const PORT = 5001;

function fakeTokenCount(text) {
  // Rough word-count proxy, just needs to be nonzero and vary a bit.
  return Math.max(5, (text || "").split(/\s+/).length);
}

function extractText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
}

// OpenAI-shaped endpoint
app.post("/v1/chat/completions", (req, res) => {
  const promptText = extractText(req.body);
  const input_tokens = fakeTokenCount(promptText);
  const output_tokens = 12;

  if (req.body?.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    const chunk = {
      id: "mock-chunk",
      choices: [{ delta: { content: "This is a mock streamed response." } }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const usageChunk = {
      id: "mock-chunk-final",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: input_tokens, completion_tokens: output_tokens },
    };
    res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  res.json({
    id: "mock-" + Date.now(),
    object: "chat.completion",
    model: req.body?.model || "gpt-4o-mini",
    choices: [
      { index: 0, message: { role: "assistant", content: `Mock response to: "${promptText.slice(0, 60)}"` }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: input_tokens, completion_tokens: output_tokens, total_tokens: input_tokens + output_tokens },
  });
});

// Anthropic-shaped endpoint
app.post("/v1/messages", (req, res) => {
  const promptText = extractText(req.body);
  const input_tokens = fakeTokenCount(promptText);
  const output_tokens = 12;

  if (req.body?.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens } } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "This is a mock streamed response." } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    return res.end();
  }

  res.json({
    id: "mock-" + Date.now(),
    type: "message",
    role: "assistant",
    model: req.body?.model || "claude-sonnet",
    content: [{ type: "text", text: `Mock response to: "${promptText.slice(0, 60)}"` }],
    usage: { input_tokens, output_tokens },
  });
});

app.listen(PORT, () => {
  console.log(`Mock provider running at http://localhost:${PORT}`);
  console.log(`Set in .env: OPENAI_BASE_URL=http://localhost:${PORT}/v1/chat/completions`);
  console.log(`Set in .env: ANTHROPIC_BASE_URL=http://localhost:${PORT}/v1/messages`);
});
