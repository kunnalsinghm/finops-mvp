// modelAlternatives.js - shared table of (expensive model -> cheaper
// same-provider alternative) pairs worth testing.
//
// Used by BOTH recommend.js (to surface cost-savings opportunities) and
// shadowTest.js (to know which alternative model to shadow-test a request
// against). Kept in its own module, separate from recommend.js, so those
// two modules don't need to require each other - recommend.js also needs
// to read shadow-test results (via shadowTest.js) to enrich its
// recommendations, and a two-way require between them would be a circular
// dependency.
//
// Deliberately conservative: same provider only, so behavior/quality is
// more likely to be comparable than a cross-provider switch.
const CHEAPER_ALTERNATIVES = {
  "openai/gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
  "anthropic/claude-opus": { provider: "anthropic", model: "claude-sonnet" },
  "anthropic/claude-sonnet": { provider: "anthropic", model: "claude-haiku" },
};

module.exports = { CHEAPER_ALTERNATIVES };
