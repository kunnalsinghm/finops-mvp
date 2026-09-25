// sseParsing.js - parsing helpers for OpenAI/Anthropic Server-Sent-Events
// stream bodies. Extracted out of routes/proxy.js (where the usage
// parsers originated) so shadowTest.js's A8 streaming shadow-test support
// can reuse the EXACT SAME parsing logic instead of a second
// hand-maintained copy - two implementations of "how do I read this SSE
// format" drifting apart over time would be a much worse outcome than one
// shared module. See routes/proxy.js's streaming path for the primary
// accumulation loop this mirrors, and shadowTest.js's runShadowTest for
// the shadow-call accumulation loop that uses these same parsers.

// Parse OpenAI SSE stream text for the final usage object (present because
// callers force stream_options.include_usage = true on the request).
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

// Reassemble the actual response TEXT from an OpenAI SSE stream - each
// chunk's choices[0].delta.content is a fragment, concatenated in order.
// Used by shadowTest.js (A8) to compare a streamed primary response
// against a streamed shadow response, the same way extractResponseText
// does for non-streaming JSON response bodies.
function parseOpenAIStreamText(buffer) {
  const lines = buffer.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
  let text = "";
  for (const line of lines) {
    try {
      const json = JSON.parse(line.slice(6));
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch {
      // skip malformed line
    }
  }
  return text;
}

// Reassemble the actual response TEXT from an Anthropic SSE stream -
// content_block_delta events carry delta.text fragments in order.
function parseAnthropicStreamText(buffer) {
  const lines = buffer.split("\n").filter((l) => l.startsWith("data: "));
  let text = "";
  for (const line of lines) {
    try {
      const json = JSON.parse(line.slice(6));
      if (json.type === "content_block_delta" && typeof json.delta?.text === "string") {
        text += json.delta.text;
      }
    } catch {
      // skip malformed line
    }
  }
  return text;
}

function parseStreamUsage(providerName, buffer) {
  return providerName === "openai" ? parseOpenAIStreamUsage(buffer) : parseAnthropicStreamUsage(buffer);
}

function parseStreamText(providerName, buffer) {
  return providerName === "openai" ? parseOpenAIStreamText(buffer) : parseAnthropicStreamText(buffer);
}

module.exports = {
  parseOpenAIStreamUsage,
  parseAnthropicStreamUsage,
  parseOpenAIStreamText,
  parseAnthropicStreamText,
  parseStreamUsage,
  parseStreamText,
};
