// fraudDetection.js - flags usage-pattern shifts on an API key that suggest
// it may be compromised or leaked: a sudden volume spike, a brand-new
// provider/model combo appearing on an otherwise-established key, or a
// request claiming a client region the key has never used before.
//
// Deliberately FLAG-ONLY, not auto-block or auto-quarantine, unlike
// anomaly.js's cost-spike check. A single-request cost anomaly is safe to
// react to immediately because the worst case of a false positive is one
// degraded/blocked request. These signals are all pattern-based and noisier
// (a real customer genuinely trying a new model for the first time looks
// identical to a leaked key trying a new model) - auto-quarantining on a
// false positive here would lock out a legitimate customer with no warning.
// An admin reviewing the alerts_log can quarantine the key themselves via
// POST /api/keys/:id/quarantine if a signal looks real.
//
// client_region is self-reported (X-Client-Region header), not a real IP
// geolocation lookup - there's no IP capture anywhere in this codebase yet.
// It's still a useful signal (a legitimate integration usually reports the
// same region call after call), but it's trivially spoofable by whoever
// already holds the key. Treat it as a weak signal, not a strong one -
// swapping in real IP-based geolocation is a natural follow-up, not part
// of this pass.

const defaultDb = require("./storage");
const { sinceDaysAgo, dayFloorExpr, todayClause } = require("./storage/dialectSql");
const { logAlert } = require("./governance");

const VOLUME_BASELINE_LOOKBACK_DAYS = 14;
const VOLUME_SPIKE_MULTIPLIER = 5;
const MIN_AVG_DAILY_REQUESTS_FOR_VOLUME_CHECK = 1; // avoid flagging a key that normally does <1/day
const MIN_HISTORY_FOR_MODEL_CHECK = 20; // key needs an established pattern before "new model" means anything
const MIN_HISTORY_FOR_REGION_CHECK = 5;

async function checkVolumeSpike(key_id, db = defaultDb) {
  const todayRow = await db.get(
    `SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND ${todayClause("event_time")}`,
    [key_id]
  );
  const todayCount = Number(todayRow?.n || 0);
  if (todayCount === 0) return null;

  const historyRow = await db.get(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT ${dayFloorExpr("event_time")}) AS days
     FROM usage_events
     WHERE user_id = ? AND event_time >= ${sinceDaysAgo(VOLUME_BASELINE_LOOKBACK_DAYS)}
       AND NOT ${todayClause("event_time")}`,
    [key_id]
  );
  const days = Number(historyRow?.days || 0);
  if (days < 3) return null; // not enough history to know what "normal" looks like

  const avgPerDay = Number(historyRow.n || 0) / days;
  if (avgPerDay < MIN_AVG_DAILY_REQUESTS_FOR_VOLUME_CHECK) return null;

  if (todayCount > avgPerDay * VOLUME_SPIKE_MULTIPLIER) {
    return {
      type: "volume-spike",
      detail: `${todayCount} requests today vs. a ${avgPerDay.toFixed(1)}/day average over the last ${days} days`,
    };
  }
  return null;
}

async function checkNewModelMix(key_id, provider, model, db = defaultDb) {
  const historyRow = await db.get("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?", [key_id]);
  if (Number(historyRow?.n || 0) < MIN_HISTORY_FOR_MODEL_CHECK) return null;

  const seenBefore = await db.get(
    "SELECT 1 AS found FROM usage_events WHERE user_id = ? AND provider = ? AND model = ? LIMIT 1",
    [key_id, provider, model]
  );
  if (seenBefore) return null;

  return { type: "new-model-mix", detail: `first-ever use of ${provider}/${model} on an established key` };
}

async function checkNewRegion(key_id, client_region, db = defaultDb) {
  if (!client_region) return null;

  const historyRow = await db.get("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?", [key_id]);
  if (Number(historyRow?.n || 0) < MIN_HISTORY_FOR_REGION_CHECK) return null;

  const seenBefore = await db.get(
    "SELECT 1 AS found FROM usage_events WHERE user_id = ? AND client_region = ? LIMIT 1",
    [key_id, client_region]
  );
  if (seenBefore) return null;

  return { type: "new-region", detail: `first request from region '${client_region}' on this key` };
}

// Call once per ingest/proxy request, BEFORE the event is inserted (same
// ordering reason as anomaly.js: the event being checked shouldn't already
// be part of the history it's being compared against).
async function checkKeyFraudSignals({ key_id, provider, model, client_region, db = defaultDb }) {
  if (!key_id) return null;

  const [volume, modelMix, region] = await Promise.all([
    checkVolumeSpike(key_id, db),
    checkNewModelMix(key_id, provider, model, db),
    checkNewRegion(key_id, client_region, db),
  ]);

  const reasons = [volume, modelMix, region].filter(Boolean);
  if (reasons.length === 0) return null;

  const message = `Fraud signal on key '${key_id}': ${reasons.map((r) => r.detail).join("; ")}. Not auto-blocked - review at GET /api/alerts and quarantine via POST /api/keys/:id/quarantine if this looks real.`;
  await logAlert("fraud-signal", message, db);

  return { flagged: true, reasons: reasons.map((r) => r.type), message };
}

module.exports = { checkKeyFraudSignals };
