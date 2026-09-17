// piiRedaction.js - regex-based PII detection and redaction, zero external
// dependencies (consistent with this project's "local mode by default" bias -
// see semanticCache.js for the same philosophy applied to embeddings).
//
// Scope and design decisions:
//   - This redacts REQUEST content before it leaves your infrastructure (sent
//     to the upstream provider) and before it is persisted anywhere (usage
//     event logs, cache keys/values, semantic cache). It does NOT redact the
//     provider's response before returning it to the client - the response
//     is what the caller is paying for, and mangling it would break real
//     usage. Stored copies of the request are what this protects.
//   - Detection is pattern-based, not a model - it WILL miss creative
//     obfuscation and WILL occasionally false-positive on things that look
//     like PII but aren't (e.g. a 16-digit order ID that happens to pass
//     Luhn). Treat this as a meaningful reduction in accidental PII leakage,
//     not a compliance guarantee. For genuinely regulated data, pair this
///    with contractual/DPA controls, not just this filter.
//   - Behavior is redact-and-continue, not block: matched PII is replaced
//     with a typed placeholder (e.g. [REDACTED_EMAIL]) and the request
//     proceeds. This mirrors the project's existing WARN-not-reject stance
//     on untagged spend (see routes/ingest.js).

// Luhn check to cut down false positives on the credit-card pattern - a lot
// of 13-16 digit sequences in real traffic are order IDs, phone numbers with
// extensions, etc., and most of those will NOT pass Luhn.
function passesLuhn(digitsOnly) {
  let sum = 0;
  let alt = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let n = parseInt(digitsOnly[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Each rule: name (used both as the counter key and the [REDACTED_X] token),
// a regex, and an optional validate(matchText) => boolean gate to cut down
// false positives beyond what the regex alone can do.
const RULES = [
  {
    name: "EMAIL",
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
  },
  {
    name: "SSN",
    // US SSN format only (###-##-####) - intentionally does NOT match bare
    // 9-digit runs, which would false-positive constantly on invoice/order
    // numbers, tokens, etc.
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: "CREDIT_CARD",
    // 13-19 digits, optionally grouped with spaces or hyphens (covers Visa/
    // Mastercard/Amex/Discover length ranges), gated by a Luhn check.
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (match) => {
      const digits = match.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
    },
  },
  {
    name: "PHONE",
    // Loosely matches US/international-ish phone formats. Deliberately
    // requires a separator or a leading + to avoid matching arbitrary
    // 10-digit numbers (timestamps, IDs) - a known limitation, not a
    // guarantee of catching every phone format worldwide.
    regex: /\b(?:\+?\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  },
  {
    name: "IP_ADDRESS",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  },
];

// Redact a single string. Returns { text, counts } where counts is a map of
// rule name -> number of matches redacted (only non-zero entries included).
function redactText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { text, counts: {} };
  }

  let result = text;
  const counts = {};

  for (const rule of RULES) {
    let n = 0;
    result = result.replace(rule.regex, (match) => {
      if (rule.validate && !rule.validate(match)) return match;
      n++;
      return `[REDACTED_${rule.name}]`;
    });
    if (n > 0) counts[rule.name] = n;
  }

  return { text: result, counts };
}

function mergeCounts(target, source) {
  for (const [k, v] of Object.entries(source)) {
    target[k] = (target[k] || 0) + v;
  }
  return target;
}

// Deep-redacts every string value in an arbitrary JSON-shaped value (object,
// array, or primitive), preserving structure. Returns { value, counts,
// hasPII }. Used on proxy request bodies (redact message content before it's
// sent upstream and before it's persisted) and on ingest bodies (redact
// before storing in raw_json).
function redactValue(value) {
  const counts = {};

  function walk(v) {
    if (typeof v === "string") {
      const { text, counts: c } = redactText(v);
      mergeCounts(counts, c);
      return text;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }

  const redacted = walk(value);
  return { value: redacted, counts, hasPII: Object.keys(counts).length > 0 };
}

module.exports = { redactText, redactValue };

