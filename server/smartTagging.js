// smartTagging.js - for an event that arrives with no team at all, infer a
// likely team instead of dumping it into an undifferentiated "Untagged"
// bucket with zero further signal.
//
// CURRENT BASIS: this key's own tagging history. If a given API key has
// consistently been used by one team in the past, an untagged event from
// that same key is very likely from that same team. This is a real,
// genuinely useful signal - most API keys in practice belong to one
// service/team, even if a given call forgot to set the header.
//
// NOT YET IMPLEMENTED: the product plan also mentions inferring from
// calling-service/time-of-day/prompt-template-fingerprint patterns. Those
// need either richer request metadata than currently exists on ingest, or
// a genuine clustering/fingerprinting pass over prompt content - both real
// future work, not implemented here. Being upfront about this rather than
// quietly only covering the key-history case: a confidence score is only
// trustworthy if its basis is honestly documented, so `basis` is always
// returned alongside `confidence`, not just a bare number.
//
// The inference is stored SEPARATELY from the event's real `team` column
// (see the tag_inferences table) and NEVER written back automatically -
// conflating an inference with a real tag would be exactly the kind of
// silent-guess-as-fact behavior that erodes trust in every other feature
// in this codebase. It only becomes a real tag if a human confirms it via
// POST /api/tags/:usageEventId/correct.

const defaultDb = require("./storage");

const MIN_HISTORY_FOR_INFERENCE = 3;
const MIN_MAJORITY_FRACTION = 0.6;

async function inferTag({ key_id, usage_event_id, db = defaultDb }) {
  const teamCounts = await db.all(
    `SELECT team, COUNT(*) AS n
     FROM usage_events
     WHERE user_id = ? AND team IS NOT NULL
     GROUP BY team
     ORDER BY n DESC`,
    [key_id]
  );

  const totalTagged = teamCounts.reduce((sum, r) => sum + Number(r.n), 0);

  let inferredTeam = null;
  let confidence = 0;
  let basis = "insufficient-history";

  if (totalTagged >= MIN_HISTORY_FOR_INFERENCE && teamCounts.length > 0) {
    const top = teamCounts[0];
    const fraction = Number(top.n) / totalTagged;
    if (fraction >= MIN_MAJORITY_FRACTION) {
      inferredTeam = top.team;
      confidence = Math.round(fraction * 1000) / 1000;
      basis = "key-history";
    } else {
      basis = "key-history-inconclusive";
    }
  }

  await db.run(
    `INSERT INTO tag_inferences (usage_event_id, inferred_team, confidence, basis) VALUES (?, ?, ?, ?)`,
    [usage_event_id, inferredTeam, confidence, basis]
  );

  return { usage_event_id, inferred_team: inferredTeam, confidence, basis };
}

async function listInferences({ onlyUncorrected = false, db = defaultDb } = {}) {
  const where = onlyUncorrected ? "WHERE ti.corrected_team IS NULL" : "";
  return db.all(
    `SELECT ti.*, ue.provider, ue.model, ue.cost_usd, ue.event_time, ue.user_id
     FROM tag_inferences ti
     JOIN usage_events ue ON ue.id = ti.usage_event_id
     ${where}
     ORDER BY ti.usage_event_id DESC`
  );
}

// Applying a correction does two things: records the feedback (for
// auditability - "who confirmed/corrected what, and to what"), AND
// actually updates the underlying event's real team, so the correction is
// immediately useful rather than being feedback that sits inert. tagged
// stays governed by the existing team+environment rule elsewhere in the
// codebase - correcting team alone doesn't force tagged=1 if environment
// is still missing.
async function correctTag(usageEventId, correctedTeam, db = defaultDb) {
  const existing = await db.get("SELECT * FROM tag_inferences WHERE usage_event_id = ?", [usageEventId]);
  if (!existing) {
    throw Object.assign(new Error(`No inference exists for usage_event_id ${usageEventId}`), { code: "NOT_FOUND" });
  }

  await db.run("UPDATE tag_inferences SET corrected_team = ? WHERE usage_event_id = ?", [correctedTeam, usageEventId]);

  const event = await db.get("SELECT environment FROM usage_events WHERE id = ?", [usageEventId]);
  const nowTagged = Boolean(correctedTeam && event?.environment);
  await db.run("UPDATE usage_events SET team = ?, tagged = ? WHERE id = ?", [correctedTeam, nowTagged ? 1 : 0, usageEventId]);

  return { usage_event_id: usageEventId, corrected_team: correctedTeam, tagged: nowTagged };
}

module.exports = { inferTag, listInferences, correctTag, MIN_HISTORY_FOR_INFERENCE, MIN_MAJORITY_FRACTION };
