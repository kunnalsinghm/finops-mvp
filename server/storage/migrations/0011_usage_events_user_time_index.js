// 0011 - index on usage_events(user_id, event_time)
//
// Found by the P0 load test. usage_events.user_id is the API key id, and
// every proxied request runs fraudDetection.js's checks (volume spike,
// new-model, new-region) plus smartTagging.js's inference - all of which
// filter on user_id. There was NO index on it, so each of those was a full
// table scan: measured 5 scans per request, throughput falling from ~190 to
// ~54 req/s as the table grew from 2k to 17k rows. (This only became visible
// once the fraud-check ReferenceError in routes/proxy.js was fixed - before
// that the check threw before running a single query.)
//
// (user_id, event_time) rather than user_id alone: the volume-spike check
// filters on user_id AND a time window, and the index still serves plain
// user_id = ? lookups through its leading column.
//
// Purely additive and idempotent (IF NOT EXISTS), same as 0004.

module.exports = {
  version: 11,
  name: "usage_events_user_time_index",
  up: {
    sqlite(db) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, event_time)");
    },
    async postgres(db) {
      await db.exec("CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, event_time)");
    },
  },
};
