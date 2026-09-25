// toolCallDenylist.js - a deny-list of tool_name/target patterns an
// orchestrator can check BEFORE it lets an agent act (see
// checkToolCallPreflight in toolCallGovernance.js and
// POST /api/tool-calls/check). This is the actual "deny-lists" leg of the
// spec's "deny-lists, human approval gates, post-action review" ambition -
// the other two legs are the pending-approval queue (also in
// toolCallGovernance.js) and the pre-existing post-hoc logToolCall/
// tool_calls audit log, respectively.
//
// DESIGN DECISIONS - mirrors modelAllowlist.js's scope_type/scope_value
// pattern deliberately, but with INVERTED default semantics:
//   - modelAllowlist is default-DENY once a scope has any entries (an
//     allow-list). tool_call_denylist is default-ALLOW regardless of how
//     many entries exist for OTHER tool_names/targets (a deny-list) - an
//     empty or non-matching list means nothing is denied. Matching an
//     entry is what denies a call, not merely having entries at all.
//   - Same most-specific-wins scope resolution as modelAllowlist though:
//     if the calling key has ANY denylist entries of its own, only those
//     are checked (team-level entries are ignored for that call). Falls
//     back to team-level only when the key has none. This keeps "exactly
//     one list is ever checked" as the mental model in both modules.
//   - tool_name may be the literal string '*' to mean "any tool" (e.g. a
//     scope_value that should never be allowed to touch anything matching
//     a target pattern, regardless of which specific tool is used).
//   - target_pattern is nullable (matches ANY target for that tool_name)
//     and, when present, is matched as a case-insensitive SUBSTRING
//     against the reported target - not a real regex engine. Same
//     deliberate "floor, not ceiling" honesty as promptInjection.js's and
//     toolCallGovernance.js's own risky-command detection: a full regex
//     engine invites ReDoS from admin-authored patterns for a feature
//     that's meant to block a handful of known-dangerous paths/hosts, not
//     serve as a general security boundary.

const defaultDb = require("./storage");

async function getEntriesForScope(scopeType, scopeValue, db = defaultDb) {
  if (!scopeValue) return [];
  return db.all(
    "SELECT tool_name, target_pattern, reason FROM tool_call_denylist WHERE scope_type = ? AND scope_value = ?",
    [scopeType, scopeValue]
  );
}

function entryMatches(entry, tool_name, target) {
  if (entry.tool_name !== "*" && entry.tool_name !== tool_name) return false;
  if (!entry.target_pattern) return true; // any target matches
  if (!target) return false; // entry requires a target pattern match, but none was given
  return target.toLowerCase().includes(entry.target_pattern.toLowerCase());
}

// Returns { denied, scope, reason, matchedEntry }. scope is which list (if
// any) was actually consulted - 'key', 'team', or null (neither scope had
// any entries at all, so nothing could have matched).
async function checkToolCallDenied({ keyId, team, tool_name, target, db = defaultDb }) {
  const keyEntries = await getEntriesForScope("key", keyId, db);
  if (keyEntries.length > 0) {
    const matched = keyEntries.find((e) => entryMatches(e, tool_name, target));
    return { denied: Boolean(matched), scope: "key", matchedEntry: matched || null };
  }

  const teamEntries = await getEntriesForScope("team", team, db);
  if (teamEntries.length > 0) {
    const matched = teamEntries.find((e) => entryMatches(e, tool_name, target));
    return { denied: Boolean(matched), scope: "team", matchedEntry: matched || null };
  }

  return { denied: false, scope: null, matchedEntry: null };
}

async function addDenylistEntry({ scope_type, scope_value, tool_name, target_pattern = null, reason = null, db = defaultDb }) {
  const result = await db.run(
    "INSERT INTO tool_call_denylist (scope_type, scope_value, tool_name, target_pattern, reason) VALUES (?, ?, ?, ?, ?) RETURNING id",
    [scope_type, scope_value, tool_name, target_pattern, reason]
  );
  return result.lastInsertRowid;
}

async function removeDenylistEntry(id, db = defaultDb) {
  const result = await db.run("DELETE FROM tool_call_denylist WHERE id = ?", [id]);
  return result.changes > 0;
}

async function listDenylistEntries({ scope_type, scope_value, db = defaultDb } = {}) {
  if (scope_type && scope_value) {
    return db.all("SELECT * FROM tool_call_denylist WHERE scope_type = ? AND scope_value = ? ORDER BY id DESC", [
      scope_type,
      scope_value,
    ]);
  }
  return db.all("SELECT * FROM tool_call_denylist ORDER BY id DESC");
}

module.exports = { checkToolCallDenied, addDenylistEntry, removeDenylistEntry, listDenylistEntries };
