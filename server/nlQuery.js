// nlQuery.js - "ask your dashboard" plain-English queries, answered
// directly from ingest data.
//
// DESIGN DECISION: this is regex/keyword-based intent extraction, NOT an
// LLM call. Three reasons, stated plainly rather than left implicit:
//   1. This is a self-hosted OSS project - requiring an LLM API key just
//      to ask "what did we spend last week" would be a strange new
//      external dependency for a tool whose whole job is managing LLM
//      API cost.
//   2. The plan itself calls this "lightweight" - a small set of
//      well-known query shapes (spend by team, spend by timeframe, top
//      spenders) covers the large majority of what someone would actually
//      type into a cost dashboard's search box.
//   3. Honesty: a rule-based parser's failure mode is legible ("didn't
//      recognize that phrasing" - the user can see why and try again). An
//      LLM-based parser's failure mode is a confidently-wrong SQL query or
//      a hallucinated number, which is a much worse failure mode for a
//      FINANCIAL reporting tool specifically - the exact scenario Compass's
//      own eval-layer honesty section warns about, applied here one layer
//      up.
// This deliberately does NOT try to be a general natural-language-to-SQL
// engine. If a query doesn't match a known shape, it says so, plainly,
// rather than guessing.

const defaultDb = require("./storage");
const { sinceDaysAgo, yearMonthExpr, todayClause } = require("./storage/dialectSql");

function round4(n) {
  return Math.round((n || 0) * 10000) / 10000;
}

function extractTimeframe(text) {
  if (/\btoday\b/i.test(text)) return { label: "today", clause: todayClause("event_time") };
  if (/\blast\s+week\b/i.test(text)) return { label: "the last 7 days", clause: `event_time >= ${sinceDaysAgo(7)}` };
  if (/\blast\s+30\s+days\b/i.test(text)) return { label: "the last 30 days", clause: `event_time >= ${sinceDaysAgo(30)}` };
  if (/\bthis\s+month\b/i.test(text)) {
    const month = new Date().toISOString().slice(0, 7);
    return { label: "this month", clause: `${yearMonthExpr("event_time")} = '${month}'` };
  }
  if (/\blast\s+month\b/i.test(text)) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const month = d.toISOString().slice(0, 7);
    return { label: "last month", clause: `${yearMonthExpr("event_time")} = '${month}'` };
  }
  return { label: "all time", clause: "1=1" };
}

async function extractTeamMention(text, db = defaultDb) {
  const knownTeams = await db.all("SELECT DISTINCT team FROM usage_events WHERE team IS NOT NULL");
  const lower = text.toLowerCase();
  const match = knownTeams.find((r) => lower.includes(String(r.team).toLowerCase()));
  return match ? match.team : null;
}

async function queryDashboard(text, db = defaultDb) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return { understood: false, answer_text: "Ask something like \"what did we spend on the growth team last week\" or \"top spenders this month\"." };
  }

  const timeframe = extractTimeframe(text);
  const isTopSpenders = /\btop\s+(spenders|teams)\b|\bwho\s+spent\s+the\s+most\b/i.test(text);

  if (isTopSpenders) {
    const rows = await db.all(
      `SELECT COALESCE(team, 'Untagged') AS team, SUM(cost_usd) AS total
       FROM usage_events WHERE ${timeframe.clause}
       GROUP BY COALESCE(team, 'Untagged') ORDER BY total DESC LIMIT 5`
    );
    const data = rows.map((r) => ({ team: r.team, total_cost_usd: round4(r.total) }));
    const answerText = data.length === 0
      ? `No spend recorded for ${timeframe.label}.`
      : `Top spenders for ${timeframe.label}: ${data.map((d) => `${d.team} ($${d.total_cost_usd.toFixed(2)})`).join(", ")}.`;
    return { understood: true, intent: "top_spenders", timeframe: timeframe.label, answer_text: answerText, data };
  }

  const team = await extractTeamMention(text, db);
  const wantsSpend = /\bspend\b|\bspent\b|\bcost\b/i.test(text);

  if (wantsSpend) {
    const clause = team ? `${timeframe.clause} AND team = ?` : timeframe.clause;
    const params = team ? [team] : [];
    const row = await db.get(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE ${clause}`, params);
    const total = round4(row.total);
    const answerText = team
      ? `${team} spent $${total.toFixed(2)} in ${timeframe.label}.`
      : `Total spend for ${timeframe.label} was $${total.toFixed(2)}.`;
    return { understood: true, intent: "spend_total", team: team || null, timeframe: timeframe.label, answer_text: answerText, data: { total_cost_usd: total } };
  }

  return {
    understood: false,
    answer_text: "Didn't recognize that question. Try something like \"what did we spend on the growth team last week\" or \"top spenders this month\".",
  };
}

module.exports = { queryDashboard, extractTimeframe, extractTeamMention };
