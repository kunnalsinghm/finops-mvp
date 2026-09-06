// tokenQuota.js - cap raw input+output TOKEN consumption (not request
// count, not dollar cost) per key/team over a daily or weekly calendar
// window. Enforced in the proxy only - see routes/proxy.js.
//
// DESIGN DECISIONS:
//   - Distinct from rate limiting (governance.js, counts REQUESTS) and
//     budgets (budgets.js, counts DOLLARS) - this counts raw tokens, which
//     lets you cap consumption independent of which model was used or how
//     many separate calls it took to get there.
//   - Mirrors modelAllowlist.js's scope_type/scope_value pattern and
//     most-specific-wins precedence: a key with its own quota row(s) is
//     governed ONLY by those, ignoring its team's quota entirely.
//   - Off by default per scope - a key/team with zero quota rows is
//     completely unrestricted.
//   - A key/team can have BOTH a daily and a weekly quota simultaneously
//     (two separate rows, enforced by the UNIQUE(scope_type, scope_value,
//     period) constraint allowing one row per period); exceeding EITHER
//     blocks the request.
//   - Enforced ONLY in the proxy, not ingest - same reasoning as
//     modelAllowlist.js: ingest records usage that already happened
//     elsewhere, so blocking it there wouldn't prevent any consumption,
//     only hide it from the dashboard.
//   - KNOWN TRADEOFF, documented rather than hidden: checked BEFORE the
//     call, using consumption SO FAR (not including this request, since
//     we don't know its token cost until the response comes back). This
//     means the specific request that crosses the threshold is still let
//     through - only the NEXT request after that gets blocked. A true
//     hard-stop mid-request isn't possible without knowing token cost in
//     advance, which no provider exposes before generating the response.
//   - Periods are CALENDAR boundaries (today / this calendar week), the
//     same convention budgets.js already uses for "this month" - not a
//     rolling 24h/7d window.

const db = require("./db");

function periodClause(period) {
  if (period === "daily") return `date(event_time) = date('now')`;
  if (period === "weekly") return `strftime('%Y-%W', event_time) = strftime('%Y-%W', 'now')`;
  throw new Error(`Unknown period '${period}'`);
}

function getQuotaRows(scopeType, scopeValue) {
  if (!scopeValue) return [];
  return db.prepare("SELECT * FROM token_quotas WHERE scope_type = ? AND scope_value = ?").all(scopeType, scopeValue);
}

function tokensUsedInPeriod(column, scopeValue, period) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
       FROM usage_events
       WHERE ${column} = ? AND ${periodClause(period)}`
    )
    .get(scopeValue);
  return row.total;
}

// Returns { allowed, scope, violations }. scope is 'key', 'team', or null
// (unrestricted). violations lists every exceeded period with its limit
// and actual usage, so a block response/audit entry shows the full picture.
function checkTokenQuota({ keyId, team }) {
  const keyRows = getQuotaRows("key", keyId);
  const scope = keyRows.length > 0 ? "key" : null;
  const rows = keyRows.length > 0 ? keyRows : getQuotaRows("team", team);
  const resolvedScope = scope || (rows.length > 0 ? "team" : null);

  if (rows.length === 0) return { allowed: true, scope: null, violations: [] };

  const scopeColumn = resolvedScope === "key" ? "user_id" : "team";
  const scopeValue = resolvedScope === "key" ? keyId : team;

  const violations = [];
  for (const row of rows) {
    const used = tokensUsedInPeriod(scopeColumn, scopeValue, row.period);
    if (used >= row.token_limit) {
      violations.push({ period: row.period, limit: row.token_limit, used });
    }
  }

  return { allowed: violations.length === 0, scope: resolvedScope, violations };
}

function addQuota({ scope_type, scope_value, period, token_limit }) {
  const info = db
    .prepare("INSERT INTO token_quotas (scope_type, scope_value, period, token_limit) VALUES (?, ?, ?, ?)")
    .run(scope_type, scope_value, period, token_limit);
  return info.lastInsertRowid;
}

function removeQuota(id) {
  const info = db.prepare("DELETE FROM token_quotas WHERE id = ?").run(id);
  return info.changes > 0;
}

function listQuotas({ scope_type, scope_value } = {}) {
  if (scope_type && scope_value) {
    return db
      .prepare("SELECT * FROM token_quotas WHERE scope_type = ? AND scope_value = ? ORDER BY id DESC")
      .all(scope_type, scope_value);
  }
  return db.prepare("SELECT * FROM token_quotas ORDER BY id DESC").all();
}

module.exports = { checkTokenQuota, addQuota, removeQuota, listQuotas };
