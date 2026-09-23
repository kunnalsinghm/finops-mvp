// smartTagging.js - for an event that arrives with no team at all, infer a
// likely team instead of dumping it into an undifferentiated "Untagged"
// bucket with zero further signal.
//
// TWO SIGNALS, tried in order, both scoped to this one key's own history
// only (never another key's, and never another tenant's):
//
// 1. KEY-HISTORY (basis "key-history"): if a given API key has consistently
//    been used by one team in the past, an untagged event from that same
//    key is very likely from that same team. This is the primary signal -
//    most API keys in practice belong to one service/team, even if a given
//    call forgot to set the header.
//
// 2. TIME-OF-DAY (basis "key-history-time-of-day"), tried only when #1 is
//    inconclusive (the key's overall history is split across teams with no
//    clear majority): a key can legitimately be shared by more than one
//    team at different times - e.g. a day-shift team and a night-shift
//    team, or two services deployed with the same key that each mostly run
//    on their own schedule. When that's the case, the SAME key's history,
//    filtered down to just events at this new event's own hour-of-day, can
//    have a clear majority even though the unfiltered history doesn't.
//    Exact UTC-hour match, not a fuzzy window - deliberately simple and
//    auditable rather than a smoothed/weighted model. Subject to the same
//    minimum-sample-size bar as key-history (MIN_HISTORY_FOR_INFERENCE),
//    applied to the hour-filtered subset - a single matching-hour event is
//    not evidence, however "clean" a 1-for-1 majority looks.
//
// Both signals only ever fire for a key with a non-trivial amount of total
// tagged history to begin with (totalTagged >= MIN_HISTORY_FOR_INFERENCE) -
// a low-volume key gets "insufficient-history" rather than the time-of-day
// fallback grasping at whatever thin data exists.
//
// "Historical corrections as a feedback signal" - also named in the
// original product plan - already happens, for free, as a side effect of
// how correctTag works: a correction doesn't just log feedback, it writes
// the corrected team back into usage_events.team (see correctTag below), so
// the very next inferTag call for that key counts that corrected event as
// real key-history, same as if it had arrived pre-tagged. There's no
// separate "weight corrections higher" mechanism - a corrected tag and an
// originally-supplied tag are treated as equally trustworthy ground truth,
// which is the simplest defensible choice until there's evidence corrected
// tags need to be weighted differently.
//
// STILL NOT IMPLEMENTED: calling-service identity, prompt-template
// fingerprinting, and deployment identity as inference signals. All three
// need request metadata this service doesn't collect today (a declared
// calling-service identifier, or a content-fingerprinting pass over prompt
// text) - real future work, not something to fake with the data on hand.
// Being upfront about this rather than quietly only covering the
// implemented cases: a confidence score is only trustworthy if its basis is
// honestly documented, so `basis` is always returned alongside
// `confidence`, not just a bare number.
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
// Same statistical bar as MIN_HISTORY_FOR_INFERENCE, applied to the
// hour-filtered subset rather than the key's full history. Kept as its own
// named constant (even though it's currently equal) because it governs a
// conceptually different question - "is this hour's slice big enough to
// trust", not "is this key's total history big enough to trust" - and the
// two may reasonably diverge later.
const MIN_HISTORY_FOR_HOUR_INFERENCE = 3;

function majorityFrom(rows) {
  // rows: [{ team, n }] already grouped/counted, OR raw { team } rows - this
  // works for either since it just tallies. Returns the top team, its
  // fraction of the total, and the total, or null fields if rows is empty.
  const counts = new Map();
  let total = 0;
  for (const r of rows) {
    const n = r.n !== undefined ? Number(r.n) : 1;
    counts.set(r.team, (counts.get(r.team) || 0) + n);
    total += n;
  }
  if (total === 0) return { team: null, fraction: 0, total: 0 };
  const [topTeam, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { team: topTeam, fraction: topCount / total, total };
}

async function inferTag({ key_id, usage_event_id, db = defaultDb }) {
  // Full tagged history for this key, as raw rows (not pre-aggregated) -
  // needed so the time-of-day fallback can re-bucket the same data by hour
  // without a second, dialect-specific date-extraction query.
  const history = await db.all(
    `SELECT team, event_time FROM usage_events WHERE user_id = ? AND team IS NOT NULL`,
    [key_id]
  );

  const overall = majorityFrom(history);

  let inferredTeam = null;
  let confidence = 0;
  let basis = "insufficient-history";

  if (overall.total >= MIN_HISTORY_FOR_INFERENCE) {
    if (overall.fraction >= MIN_MAJORITY_FRACTION) {
      inferredTeam = overall.team;
      confidence = Math.round(overall.fraction * 1000) / 1000;
      basis = "key-history";
    } else {
      basis = "key-history-inconclusive";

      // Key-history alone doesn't have a clear majority - see if this
      // event's own hour-of-day does, within this same key's history.
      const event = await db.get("SELECT event_time FROM usage_events WHERE id = ?", [usage_event_id]);
      const eventHour = event?.event_time ? new Date(event.event_time).getUTCHours() : null;

      if (eventHour !== null && Number.isFinite(eventHour)) {
        const sameHour = history.filter((r) => new Date(r.event_time).getUTCHours() === eventHour);
        const hourly = majorityFrom(sameHour);
        if (hourly.total >= MIN_HISTORY_FOR_HOUR_INFERENCE && hourly.fraction >= MIN_MAJORITY_FRACTION) {
          inferredTeam = hourly.team;
          confidence = Math.round(hourly.fraction * 1000) / 1000;
          basis = "key-history-time-of-day";
        }
      }
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

module.exports = { inferTag, listInferences, correctTag, MIN_HISTORY_FOR_INFERENCE, MIN_MAJORITY_FRACTION, MIN_HISTORY_FOR_HOUR_INFERENCE };
