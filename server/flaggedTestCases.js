// flaggedTestCases.js - A8 cheap groundwork for Compass's future
// production-trace-to-test-case pipeline. Deliberately NOT that pipeline:
// this just captures the raw material (a prompt/response pair, why it was
// flagged) from signals Guard already computes, because that's cheap to do
// now and expensive to backfill once the underlying traffic has aged out
// of retention. Turning these rows into an actual eval suite, deduping
// them, curating them, etc. is explicitly out of scope here - see the A8
// gap analysis entry this implements.
//
// source is one of three signals, each wired in from wherever that signal
// is already computed (no new detection logic invented for this module):
//   - 'shadow-low-similarity': shadowTest.js, when a shadow comparison's
//     similarity score falls below FINOPS_SHADOW_FLAG_SIMILARITY_THRESHOLD.
//   - 'high-retry-rate': anomaly.js's checkRetryRateAnomaly (A5), when an
//     agent's retry rate trips that anomaly.
//   - 'thumbs-down' is NOT wired up: there is no thumbs-down/response-
//     rating feature anywhere in this codebase to hook into (checked
//     before building this - see the A8 prompt's own "if such a signal
//     already exists" caveat). Left as a defined, valid source value so a
//     future thumbs-down feature can start writing here without a schema
//     change, but nothing produces it today.

const defaultDb = require("./storage");

const SOURCES = ["shadow-low-similarity", "thumbs-down", "high-retry-rate"];

async function captureFlaggedTestCase({ source, provider = null, model = null, prompt = null, response = null, reason, raw = null, db = defaultDb }) {
  if (!SOURCES.includes(source)) {
    throw new Error(`Unknown flagged-test-case source '${source}' - must be one of: ${SOURCES.join(", ")}`);
  }
  await db.run(
    `INSERT INTO flagged_test_cases (source, provider, model, prompt, response, reason, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [source, provider, model, prompt, response, reason, raw ? JSON.stringify(raw) : null]
  );
}

async function listFlaggedTestCases({ limit = 100, source, db = defaultDb } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (source) {
    return db.all("SELECT * FROM flagged_test_cases WHERE source = ? ORDER BY id DESC LIMIT ?", [source, capped]);
  }
  return db.all("SELECT * FROM flagged_test_cases ORDER BY id DESC LIMIT ?", [capped]);
}

module.exports = { captureFlaggedTestCase, listFlaggedTestCases, SOURCES };
