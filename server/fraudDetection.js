// fraudDetection.js - flags usage-pattern shifts on an API key that suggest
// it may be compromised or leaked: a sudden volume spike, a brand-new
// provider/model combo appearing on an otherwise-established key, or a
// request claiming a client region the key has never used before.
//
// A6 UPDATE: no longer flag-only. A SINGLE signal is still noisy on its own
// (a real customer genuinely trying a new model for the first time looks
// identical to a leaked key trying a new model), so one signal alone still
// only produces an alert plus a "rotation recommended" advisory on the key -
// a softer nudge, not a lockout. But when MULTIPLE independent signals fire
// on the SAME key for the SAME request (e.g. a volume spike AND a brand-new
// model AND a brand-new region, all at once), the combination is a much
// stronger indicator that this isn't a legitimate usage-pattern shift, and
// this module now quarantines the key automatically rather than waiting for
// an admin to notice the alert. The threshold is configurable via
// FINOPS_FRAUD_AUTO_QUARANTINE_MIN_SIGNALS (default 2) precisely because
// "how many independent signals is enough" is a judgment call a deployment
// might reasonably want to tune - a 24/7 agent workload legitimately hitting
// new models/regions often might want this raised; a deployment with tightly
// scoped, predictable keys might want it lowered to 1.
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
const { quarantineKey, isQuarantined } = require("./governance");
const { logAudit } = require("./audit");
const { deliverAlert } = require("./alertDelivery");

// How many independent fraud signals firing together on the SAME event are
// required before this module quarantines the key itself, rather than only
// alerting. Read at call time (not module load time) so tests can override
// it via process.env without needing to reload the module.
function autoQuarantineMinSignals() {
  const raw = Number(process.env.FINOPS_FRAUD_AUTO_QUARANTINE_MIN_SIGNALS);
  return Number.isInteger(raw) && raw >= 1 ? raw : 2;
}

// The actor recorded on audit_log for anything this module does on its own,
// never a human key_id - lets an admin reading the audit trail immediately
// tell "the system did this automatically" apart from "an admin clicked
// quarantine". See routes/keys.js's POST /:keyId/quarantine for the manual
// equivalent, which logs the calling admin's own key_id as the actor.
const SYSTEM_ACTOR = "system:fraud-detection";

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

// Sets the softer "rotation recommended" advisory on a key - distinct from
// quarantine (immediate, restrictive; see governance.quarantineKey). This is
// additive/idempotent: re-flagging an already rotation-recommended key just
// refreshes the reason text with the latest signal, it never errors or
// double-writes anything unbounded (unlike quarantine there's no "already
// happened, skip" guard needed - overwriting the reason with the most recent
// trigger is exactly the intended behavior, so an admin sees why it's STILL
// flagged, not just why it first was).
async function recommendRotation(keyId, reason, controlPlaneDb) {
  await controlPlaneDb.run(
    "UPDATE api_keys SET rotation_recommended = 1, rotation_reason = ? WHERE key_id = ?",
    [reason, keyId]
  );
}

// Call once per ingest/proxy request, BEFORE the event is inserted (same
// ordering reason as anomaly.js: the event being checked shouldn't already
// be part of the history it's being compared against).
//
// controlPlaneDb defaults to `db` (single-tenant mode: same database, no
// real control-plane split - matches auth.js's own req.controlPlaneDb = db
// convention) but callers in multi-tenant mode MUST pass req.controlPlaneDb
// explicitly, since api_keys lives in the shared control-plane schema while
// alerts_log/audit_log live in the tenant's own schema - see routes/ingest.js
// and routes/proxy.js call sites.
async function checkKeyFraudSignals({ key_id, provider, model, client_region, db = defaultDb, controlPlaneDb = db }) {
  if (!key_id) return null;

  const [volume, modelMix, region] = await Promise.all([
    checkVolumeSpike(key_id, db),
    checkNewModelMix(key_id, provider, model, db),
    checkNewRegion(key_id, client_region, db),
  ]);

  const reasons = [volume, modelMix, region].filter(Boolean);
  if (reasons.length === 0) return null;

  const reasonSummary = reasons.map((r) => r.detail).join("; ");
  const minSignals = autoQuarantineMinSignals();

  if (reasons.length >= minSignals) {
    // Multiple independent signals at once - strong enough evidence to act
    // on automatically. Never double-quarantine an already-quarantined key
    // (e.g. a second request landing in the same window an earlier one was
    // already handled in, or a key an admin already quarantined manually).
    const already = await isQuarantined(key_id, controlPlaneDb);
    if (already) {
      const message = `Fraud signal on key '${key_id}' (already quarantined, no action taken): ${reasonSummary}.`;
      await deliverAlert(message, "fraud-signal", db);
      return { flagged: true, reasons: reasons.map((r) => r.type), message, action: "already-quarantined" };
    }

    const reason = `auto-quarantined by fraud detection (${reasons.length} concurrent signals): ${reasonSummary}`;
    // quarantineKey() writes its own local alerts_log row ("quarantine"
    // type) as part of what it always does, manual or automated - that's
    // the durable "this key's status changed" record. The deliverAlert()
    // call right after is deliberately separate and DOES duplicate a local
    // log row (type "fraud-auto-quarantine"): quarantineKey has no concept
    // of fanning out to Slack/webhook/email, and this module's job is to
    // make sure "the system did something to your key" actually reaches a
    // human, not just a database row nobody's watching. Two related rows
    // in alerts_log for one action is an acceptable trade for that.
    await quarantineKey(key_id, reason, controlPlaneDb, db);
    await logAudit(SYSTEM_ACTOR, "key.auto_quarantine", key_id, { reasons: reasons.map((r) => r.type), detail: reasonSummary }, db);
    const message = `Key '${key_id}' was AUTOMATICALLY QUARANTINED: ${reasonSummary}. Review at GET /api/alerts and GET /api/audit, then POST /api/keys/:id/approve if this was a false positive.`;
    await deliverAlert(message, "fraud-auto-quarantine", db);
    return { flagged: true, reasons: reasons.map((r) => r.type), message, action: "auto-quarantined" };
  }

  // Below the auto-quarantine threshold - too weak to act on alone, but
  // still worth a soft advisory so an admin sees it on the key itself
  // (GET /api/keys), not just buried in the alert log.
  const reason = `rotation recommended by fraud detection: ${reasonSummary}`;
  await recommendRotation(key_id, reason, controlPlaneDb);
  await logAudit(SYSTEM_ACTOR, "key.rotation_recommended", key_id, { reasons: reasons.map((r) => r.type), detail: reasonSummary }, db);
  const message = `Fraud signal on key '${key_id}': ${reasonSummary}. Not auto-quarantined (below the ${minSignals}-signal threshold) - rotation recommended, see GET /api/keys. Quarantine manually via POST /api/keys/:id/quarantine if this looks real.`;
  await deliverAlert(message, "fraud-signal", db);

  return { flagged: true, reasons: reasons.map((r) => r.type), message, action: "rotation-recommended" };
}

module.exports = { checkKeyFraudSignals, autoQuarantineMinSignals, SYSTEM_ACTOR };
