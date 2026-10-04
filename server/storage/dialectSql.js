// storage/dialectSql.js - the actual "SQL dialect" half of Phase B.
//
// SQLite and Postgres have completely different date/string function names
// (this is exactly the "30 SQLite-specific date expressions across 15
// files" the migration plan flagged). Rather than scatter
// `if (dialect === "postgres")` branches through 15 files, every call site
// that needs one of these expressions asks this module for the correct
// fragment and inlines it into the query text.
//
// These return raw SQL text, not parameterized values - `days` is validated
// as a plain positive integer before being inlined (never passed through
// unvalidated user input in this codebase; every call site derives it via
// `Number(req.query.x) || default`, so non-numeric input already becomes a
// safe default before it reaches here). `column` is always a hardcoded
// column name from the calling code, never user input.

const { dialect } = require("./index");

function assertSafeDays(days) {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`dialectSql: days must be a non-negative integer, got ${days}`);
  }
  return days;
}

function assertSafeColumn(column) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
    throw new Error(`dialectSql: column must be a plain identifier, got ${column}`);
  }
  return column;
}

// Current time, minus N days - for "WHERE event_time >= X" style filters.
function sinceDaysAgo(days) {
  assertSafeDays(days);
  // The RHS text must exactly match the format event_time is actually
  // stored in - JS's `new Date().toISOString()`, e.g.
  // "2026-09-08T02:14:48.123Z". Postgres's own NOW()::text format uses a
  // space instead of "T" and a numeric offset instead of "Z", which breaks
  // lexicographic comparison at the boundary (a space sorts before "T", so
  // naive ::text casting silently mis-compares timestamps within the same
  // calendar day). TO_CHAR with an explicit template avoids that entirely.
  return dialect === "postgres"
    ? `TO_CHAR((NOW() AT TIME ZONE 'UTC') - INTERVAL '${days} days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `datetime('now', '-${days} days')`;
}

// Formats a timestamp column as 'YYYY-MM' - used for month-scoped budget
// aggregation (alerts.js) and similar grouping.
function yearMonthExpr(column) {
  assertSafeColumn(column);
  return dialect === "postgres" ? `TO_CHAR((${column})::timestamp, 'YYYY-MM')` : `strftime('%Y-%m', ${column})`;
}

// Floors a timestamp column to its calendar day - used for daily grouping
// (forecast.js).
function dayFloorExpr(column) {
  assertSafeColumn(column);
  // Explicitly formatted to a plain 'YYYY-MM-DD' string rather than just
  // casting to Postgres's native DATE type - the `pg` driver auto-parses a
  // DATE column into a JS Date object, while SQLite always returns a plain
  // string. Leaving that inconsistent would mean identical-looking code
  // behaves differently per backend for anything that treats the result as
  // a string (grouping keys, JSON serialization, chart labels, etc).
  return dialect === "postgres" ? `TO_CHAR((${column})::timestamp, 'YYYY-MM-DD')` : `date(${column})`;
}

// Whether a timestamp column falls on today's calendar date (UTC) - used
// for daily-period boundaries (tokenQuota.js, costs.js summary). Same
// date-only string comparison approach as dayFloorExpr, so both sides of
// the equality format identically regardless of backend.
function todayClause(column) {
  assertSafeColumn(column);
  return dialect === "postgres"
    ? `TO_CHAR((${column})::timestamp, 'YYYY-MM-DD') = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
    : `date(${column}) = date('now')`;
}

// Whether a timestamp column falls in the current calendar week - used for
// weekly-period boundaries (tokenQuota.js).
// NOTE: SQLite's strftime('%W') (Monday-start week-of-year, 00-53) and
// Postgres's IYYY-IW (ISO week, Monday-start, 01-53) can disagree by one
// week in rare year-boundary edge cases. That's acceptable here - this only
// needs to be internally consistent within whichever single backend is
// actually running, not byte-identical across backends, since a deployment
// only ever runs one at a time.
function thisWeekClause(column) {
  assertSafeColumn(column);
  return dialect === "postgres"
    ? `TO_CHAR((${column})::timestamp, 'IYYY-IW') = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'IYYY-IW')`
    : `strftime('%Y-%W', ${column}) = strftime('%Y-%W', 'now')`;
}

