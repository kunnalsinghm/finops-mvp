// 0009 - api_keys.allow_pii_bypass
//
// An admin-granted privilege: only keys with it may send
// X-Disable-PII-Redaction: true (on the proxy and on the ingest webhook) to
// skip PII redaction. Before this, any caller with proxy/ingest access could
// flip that header themselves. See server/keyIdentity.js's resolvePiiBypass,
// the same shape as allow_background (0002) for the same reason.
//
// Idempotent for the same reason 0002 is: safe to run again if a column
// already exists from an earlier ad-hoc upgrade.

module.exports = {
  version: 9,
  name: "api_keys_allow_pii_bypass",
  up: {
    sqlite(db) {
      if (!db.columnExists("api_keys", "allow_pii_bypass")) {
        db.exec("ALTER TABLE api_keys ADD COLUMN allow_pii_bypass INTEGER NOT NULL DEFAULT 0");
      }
    },
    async postgres(db) {
      await db.exec("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allow_pii_bypass INTEGER NOT NULL DEFAULT 0");
    },
  },
};
