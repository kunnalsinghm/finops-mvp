// 0002 - api_keys.allow_background
//
// An admin-granted privilege: only keys with it may send
// X-Workload-Type: background (which is exempt from budget enforcement).
// See server/keyIdentity.js.
//
// Idempotent on purpose. Databases that ran the earlier ad-hoc upgrade already
// have the column; they must be recorded as migrated, not fail on a duplicate.

module.exports = {
  version: 2,
  name: "api_keys_allow_background",
  up: {
    sqlite(db) {
      if (!db.columnExists("api_keys", "allow_background")) {
        db.exec("ALTER TABLE api_keys ADD COLUMN allow_background INTEGER NOT NULL DEFAULT 0");
      }
    },
    async postgres(db) {
      await db.exec("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allow_background INTEGER NOT NULL DEFAULT 0");
    },
  },
};