// Whether a timestamp column falls in the current calendar month - used for
// monthly budget status (budgets.js) and budget alert aggregation
// (alerts.js's month-scoped SUM). Same YYYY-MM formatting as yearMonthExpr,
// just applied to both sides of an equality instead of used as a GROUP BY
// key, so this and yearMonthExpr intentionally share the same date format.
function thisMonthClause(column) {
  assertSafeColumn(column);
  return dialect === "postgres"
    ? `TO_CHAR((${column})::timestamp, 'YYYY-MM') = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')`
    : `strftime('%Y-%m', ${column}) = strftime('%Y-%m', 'now')`;
}

// Current timestamp - used as a column default in a handful of places where
// the schema itself needs it inline rather than via DEFAULT (rare; most
// defaults are handled directly in the per-dialect schema files instead).
function nowExpr() {
  return dialect === "postgres" ? "NOW()" : "datetime('now')";
}

// Start of the current UTC calendar day, and start of the next one - a
// SARGABLE alternative to todayClause() for the specific hot-path queries
// that need it (anomaly.js's per-team check, fraudDetection.js's per-key
// check - both run on every proxied/ingested request). todayClause()
// wraps the COLUMN in a function (date(event_time) = date('now')), which
// means a database can't use a range scan on any index over that column at
// all - it has to visit every row matching the rest of the WHERE clause
// and evaluate the function on each one. event_time >= startOfTodayExpr()
// AND event_time < startOfTomorrowExpr() is a plain range comparison on
// the raw column, so a composite index with event_time as a trailing
// column (idx_usage_team_time, idx_usage_user_time) can bound the scan to
// just today's slice instead of the whole match set.
//
// Deliberately NOT a replacement for todayClause() itself, which stays
// exactly as-is and is still used by every one of its other ~10 callers
// (costs.js, tokenQuota.js, ...) - rewriting every "is this today" check
// in the codebase to this shape is a separately-scoped change (see
// docs/load-test-results.md); this pair exists for the two call sites
// actually proven to need it.
function startOfTodayExpr() {
  return dialect === "postgres"
    ? `TO_CHAR(date_trunc('day', NOW() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `datetime('now', 'start of day')`;
}

function startOfTomorrowExpr() {
  return dialect === "postgres"
    ? `TO_CHAR(date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `datetime('now', 'start of day', '+1 day')`;
}

// [start, end) boundaries of the current UTC calendar month, as plain
// timestamp VALUES rather than a SQL expression - the monthly counterpart
// to startOfTodayExpr/startOfTomorrowExpr above, for the same reason:
// yearMonthExpr()/thisMonthClause() wrap the COLUMN in a function
// (strftime('%Y-%m', event_time) = ? / TO_CHAR(...) = ...), which a
// database can't use any index's event_time column to bound at all - every
// row matching the rest of the WHERE clause gets visited and the function
// evaluated on each one. event_time >= start AND event_time < end is a
// plain range comparison, so a composite index with event_time trailing
// (idx_usage_team_time, idx_usage_time) can narrow the scan to this
// month's rows instead of the whole match set's entire history.
//
// Measured on a 100k-row/6-month single-team dataset: the function-wrapped
// form cost ~40 ms/call; this form, ~13.6 ms/call (query plan confirms an
// index range scan bounded by both the team and the month, not just the
// team). Used by every PER-REQUEST monthly check (routes/proxy.js's budget
// circuit-breaker, tenantQuota.js's monthly event quota) - the two call
// sites that run on every proxied/ingested request, so their cost is
// customer-facing latency, not just background-job runtime. Also used by
// alerts.js's checkBudgetAlerts/checkBurnRate (scheduled, not per-request)
// and routes/budgets.js's GET /status (a human dashboard read) for the
// same reason and consistency, even though those two are lower urgency.
//
// Deliberately a plain JS function returning two parameter VALUES, not a
// dialect-branching SQL-expression string like yearMonthExpr() - a plain
// `>=`/`<` range needs no dialect-specific SQL at all, so there's nothing
// for sqlite vs postgres to differ on here.
function currentMonthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { start, end };
}

module.exports = {
  sinceDaysAgo,
  yearMonthExpr,
  dayFloorExpr,
  todayClause,
  thisWeekClause,
  thisMonthClause,
  nowExpr,
  startOfTodayExpr,
  startOfTomorrowExpr,
  currentMonthBounds,
};
