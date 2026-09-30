// 0012 - composite indexes on usage_events for every hot-path (per-request)
// query that filters on more than a single leading column:
//   - (team, event_time), (provider, model, event_time): anomaly.js's
//     per-team and per-model checks
//   - (user_id, provider, model), (user_id, client_region):
//     fraudDetection.js's "has this key ever used this model/region
//     before" existence checks
//
// Follow-up to 0011, found by the same P0 load test after fixing the bug
// that let migration 0011's index actually get exercised (see routes/proxy.js's
// req-out-of-scope fix). Once fraudDetection.js's per-key VOLUME queries
// were properly bounded by (user_id, event_time), these were the next
// costs found, each the same shape as 0011's problem - a query filtering
// on a column (or column pair) with no index covering all of its filter
// columns together, so the database had to fall back to a much broader
// index (or none) and scan-and-discard everything that didn't match the
// remaining conditions:
//
//   - checkDailySpendAnomaly (team's spend today + 14-day baseline) filters
//     on team, but the only existing index on that column is idx_usage_team
//     (team alone) - so it scanned that TEAM'S ENTIRE HISTORY every request,
//     not just the 14-day window the query actually needs.
//   - checkAnomaly (single-event cost spike vs. a 30-day per-model average)
//     filters on provider+model, and idx_usage_provider_model (no event_time)
//     has the same problem: it scans that MODEL'S ENTIRE HISTORY, not just
//     30 days of it.
//   - checkNewModelMix/checkNewRegion ("has this key ever called this
//     model/region before") filter on user_id+provider+model or
//     user_id+client_region, with no index covering either combination -
//     measured using idx_usage_provider_model_time and scanning that
//     MODEL'S ENTIRE ORG-WIDE HISTORY looking for a matching user_id
//     (6ms on a 20k-row table); a covering (user_id, provider, model)
//     index drops this to an index seek (0.003ms - ~2000x).
//
// All additive composite indexes - the existing idx_usage_team and
// idx_usage_provider_model(_time) indexes are left in place (still useful
// for reporting queries elsewhere that don't have a time bound, e.g.
// costs.js's /by-team) rather than replaced.
//
// Deliberately NOT the deeper fix (a maintained daily-rollup table, making
// these O(1) instead of O(rows in the window)) - see
// docs/load-test-results.md for why: a rollup table has to be kept in sync
// on every usage_events INSERT *and* DELETE (purgeUsageEvents), across two
// dialects and two schema modes, and that correctness surface didn't fit
// this pass. Time-bounded/covering composite indexes are a much smaller,
// well-understood change with the same shape and risk profile as 0011, and
// they cap each scan at a fixed window or an index seek instead of that
// team's/model's/key's entire history - which is the actual unbounded-
// growth problem the load test found. The one query left NOT fully solved
// by an index is checkVolumeSpike's 14-day baseline, which needs
// COUNT(DISTINCT date(event_time)) - genuinely requires evaluating that
// function per matching row, not just a range test - but it is already
// bounded to one key's 14-day window by 0011's index, which is the
// difference that matters (a key's own daily volume, not the whole
// table's).
//
// Idempotent, additive-only - same pattern as every migration before this.

module.exports = {
  version: 12,
  name: "usage_events_team_and_model_time_indexes",
  up: {
    sqlite(db) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_team_time ON usage_events(team, event_time)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_provider_model_time ON usage_events(provider, model, event_time)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_user_provider_model ON usage_events(user_id, provider, model)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_user_region ON usage_events(user_id, client_region)");
    },
    async postgres(db) {
      await db.exec("CREATE INDEX IF NOT EXISTS idx_usage_team_time ON usage_events(team, event_time)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_usage_provider_model_time ON usage_events(provider, model, event_time)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_usage_user_provider_model ON usage_events(user_id, provider, model)");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_usage_user_region ON usage_events(user_id, client_region)");
    },
  },
};
