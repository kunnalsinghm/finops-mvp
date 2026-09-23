// commitments.js - tracks prepaid credit balances (e.g. an annual OpenAI/
// Anthropic credit commitment) against actual measured burn, so a customer
// finds out their credits are about to run out from an alert, not from a
// declined request in production.
//
// Burn is computed directly from usage_events (SUM(cost_usd) for that
// provider, since starts_at) rather than kept as a separately-updated
// counter - this is the same "derive from the source of truth" approach
// budgets.js/alerts.js already use for monthly spend, and it means burn is
// always consistent with the dashboard's own cost numbers, never a second
// number that can drift out of sync with them.
//
// Alert tiers mirror budgets.js's shape (progressive thresholds, fire-once
// via a dedicated *_alert_state table) but are phrased in terms of REMAINING
// balance, not spend-so-far, since "your prepaid balance is running low" is
// the framing that matters here - 80% burned and 20% remaining are the same
// number, but only one of those is the sentence a customer wants to see.

const defaultDb = require("./storage");
const logger = require("./logger");
const { deliverAlert } = require("./alertDelivery");

const REMAINING_TIERS = [
  { tier: "20pct-remaining", threshold: 0.2 },
  { tier: "10pct-remaining", threshold: 0.1 },
  { tier: "exhausted", threshold: 0 },
];

async function computeCommitmentStatus(commitment, db = defaultDb) {
  const burnRow = await db.get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS burned
     FROM usage_events
     WHERE provider = ? AND event_time >= ?`,
    [commitment.provider, commitment.starts_at]
  );
  const burned = Math.round((burnRow.burned || 0) * 10000) / 10000;
  const remaining = Math.round((commitment.initial_amount_usd - burned) * 10000) / 10000;
  const pctRemaining = commitment.initial_amount_usd > 0 ? remaining / commitment.initial_amount_usd : 0;

  let tier = "healthy";
  if (pctRemaining <= 0) tier = "exhausted";
  else if (pctRemaining <= 0.1) tier = "critical";
  else if (pctRemaining <= 0.2) tier = "low";

  return {
    ...commitment,
    burned_usd: burned,
    remaining_usd: remaining,
    pct_remaining: Math.round(pctRemaining * 1000) / 10,
    tier,
  };
}

async function listCommitmentsWithStatus(db = defaultDb) {
  const commitments = await db.all("SELECT * FROM commitments ORDER BY id DESC");
  return Promise.all(commitments.map((c) => computeCommitmentStatus(c, db)));
}

async function hasFired(commitmentId, tier, db = defaultDb) {
  const row = await db.get(
    "SELECT 1 AS found FROM commitment_alert_state WHERE commitment_id = ? AND tier = ?",
    [commitmentId, tier]
  );
  return Boolean(row);
}

async function markFired(commitmentId, tier, db = defaultDb) {
  const already = await hasFired(commitmentId, tier, db);
  if (already) return;
  await db.run("INSERT INTO commitment_alert_state (commitment_id, tier) VALUES (?, ?)", [commitmentId, tier]);
}

// Call periodically (same cadence as checkBudgetAlerts/checkBurnRate) to
// fire remaining-balance alerts exactly once per tier per commitment - not
// once per month like budget alerts, since a prepaid commitment doesn't
// reset on a monthly cycle the way a budget does.
//
// `db` defaults to the single global database (single-tenant mode); in
// multi-tenant mode tenantJobs.js calls this once per active tenant with
// that tenant's own db.
async function checkCommitmentAlerts(db = defaultDb) {
  const commitments = await db.all("SELECT * FROM commitments");

  for (const c of commitments) {
    const status = await computeCommitmentStatus(c, db);
    const pctRemainingFraction = status.pct_remaining / 100;

    for (const { tier, threshold } of REMAINING_TIERS) {
      if (pctRemainingFraction > threshold) continue;
      const already = await hasFired(c.id, tier, db);
      if (already) continue;
      try {
        await deliverAlert(
          `:money_with_wings: Commitment alert - *${c.label}* (${c.provider}) has $${status.remaining_usd.toFixed(2)} of its $${c.initial_amount_usd.toFixed(2)} prepaid balance left (${status.pct_remaining}% remaining).`,
          "commitment",
          db
        );
        await markFired(c.id, tier, db);
      } catch (err) {
        logger.error("Commitment alert delivery failed - will retry on next check", {
          commitmentId: c.id,
          tier,
          error: err.message,
        });
      }
    }
  }
}

module.exports = { computeCommitmentStatus, listCommitmentsWithStatus, checkCommitmentAlerts };
