// 0007 - api_keys.rotation_recommended, api_keys.rotation_reason
//
// A6: automated compromised-key response. Distinct from quarantine
// (status='quarantined', enforced immediately at the proxy/ingest gate -
// see governance.js) - rotation-recommended is a softer advisory: "this
// key's usage pattern looked suspicious enough to flag, but not severe
// enough to lock the key out." It's surfaced on the key itself (GET
// /api/keys) rather than only in alerts_log, so an admin reviewing a
// specific key sees the recommendation without having to cross-reference
// the alert log separately.
//
// rotation_recommended is a plain flag (0/1), not a timestamp, because
// nothing in this codebase needs to know exactly when it was set beyond
// what's already in alerts_log/audit_log - keeping it a flag matches the
// existing quarantine_reason column's own shape (a reason string sits
// alongside a status/flag, not as its own audit trail).
//
// Idempotent, additive-only - same pattern as every migration before this.

module.exports = {
  version: 7,
  name: "api_keys_rotation_recommended",
  up: {
    sqlite(db) {
      if (!db.columnExists("api_keys", "rotation_recommended")) {
        db.exec("ALTER TABLE api_keys ADD COLUMN rotation_recommended INTEGER NOT NULL DEFAULT 0");
      }
      if (!db.columnExists("api_keys", "rotation_reason")) {
        db.exec("ALTER TABLE api_keys ADD COLUMN rotation_reason TEXT");
      }
    },
    async postgres(db) {
      await db.exec("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotation_recommended INTEGER NOT NULL DEFAULT 0");
      await db.exec("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotation_reason TEXT");
    },
  },
};
