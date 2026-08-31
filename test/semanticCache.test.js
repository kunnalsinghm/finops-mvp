// test/semanticCache.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findSemanticMatch,
  setSemanticCache,
  clearSemanticCache,
  getSemanticCacheStats,
  cosineSimilarityLocal,
  termFrequency,
  tokenize,
  extractPromptText,
} = require("../server/semanticCache");

test.beforeEach(() => {
  clearSemanticCache();
});

test("cosineSimilarityLocal returns 1.0 for identical text", () => {
  const a = termFrequency(tokenize("summarize this quarterly report for me"));
  const b = termFrequency(tokenize("summarize this quarterly report for me"));
  assert.ok(Math.abs(cosineSimilarityLocal(a, b) - 1) < 1e-9, "expected similarity ~1.0 for identical text");
});

test("cosineSimilarityLocal returns near 0 for completely different text", () => {
  const a = termFrequency(tokenize("summarize this quarterly report"));
  const b = termFrequency(tokenize("write a poem about the ocean"));
  const sim = cosineSimilarityLocal(a, b);
  assert.ok(sim < 0.1, `expected near-zero similarity, got ${sim}`);
});

test("extractPromptText pulls text out of an OpenAI-style messages array", () => {
  const body = { messages: [{ role: "user", content: "What is the capital of France?" }] };
  assert.equal(extractPromptText(body), "What is the capital of France?");
});

test("extractPromptText pulls text out of an Anthropic-style content-block array", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "What is the capital of France?" }] }] };
  assert.equal(extractPromptText(body), "What is the capital of France?");
});

test("findSemanticMatch finds a reworded-but-similar prompt above threshold", async () => {
  const original = "Please summarize this quarterly financial report for the board.";
  const reworded = "Please summarize this quarterly financial report for the board members.";

  await setSemanticCache("openai", "gpt-4o", original, { fakeResponse: true }, 300);
  const match = await findSemanticMatch("openai", "gpt-4o", reworded);

  assert.ok(match, "expected a semantic match for a near-identical reworded prompt");
  assert.equal(match.value.fakeResponse, true);
  assert.ok(match.similarity >= 0.92, `similarity ${match.similarity} should be at/above default threshold`);
});

test("findSemanticMatch does not match genuinely different prompts", async () => {
  await setSemanticCache("openai", "gpt-4o", "Summarize this quarterly financial report.", { fakeResponse: "report" }, 300);
  const match = await findSemanticMatch("openai", "gpt-4o", "Write a haiku about autumn leaves.");
  assert.equal(match, null);
});

test("findSemanticMatch respects provider/model scoping - same text, different model does not match", async () => {
  await setSemanticCache("openai", "gpt-4o", "Summarize this report.", { fakeResponse: true }, 300);
  const match = await findSemanticMatch("openai", "gpt-3.5-turbo", "Summarize this report.");
  assert.equal(match, null, "identical prompt text should not match across different models");
});

test("findSemanticMatch respects provider scoping - same text, different provider does not match", async () => {
  await setSemanticCache("openai", "gpt-4o", "Summarize this report.", { fakeResponse: true }, 300);
  const match = await findSemanticMatch("anthropic", "gpt-4o", "Summarize this report.");
  assert.equal(match, null, "identical prompt text should not match across different providers");
});

test("findSemanticMatch does not return an entry past its TTL", async () => {
  await setSemanticCache("openai", "gpt-4o", "Summarize this report.", { fakeResponse: true }, -1); // already expired
  const match = await findSemanticMatch("openai", "gpt-4o", "Summarize this report.");
  assert.equal(match, null, "expired entry should not be returned");
});

test("getSemanticCacheStats tracks hits and misses correctly", async () => {
  await setSemanticCache("openai", "gpt-4o", "Summarize this quarterly report.", { fakeResponse: true }, 300);

  await findSemanticMatch("openai", "gpt-4o", "Summarize this quarterly report."); // hit
  await findSemanticMatch("openai", "gpt-4o", "Write a haiku about the moon."); // miss

  const stats = getSemanticCacheStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hit_rate_pct, 50);
});

test("clearSemanticCache empties the store and resets stats", async () => {
  await setSemanticCache("openai", "gpt-4o", "Some prompt.", { fakeResponse: true }, 300);
  await findSemanticMatch("openai", "gpt-4o", "Some prompt.");

  clearSemanticCache();
  const stats = getSemanticCacheStats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 0);
  assert.equal(stats.current_size, 0);
});
