// promptInjection.js - Prompt-injection detection (security/compliance
// roadmap addition, alongside piiRedaction.js).
//
// DESIGN DECISIONS (matching this codebase's existing honesty conventions -
// see recommend.js, semanticCache.js, and piiRedaction.js header comments
// for the same style):
//   - Rule-based pattern matching, NOT an ML classifier. This catches known,
//     common jailbreak/injection phrasings. It will NOT catch a novel or
//     carefully obfuscated attempt. Treat this as a floor, not a ceiling.
//   - BLOCKS the request outright (HTTP 400) rather than flagging-and-passing-
//     through - the opposite default from piiRedaction.js's redact-and-
//     continue. That's an intentional difference: PII can safely be scrubbed
//     and the request still makes sense; a detected injection attempt
//     letting the request through even partially defeats the point, so this
//     fails closed instead.
//   - Applied at TWO surfaces, and runs BEFORE PII redaction at both (see
//     routes/proxy.js and routes/ingest.js) - a request that's about to be
//     rejected shouldn't first pay the cost of being redacted:
//       1. routes/proxy.js - scans the extracted prompt text BEFORE any
//          upstream call, so a blocked request never reaches (or costs
//          money against) a real provider.
//       2. routes/ingest.js - scans the entire raw request body BEFORE
//          persisting, as defense-in-depth: ingest never calls an LLM
//          itself, but a payload planted in ANY field (not just recognized
//          ones, since raw_json stores the whole body) could be replayed
//          into a real prompt later by some downstream feature.
//   - Normalization is intentionally light (case-fold, collapse whitespace,
//     strip zero-width characters) to catch trivial spacing/casing evasion
//     without pretending to defeat serious obfuscation (base64, unicode
//     homoglyphs, translation-based smuggling, etc. are explicitly OUT of
//     scope for this v1 - see Known gaps in the README).

// Strips zero-width/invisible characters sometimes used to break up a
// flagged phrase (e.g. "ignore\u200Ball\u200Bprevious\u200Binstructions"),
// treating them as separators (not deletions) so obfuscated spacing doesn't
// glue words together and accidentally defeat detection - then collapses
// whitespace so casing/spacing tricks don't trivially evade the patterns.
function normalizeText(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

// Each pattern is named so a block response and the alerts log can say
// WHAT kind of attempt was matched, without exposing the actual regex
// (which would just hand over a bypass roadmap for free).
const INJECTION_PATTERNS = [
  {
    name: "ignore_previous_instructions",
    regex: /\bignore\s+(all\s+)?(the\s+)?((previous|prior|above)\s+)+(instructions?|prompts?|rules?)\b/,
  },
  {
    name: "disregard_instructions",
    regex: /\bdisregard\s+(all\s+)?(the\s+)?((previous|prior|above|system)\s+)+(instructions?|prompts?|rules?)\b/,
  },
  {
    name: "forget_prior_context",
    regex: /\bforget\s+(everything|all)\s+(you\s+)?(were\s+told|know|learned)\b/,
  },
  {
    name: "reveal_system_prompt",
    regex: /\b(reveal|show|print|output|repeat)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions)\b/,
  },
  {
    name: "what_are_your_instructions",
    regex: /\bwhat\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions|rules)\b/,
  },
  {
    name: "new_instructions_override",
    regex: /\b(new|updated)\s+instructions?\s*:/,
  },
  {
    name: "jailbreak_persona",
    regex: /\byou\s+are\s+now\s+(dan\b|no\s+longer\s+bound|free\s+from|unrestricted)/,
  },
  {
    name: "no_restrictions_roleplay",
    regex: /\b(act|behave|respond)\s+as\s+(if\s+)?(there\s+(are|is)\s+no|without\s+any)\s+(restrictions?|rules?|filters?|limits?)\b/,
  },
];

// Runs every pattern against normalized text. Returns which named patterns
// matched (possibly more than one) rather than stopping at the first hit,
// so a block response/audit entry can show the full picture.
function detectPromptInjection(text) {
  if (!text || typeof text !== "string") return { flagged: false, matched: [] };
  const normalized = normalizeText(text);
  const matched = INJECTION_PATTERNS.filter((p) => p.regex.test(normalized)).map((p) => p.name);
  return { flagged: matched.length > 0, matched };
}

module.exports = { detectPromptInjection, normalizeText, INJECTION_PATTERNS };
