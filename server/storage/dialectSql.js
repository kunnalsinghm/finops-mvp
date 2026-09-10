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

module.exports = {
  sinceDaysAgo,
  yearMonthExpr,
  dayFloorExpr,
  todayClause,
  thisWeekClause,
  thisMonthClause,
  nowExpr,
};
