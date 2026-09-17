// weeklyBriefing.js - a scheduled digest (total spend, week-over-week
// delta, top-moving teams) delivered through the same channels as budget
// alerts, on a weekly cadence rather than event-triggered.
//
// Dedup uses an ISO week key ('2026-W38') stored in weekly_briefing_state,
// checked by checkWeeklyBriefing() on the same periodic timer as budget/
// burn-rate/commitment checks (see index.js) - so a server restart mid-week
// can't cause a duplicate send, the same way budget_alert_state prevents a
// budget alert from re-firing after a restart.
//
// buildWeeklyBriefing() is exported separately from sendWeeklyBriefing() so
// the dashboard can show a live preview (GET /api/reports/weekly/preview)
// without that preview counting as an actual send.

const db = require("./storage");
const logger = require("./logger");
const { sinceDaysAgo } = require("./storage/dialectSql");
const { deliverAlert } = require("./alertDelivery");

const TOP_MOVERS_LIMIT = 3;

// ISO 8601 week number (Monday-start, week 1 = the week containing the
// year's first Thursday) - matches thisWeekClause's Postgres branch
// (TO_CHAR ... 'IYYY-IW') so this key means the same calendar week
// regardless of which storage backend is configured.
function getIsoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

async function buildWeeklyBriefing() {
  const thisWeekRow = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE event_time >= ${sinceDaysAgo(7)}`
  );
  const lastWeekRow = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events
     WHERE event_time >= ${sinceDaysAgo(14)} AND event_time < ${sinceDaysAgo(7)}`
  );

  const totalThisWeek = Math.round((thisWeekRow.total || 0) * 10000) / 10000;
  const totalLastWeek = Math.round((lastWeekRow.total || 0) * 10000) / 10000;
  const deltaPct = totalLastWeek > 0 ? Math.round(((totalThisWeek - totalLastWeek) / totalLastWeek) * 1000) / 10 : null;

  const teamRows = await db.all(
    `SELECT COALESCE(team, 'Untagged') AS team,
            SUM(CASE WHEN event_time >= ${sinceDaysAgo(7)} THEN cost_usd ELSE 0 END) AS this_week,
            SUM(CASE WHEN event_time >= ${sinceDaysAgo(14)} AND event_time < ${sinceDaysAgo(7)} THEN cost_usd ELSE 0 END) AS last_week
     FROM usage_events
     WHERE event_time >= ${sinceDaysAgo(14)}
     GROUP BY COALESCE(team, 'Untagged')`
  );

  const topMovers = teamRows
    .map((r) => ({
      team: r.team,
      this_week: Math.round((r.this_week || 0) * 10000) / 10000,
      last_week: Math.round((r.last_week || 0) * 10000) / 10000,
      delta_usd: Math.round(((r.this_week || 0) - (r.last_week || 0)) * 10000) / 10000,
    }))
    .sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd))
    .slice(0, TOP_MOVERS_LIMIT);

  return { total_this_week: totalThisWeek, total_last_week: totalLastWeek, delta_pct: deltaPct, top_movers: topMovers };
}

function formatBriefingMessage(briefing) {
  const deltaText = briefing.delta_pct === null ? "n/a (no spend last week)" : `${briefing.delta_pct > 0 ? "+" : ""}${briefing.delta_pct}%`;
  const moversText = briefing.top_movers
    .map((m) => `  - ${m.team}: $${m.this_week.toFixed(2)} (${m.delta_usd >= 0 ? "+" : ""}$${m.delta_usd.toFixed(2)} vs. last week)`)
    .join("\n");
  return (
    `:bar_chart: *Weekly FinOps Briefing*\n` +
    `Total spend this week: $${briefing.total_this_week.toFixed(2)} (${deltaText} vs. last week)\n` +
    (moversText ? `Top movers:\n${moversText}` : "No team-tagged spend to break down yet.")
  );
}

async function alreadySent(weekKey) {
  const row = await db.get("SELECT 1 AS found FROM weekly_briefing_state WHERE week_key = ?", [weekKey]);
  return Boolean(row);
}

async function sendWeeklyBriefing() {
  const briefing = await buildWeeklyBriefing();
  await deliverAlert(formatBriefingMessage(briefing), "weekly-briefing");
  return briefing;
}

// Runs on the same periodic timer as budget/burn-rate/commitment checks
// (see index.js). Fires once per ISO week, only on the first check that
// happens on or after Monday 00:00 UTC - an hourly timer means the actual
// send lands within an hour of the week rolling over, not necessarily at
// exactly midnight.
async function checkWeeklyBriefing() {
  const now = new Date();
  if (now.getUTCDay() !== 1) return; // only proceed on Mondays (UTC)

  const weekKey = getIsoWeekKey(now);
  if (await alreadySent(weekKey)) return;

  try {
    await sendWeeklyBriefing();
    await db.run("INSERT INTO weekly_briefing_state (week_key) VALUES (?)", [weekKey]);
  } catch (err) {
    logger.error("Weekly briefing delivery failed - will retry on next check", { weekKey, error: err.message });
  }
}

module.exports = { buildWeeklyBriefing, sendWeeklyBriefing, checkWeeklyBriefing, getIsoWeekKey, formatBriefingMessage };
