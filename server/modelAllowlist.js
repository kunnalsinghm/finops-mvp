// modelAllowlist.js - restrict specific teams/keys to a pre-approved list of
// models (e.g. "this key can only use gpt-4o-mini"). Enforced in the proxy
// only - see routes/proxy.js.
//
// DESIGN DECISIONS:
//   - Mirrors budgets.js's scope_type/scope_value pattern for consistency:
//     'key' scoped to an API key_id, 'team' scoped to a team name.
//   - Off by default per scope: a key/team with ZERO allow-list rows is
//     completely unrestricted - this is an opt-in allow-list, not a
//     default-deny system. You only get restricted once someone explicitly
//     adds at least one entry for your key or team.
//   - Most-specific-wins: if the calling key has ANY entries of its own,
//     ONLY the key-level list is enforced (team-level entries are ignored
//     for that call). If the key has no entries but its team does, the
//     team-level list is enforced instead. This keeps the mental model
//     simple - exactly one list ever applies to a given call, never a
//     union/intersection of two - at the cost of not supporting "team
//     default + per-key exceptions" as a single combined list. If you need
//     that, add the team's allowed models to each key's own list too.
//   - Enforced ONLY in the proxy, not ingest - ingest just records usage
//     that already happened elsewhere; it never invokes a model, so there's
//     nothing to "allow" or "deny" there. Blocking ingest of an already-
//     incurred cost wouldn't undo the spend, only hide it from the dashboard.

const db = require("./db");

function getEntriesForScope(scopeType, scopeValue) {
  if (!scopeValue) return [];
  return db
    .prepare("SELECT provider, model FROM model_allowlist WHERE scope_type = ? AND scope_value = ?")
    .all(scopeType, scopeValue);
}

// Returns { allowed, scope, allowedModels }. scope is which list (if any)
// was actually enforced - 'key', 'team', or null (neither scope had any
// entries, so the call was unrestricted) - useful for a clear error message.
function checkModelAllowed({ keyId, team, provider, model }) {
  const keyEntries = getEntriesForScope("key", keyId);
  if (keyEntries.length > 0) {
    const allowed = keyEntries.some((e) => e.provider === provider && e.model === model);
    return { allowed, scope: "key", allowedModels: keyEntries };
  }

  const teamEntries = getEntriesForScope("team", team);
  if (teamEntries.length > 0) {
    const allowed = teamEntries.some((e) => e.provider === provider && e.model === model);
    return { allowed, scope: "team", allowedModels: teamEntries };
  }

  return { allowed: true, scope: null, allowedModels: [] };
}

function addAllowlistEntry({ scope_type, scope_value, provider, model }) {
  const info = db
    .prepare("INSERT INTO model_allowlist (scope_type, scope_value, provider, model) VALUES (?, ?, ?, ?)")
    .run(scope_type, scope_value, provider, model);
  return info.lastInsertRowid;
}

function removeAllowlistEntry(id) {
  const info = db.prepare("DELETE FROM model_allowlist WHERE id = ?").run(id);
  return info.changes > 0;
}

function listAllowlistEntries({ scope_type, scope_value } = {}) {
  if (scope_type && scope_value) {
    return db
      .prepare("SELECT * FROM model_allowlist WHERE scope_type = ? AND scope_value = ? ORDER BY id DESC")
      .all(scope_type, scope_value);
  }
  return db.prepare("SELECT * FROM model_allowlist ORDER BY id DESC").all();
}

module.exports = { checkModelAllowed, addAllowlistEntry, removeAllowlistEntry, listAllowlistEntries };
