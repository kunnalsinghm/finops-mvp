// reconcile.js - Shadow AI / untracked spend detection via billing reconciliation
//
// True network-level shadow-AI detection (catching API calls that never
// touch our proxy at all) needs something outside a free/local tool's reach -
// browser extensions, corporate card feeds, or DNS monitoring. The practical
// free alternative: providers already let you export a billing CSV from your
// org dashboard (OpenAI: Settings > Usage > Export; Anthropic: Console >
// Billing > Export). Upload that here and we diff it against what we
// actually logged. Any gap is spend that happened OUTSIDE this platform -
// exactly the "shadow AI" signal the blueprint calls for, without needing
// any paid integration.

const db = require("./db");
const crypto = require("crypto");

const insertRow = db.prepare(`
  INSERT INTO reconciliation_rows (batch_id, day, provider, reported_cost_usd)
  VALUES (?, ?, ?, ?)
`);

const deleteExisting = db.prepare(
  `DELETE FROM reconciliation_rows WHERE day = ? AND provider = ?`
);

// Expects CSV text with header: date,provider,cost
// (date format YYYY-MM-DD; provider lowercase matching our provider names)
//
// Re-uploading a CSV that covers a day/provider you've already imported
// REPLACES those rows rather than adding to them - otherwise uploading the
// same billing period twice would double-count reported spend and create
// false shadow-spend gaps. If you need to import multiple partial exports
// for the same day (e.g. two different cost centers), sum them into a
// single row yourself before uploading.
function importCsv(csvText) {
  const batch_id = crypto.randomUUID();
  const lines = csvText.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Empty CSV");

  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const dateIdx = header.indexOf("date");
  const providerIdx = header.indexOf("provider");
  const costIdx = header.indexOf("cost");

  if (dateIdx === -1 || providerIdx === -1 || costIdx === -1) {
    throw new Error("CSV must have headers: date,provider,cost");
  }

  const parsedRows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const day = cols[dateIdx];
    const providerRaw = cols[providerIdx];
    const cost = parseFloat(cols[costIdx]);
    if (!day || !providerRaw || Number.isNaN(cost)) continue;
    const provider = providerRaw.toLowerCase();
    parsedRows.push({ day, provider, cost });
  }

  let rowCount = 0;
  let replacedCount = 0;
  const seenDayProvider = new Set();

  db.exec("BEGIN");
  try {
    for (const row of parsedRows) {
      const key = `${row.day}|${row.provider}`;
      if (!seenDayProvider.has(key)) {
        const existing = db.prepare(`SELECT COUNT(*) AS n FROM reconciliation_rows WHERE day = ? AND provider = ?`).get(row.day, row.provider);
        if (existing.n > 0) replacedCount++;
        deleteExisting.run(row.day, row.provider);
        seenDayProvider.add(key);
      }
      insertRow.run(batch_id, row.day, row.provider, row.cost);
      rowCount++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { batch_id, rowCount, replacedDayProviderPairs: replacedCount };
}

// Compare reported (billing export) vs tracked (our usage_events) per day+provider.
// Flags days where reported spend meaningfully exceeds what we tracked -
// that gap is spend we never saw, i.e. shadow usage.
function getReconciliationReport({ thresholdPct = 10 } = {}) {
  const reported = db
    .prepare(
      `SELECT day, provider, SUM(reported_cost_usd) AS reported_cost
       FROM reconciliation_rows
       GROUP BY day, provider`
    )
    .all();

  const tracked = db
    .prepare(
      `SELECT date(event_time) AS day, provider, SUM(cost_usd) AS tracked_cost
       FROM usage_events
       GROUP BY date(event_time), provider`
    )
    .all();

  const trackedMap = {};
  for (const t of tracked) trackedMap[`${t.day}|${t.provider}`] = t.tracked_cost;

  const results = reported.map((r) => {
    const trackedCost = trackedMap[`${r.day}|${r.provider}`] || 0;
    const gap = r.reported_cost - trackedCost;
    const gapPct = r.reported_cost > 0 ? (gap / r.reported_cost) * 100 : 0;
    return {
      day: r.day,
      provider: r.provider,
      reported_cost: round2(r.reported_cost),
      tracked_cost: round2(trackedCost),
      gap_usd: round2(gap),
      gap_pct: Math.round(gapPct),
      flagged: gap > 0.01 && gapPct >= thresholdPct,
    };
  });

  return results.sort((a, b) => b.gap_usd - a.gap_usd);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { importCsv, getReconciliationReport };
