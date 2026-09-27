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

const defaultDb = require("./storage");
const { dayFloorExpr } = require("./storage/dialectSql");
const crypto = require("crypto");

// Expects CSV text with header: date,provider,cost
// (date format YYYY-MM-DD; provider lowercase matching our provider names)
//
// Re-uploading a CSV that covers a day/provider you've already imported
// REPLACES those rows rather than adding to them - otherwise uploading the
// same billing period twice would double-count reported spend and create
// false shadow-spend gaps. If you need to import multiple partial exports
// for the same day (e.g. two different cost centers), sum them into a
// single row yourself before uploading.
//
// The delete-then-insert-per-row work all happens inside a single
// storage.transaction() so it's genuinely atomic on both backends - see
// storage/postgres.js's transaction() comment for why that matters.
async function importCsv(csvText, db = defaultDb) {
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

  await db.transaction(async (tx) => {
    for (const row of parsedRows) {
      const key = `${row.day}|${row.provider}`;
      if (!seenDayProvider.has(key)) {
        const existing = await tx.get(
          `SELECT COUNT(*) AS n FROM reconciliation_rows WHERE day = ? AND provider = ?`,
          [row.day, row.provider]
        );
        if (existing.n > 0) replacedCount++;
        await tx.run(`DELETE FROM reconciliation_rows WHERE day = ? AND provider = ?`, [row.day, row.provider]);
        seenDayProvider.add(key);
      }
      await tx.run(
        `INSERT INTO reconciliation_rows (batch_id, day, provider, reported_cost_usd) VALUES (?, ?, ?, ?)`,
        [batch_id, row.day, row.provider, row.cost]
      );
      rowCount++;
    }
  });

  return { batch_id, rowCount, replacedDayProviderPairs: replacedCount };
}

// A12: categorize WHY a flagged gap exists, using signals this module can
// already see (pricing markers already recorded on usage_events, and the
// shape of neighboring days in the same reported/tracked data), rather than
// inventing new instrumentation. This is a best-guess layer on TOP of the
// existing single-number gap - gap_usd/gap_pct/flagged are computed exactly
// as before, unchanged, for backward compatibility with anything already
// consuming this endpoint.
//
// Four categories, checked in this priority order (first match wins):
//
//   1. "pricing-mismatch" - some usage_events in that exact day+provider
//      window carry the unpriced/priceApproximate markers proxy.js already
//      stamps into raw_json (see buildUsageRow). If the pricing catalogue
//      didn't have a real rate for part of what was tracked, the "gap"
//      may just be under-priced tracked spend, not truly missing spend -
//      this is checked first because it's the most concrete, directly
//      verifiable signal of the four.
//   2. "timing-difference" - the same provider's immediately adjacent day
//      (the day before or after) shows an offsetting gap in the OPPOSITE
//      direction (tracked cost there exceeds what was reported), of at
//      least half this day's gap magnitude. That pattern - spend "missing"
//      on one side of a boundary and "extra" on the other - is the
//      signature of a billing-period cutoff not lining up with our own
//      UTC day boundary, not a real discrepancy.
//   3. "tracking-gap" - tracked_cost for that day+provider is effectively
//      zero (no usage was recorded at all - a spool replay failure or an
//      outage window looks exactly like this) and neither signal above
//      applies. This is the "we know usage happened but genuinely never
//      saw it" bucket the gap analysis asks for.
//   4. "unexplained" - none of the above signals apply: there's real
//      partial tracked coverage, no pricing anomaly nearby, and no
//      offsetting neighbor. The honest bucket - not a place to force a
//      guess into one of the other three.
//
// Explicitly NOT attempted: "provider invoice adjustments" (credits,
// retroactive corrections a provider applies after the fact). There is no
// data source for that in this codebase - the CSV import has no concept of
// a credit/adjustment line distinct from a plain charge, so a row like that
// would just look like a same-day cost, not a correction to some earlier
// day. Faking a heuristic for it (e.g. treating any negative gap as an
// "adjustment") would produce false positives indistinguishable from
// ordinary over-tracking. Left out on purpose; flagged here and in the
// README rather than guessed at.
function shiftDay(day, deltaDays) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function categorizeGap({ day, provider, gap, trackedCost, markerMap, reportedMap, trackedMap }) {
  if (markerMap[`${day}|${provider}`]) return "pricing-mismatch";

  for (const delta of [-1, 1]) {
    const adjDay = shiftDay(day, delta);
    const adjReported = reportedMap[`${adjDay}|${provider}`] || 0;
    const adjTracked = trackedMap[`${adjDay}|${provider}`] || 0;
    const adjGap = adjReported - adjTracked; // negative => tracked exceeded reported that day
    if (adjGap < 0 && Math.abs(adjGap) >= gap * 0.5) return "timing-difference";
  }

  if (trackedCost <= 0.01) return "tracking-gap";

  return "unexplained";
}

// Compare reported (billing export) vs tracked (our usage_events) per day+provider.
// Flags days where reported spend meaningfully exceeds what we tracked -
// that gap is spend we never saw, i.e. shadow usage.
async function getReconciliationReport({ thresholdPct = 10, db = defaultDb } = {}) {
  const reported = await db.all(
    `SELECT day, provider, SUM(reported_cost_usd) AS reported_cost
     FROM reconciliation_rows
     GROUP BY day, provider`
  );

  const tracked = await db.all(
    `SELECT ${dayFloorExpr("event_time")} AS day, provider, SUM(cost_usd) AS tracked_cost
     FROM usage_events
     GROUP BY ${dayFloorExpr("event_time")}, provider`
  );

  // Which day+provider buckets saw any pricing-approximate/unpriced tracked
  // usage - a cheap LIKE scan over raw_json rather than a real JSON column,
  // consistent with how GET /api/pricing/unpriced itself reads these
  // markers (see routes/pricing.js and proxy.js's buildUsageRow comment).
  const markerRows = await db.all(
    `SELECT ${dayFloorExpr("event_time")} AS day, provider,
       SUM(CASE WHEN raw_json LIKE '%"unpriced":true%' OR raw_json LIKE '%"priceApproximate":true%' THEN 1 ELSE 0 END) AS marker_count
     FROM usage_events
     GROUP BY ${dayFloorExpr("event_time")}, provider`
  );

  const trackedMap = {};
  for (const t of tracked) trackedMap[`${t.day}|${t.provider}`] = t.tracked_cost;

  const reportedMap = {};
  for (const r of reported) reportedMap[`${r.day}|${r.provider}`] = r.reported_cost;

  const markerMap = {};
  for (const m of markerRows) markerMap[`${m.day}|${m.provider}`] = Number(m.marker_count) > 0;

  const results = reported.map((r) => {
    const trackedCost = trackedMap[`${r.day}|${r.provider}`] || 0;
    const gap = r.reported_cost - trackedCost;
    const gapPct = r.reported_cost > 0 ? (gap / r.reported_cost) * 100 : 0;
    const flagged = gap > 0.01 && gapPct >= thresholdPct;
    return {
      day: r.day,
      provider: r.provider,
      reported_cost: round2(r.reported_cost),
      tracked_cost: round2(trackedCost),
      gap_usd: round2(gap),
      gap_pct: Math.round(gapPct),
      flagged,
      // Only flagged gaps get a best-guess category - an unflagged row has
      // no meaningful discrepancy to explain in the first place.
      category: flagged
        ? categorizeGap({ day: r.day, provider: r.provider, gap, trackedCost, markerMap, reportedMap, trackedMap })
        : null,
    };
  });

  return results.sort((a, b) => b.gap_usd - a.gap_usd);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { importCsv, getReconciliationReport };
