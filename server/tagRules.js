// tagRules.js - declarative tagging policy ("FinOps as Code" Level 2; see
// server/routes/gitops.js for Level 1, declarative budgets).
//
// finops.yaml's `tagging_rules:` list declares tagging policy as code, the
// same way `budgets:` declares budgets as code:
//
//   tagging_rules:
//     - match: { api_key_prefix: "fk_growth_" }
//       assign: { team: growth, environment: prod }
//     - match: { api_key_prefix: "fk_growth_eu_" }
//       assign: { team: growth, environment: prod, project_id: eu-checkout }
//
// Rules are synced into the tag_rules table by the SAME POST /api/gitops/sync
// pass that syncs budgets - one file, one sync, one drift-removal pass -
// not a separate endpoint (see syncTagRulesFromDoc in gitops.js).
//
// ASSIGNABLE FIELDS: team, environment, project_id, cost_center,
// customer_id, feature_id - the tag dimensions that describe WHO a key
// belongs to. Deliberately excludes git_branch/agent_id/session_id/task_id/
// task_status/workload_type: those describe a single CALL, not a key, so a
// static per-key rule can't meaningfully assign them (a key doesn't have
// "one git branch").
//
// MATCHING: longest-prefix-match wins when more than one rule's prefix
// matches the same key (e.g. "fk_growth_" and "fk_growth_eu_" both match
// "fk_growth_eu_007") - the same "most specific wins" convention as CIDR
// routing, so a team can set a broad default and a narrower override
// without the two rules being order-dependent or ambiguous.
//
// PRECEDENCE for a given field, weakest to strongest (each later one wins):
//   1. smart/inferred tagging - a statistical guess, and it's never even
//      written to the real column automatically (see smartTagging.js)
//   2. a declarative tagging rule (this file) - real policy, but still only
//      fills in a field the caller left blank
//   3. a value the caller actually sent (a body field on ingest, an X-*
//      header on the proxy) - always wins; a rule never overrides an
//      explicit value, same non-destructive posture as smart tagging's
//      "only called for genuinely untagged events"
//   4. a key bound to a team via PATCH /api/keys/:keyId (keyIdentity.js) -
//      the strongest guarantee that exists today (a mismatched X-Team is a
//      403, not silently overridden) - completely untouched by this file;
//      by the time applyTagRules runs, `team` already reflects that
//      binding if one exists, so there's nothing left to fill

const defaultDb = require("./storage");

const ASSIGNABLE_FIELDS = ["team", "environment", "project_id", "cost_center", "customer_id", "feature_id"];

// All rules for this key's exact prefixes, longest-prefix-first. A LIKE
// scan (small table, one row per declared rule - this is policy, not
// per-event data) rather than fetching every rule and filtering in JS,
// so the "does ANY rule match" case (the common one - most keys match
// nothing) doesn't need a full table read.
async function matchingRule({ key_id, db = defaultDb }) {
  if (!key_id) return null;
  const rules = await db.all(`SELECT * FROM tag_rules`);
  let best = null;
  for (const rule of rules) {
    if (rule.api_key_prefix && key_id.startsWith(rule.api_key_prefix)) {
      if (!best || rule.api_key_prefix.length > best.api_key_prefix.length) {
        best = rule;
      }
    }
  }
  return best;
}

// fields: the caller's already-resolved tag fields for this event (e.g.
// { team, environment, project_id, cost_center, customer_id, feature_id }).
// Returns a NEW object with the same shape - every field the caller left
// null/undefined/empty gets filled from the best-matching rule, if any;
// every field the caller actually supplied is returned completely
// untouched. Also returns which rule (if any) was applied, so callers can
// log/audit it without a second lookup.
async function applyTagRules({ key_id, fields, db = defaultDb }) {
  const resolved = { ...fields };
  const rule = await matchingRule({ key_id, db });
  if (!rule) return { fields: resolved, rule: null };

  for (const f of ASSIGNABLE_FIELDS) {
    if (!resolved[f] && rule[f]) {
      resolved[f] = rule[f];
    }
  }
  return { fields: resolved, rule };
}

module.exports = { applyTagRules, matchingRule, ASSIGNABLE_FIELDS };
