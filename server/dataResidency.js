// dataResidency.js - block a request that would move data outside an
// approved region. Mirrors modelAllowlist.js's design exactly: off by
// default per scope (a key/team with zero rows is unrestricted),
// most-specific-wins (key entries, if any, are the ONLY list enforced for
// that call - team entries are only consulted when the key has none).
//
// Region here is self-reported (X-Client-Region on the proxy, or a tool
// call's declared target region) - same caveat as fraudDetection.js's
// new-region signal: this is a real, useful control for a legitimate
// integration that consistently declares where it's running, but it is
// trivially spoofable by whoever already holds the key. It is not a
// substitute for real network-level geofencing; it's a policy control for
// well-behaved clients, which is what most enterprise procurement
// requirements are actually asking for at this layer.

const defaultDb = require("./storage");

async function getEntriesForScope(scopeType, scopeValue, db = defaultDb) {
  if (!scopeValue) return [];
  return db.all("SELECT region FROM region_allowlist WHERE scope_type = ? AND scope_value = ?", [scopeType, scopeValue]);
}

async function checkRegionAllowed({ keyId, team, region, db = defaultDb }) {
  if (!region) return { allowed: true, scope: null, allowedRegions: [] };

  const keyEntries = await getEntriesForScope("key", keyId, db);
  if (keyEntries.length > 0) {
    const allowed = keyEntries.some((e) => e.region === region);
    return { allowed, scope: "key", allowedRegions: keyEntries.map((e) => e.region) };
  }

  const teamEntries = await getEntriesForScope("team", team, db);
  if (teamEntries.length > 0) {
    const allowed = teamEntries.some((e) => e.region === region);
    return { allowed, scope: "team", allowedRegions: teamEntries.map((e) => e.region) };
  }

  return { allowed: true, scope: null, allowedRegions: [] };
}

async function addRegionAllowlistEntry({ scope_type, scope_value, region, db = defaultDb }) {
  const result = await db.run(
    "INSERT INTO region_allowlist (scope_type, scope_value, region) VALUES (?, ?, ?) RETURNING id",
    [scope_type, scope_value, region]
  );
  return result.lastInsertRowid;
}

async function removeRegionAllowlistEntry(id, db = defaultDb) {
  const result = await db.run("DELETE FROM region_allowlist WHERE id = ?", [id]);
  return result.changes > 0;
}

async function listRegionAllowlistEntries({ scope_type, scope_value, db = defaultDb } = {}) {
  if (scope_type && scope_value) {
    return db.all("SELECT * FROM region_allowlist WHERE scope_type = ? AND scope_value = ? ORDER BY id DESC", [
      scope_type,
      scope_value,
    ]);
  }
  return db.all("SELECT * FROM region_allowlist ORDER BY id DESC");
}

module.exports = { checkRegionAllowed, addRegionAllowlistEntry, removeRegionAllowlistEntry, listRegionAllowlistEntries };
